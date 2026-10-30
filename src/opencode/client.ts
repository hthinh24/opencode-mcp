export interface OpenCodeClientOptions {
  baseUrl?: string;
  apiPrefix?: "auto" | "none" | "/api";
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateSessionInput {
  title?: string;
  parentId?: string;
}

export interface SendMessageInput {
  sessionId: string;
  text: string;
  agent?: string;
  model?: string;
}

export class OpenCodeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly prefixMode: "auto" | "none" | "/api";
  private resolvedPrefix?: Promise<string>;

  constructor(options: OpenCodeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.prefixMode = options.apiPrefix ?? "auto";
  }

  async listAgents(): Promise<unknown> {
    return this.request("GET", "/agent");
  }

  async createSession(input: CreateSessionInput = {}): Promise<unknown> {
    const body: Record<string, string> = {};
    if (input.title) body.title = input.title;
    if (input.parentId) body.parentID = input.parentId;
    return this.request("POST", "/session", body);
  }

  async getSession(sessionId: string): Promise<unknown> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}`);
  }

  async listChildSessions(sessionId: string): Promise<unknown> {
    const encodedId = encodeURIComponent(sessionId);
    try {
      return await this.request("GET", `/session/${encodedId}/children`);
    } catch (error) {
      if (!(error instanceof OpenCodeApiError) || error.status !== 404) throw error;
      return this.request("GET", `/session?parentID=${encodeURIComponent(sessionId)}`);
    }
  }

  async getMessages(sessionId: string, limit?: number): Promise<unknown> {
    const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message${query}`);
  }

  async sendMessage(input: SendMessageInput): Promise<unknown> {
    const encodedId = encodeURIComponent(input.sessionId);
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: input.text }],
    };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = input.model;

    try {
      await this.request("POST", `/session/${encodedId}/prompt_async`, body);
      return { accepted: true, delivery: "async" };
    } catch (error) {
      if (!(error instanceof OpenCodeApiError) || error.status !== 404) throw error;
    }

    // Compatibility with older OpenCode servers used by existing installations.
    const legacyBody: Record<string, string> = { text: input.text };
    if (input.agent) legacyBody.agent = input.agent;
    if (input.model) legacyBody.model = input.model;
    const response = await this.request("POST", `/session/${encodedId}/prompt`, legacyBody);
    return { accepted: true, delivery: "legacy", response };
  }

  async abortSession(sessionId: string): Promise<unknown> {
    const encodedId = encodeURIComponent(sessionId);
    try {
      return await this.request("POST", `/session/${encodedId}/abort`);
    } catch (error) {
      if (!(error instanceof OpenCodeApiError) || error.status !== 404) throw error;
    }
    return this.request("POST", `/session/${encodedId}/interrupt?resume=false`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const prefix = await this.getApiPrefix();
    const url = `${this.baseUrl}${prefix}${path}`;
    const headers = this.createHeaders();
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach the OpenCode server at ${this.baseUrl}: ${detail}`);
    }

    const raw = response.status === 204 ? "" : await response.text();
    let payload: unknown = raw;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        payload = raw;
      }
    }

    if (!response.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      const message = response.status === 401 || response.status === 403
        ? "OpenCode authentication failed. Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD."
        : `OpenCode API request failed (${response.status} ${response.statusText}): ${detail}`;
      throw new OpenCodeApiError(message, response.status, method, path);
    }

    return payload;
  }

  private createHeaders(): Headers {
    const headers = new Headers({ accept: "application/json" });
    if (this.username !== undefined && this.password !== undefined) {
      const encoded = Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64");
      headers.set("authorization", `Basic ${encoded}`);
    }
    return headers;
  }

  private getApiPrefix(): Promise<string> {
    if (this.prefixMode === "none") return Promise.resolve("");
    if (this.prefixMode === "/api") return Promise.resolve("/api");
    if (!this.resolvedPrefix) this.resolvedPrefix = this.detectApiPrefix();
    return this.resolvedPrefix;
  }

  private async detectApiPrefix(): Promise<string> {
    // OpenCode V2 serves its API under /api. Check its JSON info endpoint
    // first: /global/health may fall through to the V2 web app and return HTML 200.
    if (await this.probeJson("/api/info")) return "/api";
    if (await this.probeJson("/global/health")) return "";

    // Let the actual request return the most useful route-specific error.
    return "";
  }

  private async probeJson(path: string): Promise<boolean> {
    const response = await this.probe(path);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return false;
    }
    try {
      await response.json();
      return true;
    } catch {
      return false;
    }
  }

  private async probe(path: string): Promise<Response> {
    const headers = this.createHeaders();
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach the OpenCode server at ${this.baseUrl}: ${detail}`);
    }
  }
}

export function createOpenCodeClientFromEnvironment(env: NodeJS.ProcessEnv = process.env): OpenCodeClient {
  const prefixValue = (env.OPENCODE_API_PREFIX ?? "auto").trim().toLowerCase();
  let apiPrefix: "auto" | "none" | "/api";
  if (prefixValue === "auto") apiPrefix = "auto";
  else if (prefixValue === "none" || prefixValue === "") apiPrefix = "none";
  else if (prefixValue === "/api") apiPrefix = "/api";
  else throw new Error("OPENCODE_API_PREFIX must be 'auto', 'none', or '/api'.");

  return new OpenCodeClient({
    baseUrl: env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
    apiPrefix,
    username: env.OPENCODE_SERVER_USERNAME ?? (env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD ? "opencode" : undefined),
    password: env.OPENCODE_SERVER_PASSWORD ?? env.OPENCODE_PASSWORD,
  });
}
