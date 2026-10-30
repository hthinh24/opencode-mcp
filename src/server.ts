import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenCodeClient } from "./opencode/client.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    return textResult(await operation());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}

export function createMcpServer(client: OpenCodeClient): McpServer {
  const server = new McpServer({ name: "opencode-mcp", version: "0.1.0" });

  server.registerTool(
    "list_agents",
    {
      description: "List the agents currently available in the connected OpenCode project.",
      inputSchema: z.object({}),
    },
    async () => runTool(() => client.listAgents()),
  );

  server.registerTool(
    "create_session",
    {
      description: "Create an OpenCode session. Use send_message to choose an agent and send its first prompt.",
      inputSchema: z.object({
        title: z.string().min(1).optional().describe("Optional session title."),
        parent_id: z.string().min(1).optional().describe("Optional parent session ID for a child session."),
      }),
    },
    async ({ title, parent_id }) => runTool(() => client.createSession({ title, parentId: parent_id })),
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a prompt to an OpenCode session. The call returns after OpenCode accepts the prompt; use get_messages to inspect the response and tool activity.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        text: z.string().min(1),
        agent: z.string().min(1).optional().describe("Optional OpenCode agent ID."),
        model: z.string().min(1).optional().describe("Optional model in provider/model format."),
      }),
    },
    async ({ session_id, text, agent, model }) => runTool(() => client.sendMessage({ sessionId: session_id, text, agent, model })),
  );

  server.registerTool(
    "get_session",
    {
      description: "Get the details and current state of an OpenCode session.",
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    async ({ session_id }) => runTool(() => client.getSession(session_id)),
  );

  server.registerTool(
    "list_child_sessions",
    {
      description: "List the child sessions created from an OpenCode parent session.",
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    async ({ session_id }) => runTool(() => client.listChildSessions(session_id)),
  );

  server.registerTool(
    "get_messages",
    {
      description: "Read the message history of an OpenCode session, including assistant tool calls and results.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    },
    async ({ session_id, limit }) => runTool(() => client.getMessages(session_id, limit)),
  );

  server.registerTool(
    "abort_session",
    {
      description: "Interrupt a running OpenCode session.",
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    async ({ session_id }) => runTool(() => client.abortSession(session_id)),
  );

  return server;
}
