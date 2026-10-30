# OpenCode MCP

An MCP server that lets MCP-compatible AI clients manage sessions in OpenCode.

## Features

- List agents available in the selected OpenCode project.
- Create sessions and child sessions.
- Send prompts to a session, optionally selecting an agent or model.
- Read session details, child sessions, and message history.
- Interrupt a running session.
- Start and stop an isolated OpenCode server process automatically.
- Use a fresh, randomly generated server password for every MCP process.
- Connect through the standard MCP `stdio` transport.
- Detect current OpenCode API routes and the legacy `/api` route layout.

This project does not provide an orchestration workflow or a preset agent/persona collection. Agent selection and orchestration remain the responsibility of the MCP client and the OpenCode project configuration.

## Requirements

- Node.js 20 or later.
- OpenCode installed and available on `PATH`.
- An MCP-compatible client that supports local `stdio` servers.

## Install and build

```bash
git clone https://github.com/hthinh24/opencode-mcp.git
cd opencode-mcp
npm install
npm run build
```

## Configure an MCP client

Register the compiled `dist/index.js` entry point as a local MCP server using the client's `stdio` configuration. Set `OPENCODE_WORKING_DIRECTORY` to the project directory OpenCode should work in.

Example Codex configuration in `%USERPROFILE%\\.codex\\config.toml`:

```toml
[mcp_servers.opencode-session]
command = "node"
args = ["D:/tools/opencode-mcp/dist/index.js"]
env = { OPENCODE_WORKING_DIRECTORY = "D:/projects/your-project" }
startup_timeout_sec = 45
tool_timeout_sec = 60
```

Replace both paths with locations on your machine. Restart Codex after changing its MCP configuration.

Other MCP clients can use the same executable and environment variable in their own `stdio` configuration format.

## Runtime behavior

When an MCP client starts this server, it:

1. Generates a cryptographically random 256-bit password.
2. Selects an available local TCP port (or uses `OPENCODE_PORT` when explicitly configured).
3. Starts `opencode serve` in `OPENCODE_WORKING_DIRECTORY`, bound to `127.0.0.1`.
4. Passes the generated password to the OpenCode child process through its environment and keeps the credential in memory for API requests.
5. Stops the child process when the MCP process shuts down.

The password is not written to the MCP configuration or a file. A new password is generated each time the MCP server starts. OpenCode V2 uses `OPENCODE_PASSWORD`; `OPENCODE_SERVER_PASSWORD` is also set for compatibility with older versions. The HTTP Basic Auth username is `opencode`.

The MCP server manages only the OpenCode process it starts. It does not attach to, terminate, or reconfigure an independently running OpenCode server.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_WORKING_DIRECTORY` | MCP process working directory | Project directory passed as the OpenCode process working directory. Set this explicitly in your MCP client configuration. |
| `OPENCODE_EXECUTABLE` | `opencode` | OpenCode executable or absolute executable path. |
| `OPENCODE_PORT` | Automatically selected | Optional fixed local port. Leave unset to avoid collisions between MCP instances. |
| `OPENCODE_STARTUP_TIMEOUT_MS` | `30000` | Maximum time to wait for the OpenCode server to become ready (1000–120000). |
| `OPENCODE_API_PREFIX` | `auto` | API route layout: `auto`, `none`, or `/api . |

The server always binds OpenCode to `127.0.0.1`. It does not load `.env` files; configure variables in the MCP client's process environment.

## Available tools

| Tool | Description |
| --- | --- |
| `list_agents` | List agents available in the connected OpenCode project. |
| `create_session` | Create a session, optionally under a parent session. |
| `send_message` | Send a prompt, optionally selecting an agent or model. Returns when OpenCode accepts the prompt. |
| `get_session` | Get session details. |
| `list_child_sessions` | List child sessions for a parent session. |
| `get_messages` | Read message history, including assistant tool calls and results. |
| `abort_session` | Interrupt a running session. |

After sending a prompt, use `get_messages` and `get_session` to inspect progress and results. Use `list_child_sessions` to inspect delegated work.

## Development

```bash
npm run build
npm test
```

The test suite uses Node.js's built-in test runner and mock process/HTTP dependencies. It does not require a running OpenCode instance.

## Troubleshooting

### OpenCode does not start

- Confirm that `opencode` is installed and available on `PATH`.
- Set `OPENCODE_EXECUTABLE` to the executable path when it is not discoverable through `PATH`.
- Confirm that `OPENCODE_WORKING_DIRECTORY` exists and is a directory.
- Increase `OPENCODE_STARTUP_TIMEOUT_MS` if OpenCode needs more time to initialize.

### The MCP server cannot initialize

- Check the MCP client's server logs for the startup error written to stderr.
- Confirm that the configured Node.js executable and `dist/index.js` path are valid.
- Leave `OPENCODE_PORT` unset unless a fixed port is required; another process may already be using a manually selected port.

### API route not found

- Keep `OPENCODE_API_PREFIX=auto` for automatic detection.
- Set it to `none` for servers without an API prefix or `/api` for older servers that expose their API under `/api`.

## Security

The managed OpenCode server listens on loopback only and uses a new random password for each MCP process. Keep this MCP server local to trusted MCP clients. Do not expose the OpenCode server to an untrusted network.
