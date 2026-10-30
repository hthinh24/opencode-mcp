import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { OpenCodeClient } from "./client.js";

export interface OpenCodeProcessManagerDependencies {
  spawnProcess?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  allocatePort?: () => Promise<number>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 1_500;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const LOOPBACK_HOST = "127.0.0.1";

export class OpenCodeProcessManager {
  private readonly spawnProcess: typeof nodeSpawn;
  private readonly fetchImpl: typeof fetch;
  private readonly allocatePort: () => Promise<number>;
  private child?: ChildProcess;
  private childExited = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    dependencies: OpenCodeProcessManagerDependencies = {},
  ) {
    this.spawnProcess = dependencies.spawnProcess ?? nodeSpawn;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.allocatePort = dependencies.allocatePort ?? findAvailablePort;
  }

  async start(): Promise<OpenCodeClient> {
    if (this.child && !this.childExited) {
      throw new Error("The managed OpenCode server is already running.");
    }

    const workingDirectory = resolve(
      this.env.OPENCODE_WORKING_DIRECTORY?.trim() || process.cwd(),
    );
    const directoryInfo = await stat(workingDirectory).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("OpenCode working directory does not exist: " + workingDirectory + " (" + detail + ")");
    });
    if (!directoryInfo.isDirectory()) {
      throw new Error("OpenCode working directory is not a directory: " + workingDirectory);
    }

    const port = this.env.OPENCODE_PORT
      ? parsePort(this.env.OPENCODE_PORT)
      : await this.allocatePort();
    const startupTimeoutMs = parseStartupTimeout(this.env.OPENCODE_STARTUP_TIMEOUT_MS);
    const apiPrefix = parseApiPrefix(this.env.OPENCODE_API_PREFIX);
    const executable = this.env.OPENCODE_EXECUTABLE?.trim() || "opencode";
    const password = randomBytes(32).toString("base64url");
    const baseUrl = "http://" + LOOPBACK_HOST + ":" + port;

    const childEnvironment: NodeJS.ProcessEnv = {
      ...this.env,
      OPENCODE_PASSWORD: password,
      // OpenCode V1 used this name; keeping it set is harmless for V2.
      OPENCODE_SERVER_PASSWORD: password,
    };

    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        executable,
        ["serve", "--hostname", LOOPBACK_HOST, "--port", String(port)],
        {
          cwd: workingDirectory,
          env: childEnvironment,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          // Windows installations may expose the CLI through a .cmd shim.
          shell: process.platform === "win32",
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("Failed to start OpenCode executable '" + executable + "': " + detail);
    }

    this.child = child;
    this.childExited = false;
    let spawnError: Error | undefined;
    let exitDetails: string | undefined;
    let stderrOutput = "";

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrOutput = (stderrOutput + String(chunk)).slice(-8_000);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      this.childExited = true;
      exitDetails = "code=" + String(code) + ", signal=" + String(signal);
    });

    try {
      await this.waitUntilReady(child, baseUrl, password, startupTimeoutMs, () => ({
        spawnError,
        exitDetails,
        stderrOutput,
      }));
    } catch (error) {
      await this.stop();
      throw error;
    }

    return new OpenCodeClient({
      baseUrl,
      username: "opencode",
      password,
      apiPrefix,
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.childExited) {
      this.child = undefined;
      return;
    }

    if (process.platform === "win32" && child.pid) {
      await killWindowsProcessTree(child.pid).catch(() => {
        child.kill();
      });
    } else {
      child.kill("SIGTERM");
    }

    if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
      if (process.platform === "win32" && child.pid) {
        await killWindowsProcessTree(child.pid).catch(() => child.kill("SIGKILL"));
      } else {
        child.kill("SIGKILL");
      }
      await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
    }

    this.child = undefined;
  }

  /** Synchronous best-effort fallback for process exit. */
  killNow(): void {
    const child = this.child;
    if (!child || this.childExited) return;

    if (process.platform === "win32" && child.pid) {
      const killer = nodeSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => child.kill());
      killer.unref();
    } else {
      child.kill();
    }
  }

  private async waitUntilReady(
    child: ChildProcess,
    baseUrl: string,
    password: string,
    timeoutMs: number,
    getChildState: () => { spawnError?: Error; exitDetails?: string; stderrOutput: string },
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const authorization = "Basic " + Buffer.from("opencode:" + password, "utf8").toString("base64");
    let lastFailure = "OpenCode health endpoints have not responded successfully.";

    while (Date.now() < deadline) {
      const state = getChildState();
      if (state.spawnError) {
        throw new Error("Failed to launch OpenCode: " + state.spawnError.message);
      }
      if (this.childExited || child.exitCode !== null || child.signalCode !== null || state.exitDetails) {
        const details = state.exitDetails ?? "code=" + String(child.exitCode);
        const diagnostics = redact(state.stderrOutput, password);
        throw new Error(
          "OpenCode exited before becoming ready (" + details + ")." +
          (diagnostics ? " OpenCode output: " + diagnostics : ""),
        );
      }

      try {
        // OpenCode V2's /global/health can return the frontend HTML with 200.
        // Require a JSON API response and prefer the canonical V2 /api/info route.
        if (await this.probeJson(baseUrl + "/api/info", authorization)) return;
        if (await this.probeJson(baseUrl + "/global/health", authorization)) return;
        lastFailure = "The server is running but neither /api/info nor /global/health returned a valid JSON API response.";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("authentication failed")) throw error;
        lastFailure = message;
      }

      await delay(STARTUP_POLL_INTERVAL_MS);
    }

    const diagnostics = redact(getChildState().stderrOutput, password);
    throw new Error(
      "OpenCode did not become ready within " + timeoutMs + " ms. " + lastFailure +
      " Check that OpenCode is installed and the configured working directory is valid." +
      (diagnostics ? " OpenCode output: " + diagnostics : ""),
    );
  }

  private async probeJson(url: string, authorization: string): Promise<boolean> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenCode authentication failed while starting the managed server.");
    }
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
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not determine an available local TCP port.");
  }

  const port = address.port;
  await closeServer(server);
  return port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolveKill, rejectKill) => {
    const killer = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", rejectKill);
    killer.once("exit", (code) => {
      if (code === 0) resolveKill();
      else rejectKill(new Error("taskkill exited with code " + String(code)));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    timeout.unref();
    child.once("exit", onExit);
  });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENCODE_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseStartupTimeout(value?: string): number {
  if (!value) return DEFAULT_STARTUP_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error("OPENCODE_STARTUP_TIMEOUT_MS must be an integer between 1000 and 120000.");
  }
  return timeout;
}

function parseApiPrefix(value?: string): "auto" | "none" | "/api" {
  const normalized = value?.trim().toLowerCase() || "auto";
  if (normalized === "auto") return "auto";
  if (normalized === "none") return "none";
  if (normalized === "/api") return "/api";
  throw new Error("OPENCODE_API_PREFIX must be 'auto', 'none', or '/api'.");
}

function redact(output: string, secret: string): string {
  return output.replaceAll(secret, "[REDACTED]").trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
