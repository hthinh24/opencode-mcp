#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OpenCodeProcessManager } from "./opencode/process-manager.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const processManager = new OpenCodeProcessManager();

  // Keep a synchronous fallback for abnormal process termination.
  process.once("exit", () => processManager.killNow());

  const client = await processManager.start();
  const stdioHandle = serveStdio(() => createMcpServer(client));
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      try {
        await stdioHandle.close();
      } finally {
        await processManager.stop();
        process.stdin.destroy();
      }
    })();

    return shutdownPromise;
  };

  const onInputClosed = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error("Failed to stop the managed OpenCode server:", error);
      process.exitCode = 1;
    });
  };

  process.stdin.once("end", onInputClosed);
  process.stdin.once("close", onInputClosed);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().catch((error: unknown) => {
        console.error("Failed to shut down opencode-mcp:", error);
        process.exitCode = 1;
      });
    });
  }

  console.error("opencode-mcp started a managed OpenCode server and is ready on stdio");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[opencode-mcp] " + message);
  process.exitCode = 1;
});
