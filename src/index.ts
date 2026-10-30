#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createOpenCodeClientFromEnvironment } from "./opencode/client.js";
import { createMcpServer } from "./server.js";

const client = createOpenCodeClientFromEnvironment();

void serveStdio(() => createMcpServer(client));
console.error("opencode-mcp server running on stdio");
