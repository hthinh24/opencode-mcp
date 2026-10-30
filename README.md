# OpenCode MCP

An MCP server for managing OpenCode sessions from any MCP-compatible client.

## Requirements

- Node.js 20 or later.
- OpenCode installed and configured.
- An OpenCode HTTP server running locally.

## Setup

1. Clone this repository.
2. Run `npm install` and `npm run build`.
3. Start OpenCode from the project directory you want to work in: `opencode serve --hostname 127.0.0.1 --port 4096`.
4. Register `dist/index.js` as a local MCP server using your client's `stdio` configuration.

The MCP server connects to an existing OpenCode server. It does not start or stop the OpenCode process.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode server URL, without an API path suffix. |
| `OPENCODE_API_PREFIX` | `auto` | `auto`, `none`, or `/api`. |
| `OPENCODE_SERVER_USERNAME` | `opencode` when a password is set | HTTP Basic Auth username. |
| `OPENCODE_SERVER_PASSWORD` | Unset | HTTP Basic Auth password. `OPENCODE_PASSWORD` is also accepted. |

Set authentication credentials in the MCP client's environment when OpenCode Basic Auth is enabled. Keep credentials local and never commit them.

`OPENCODE_API_PREFIX=auto` detects the current API routes and the legacy `/api` route layout.

## Available tools

- `list_agents` — list project agents.
- `create_session` — create a session, optionally under a parent session.
- `send_message` — send a prompt, optionally selecting an agent or model. Returns when OpenCode accepts the prompt.
- `get_session` — read session details.
- `list_child_sessions` — list child sessions.
- `get_messages` — read message history, including tool calls and results.
- `abort_session` — interrupt a running session.

Use `get_messages` and `get_session` after sending a prompt to inspect progress and results.

## Development

Run `npm run build` to compile and `npm test` to run the test suite. Tests use a local mock HTTP server and do not require a running OpenCode instance.

## Security

Keep the OpenCode server bound to `127.0.0.1` unless remote access is intentionally configured and secured. Do not expose an unauthenticated server to an untrusted network.
