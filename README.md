# AgentBridge

A general-purpose local agent runtime that connects AI agents installed on your machine — Claude and Codex today — to any external program, and gives those agents user-defined tools through MCP.

AgentBridge ships no chat UI. Other programs consume it as a library or as a local runtime.

See the [Product & Functional Specification](docs/AgentBridge-Product-Spec.md) for the full design.

## Status

Early Phase 1 (MVP) implementation.

| Package | Contents | Status |
| --- | --- | --- |
| `@jeonhui/agentbridge-core` | Error codes, event bus, session state machine, SessionManager, AgentBridge entry point | Implemented |
| `@jeonhui/agentbridge-provider-core` | Provider contract, ProviderManager, CLI detection, process and stream plumbing | Implemented |
| `@jeonhui/agentbridge-provider-claude` | Claude Code adapter: turn execution, stream parsing, resume, MCP config injection | Implemented |
| `@jeonhui/agentbridge-provider-codex` | Codex CLI adapter: turn execution, event mapping, sandbox authorization | Implemented, unverified live (see below) |
| `@jeonhui/agentbridge-mcp-client` | MCP client over stdio, SSE, and streamable HTTP | Implemented |
| `@jeonhui/agentbridge-mcp-registry` | Tool Registry with permission inference and reload diffing | Implemented |
| `@jeonhui/agentbridge-mcp-manager` | Registration, connection, hot reload, tool invocation | Implemented |
| `@jeonhui/agentbridge-mcp-server` | AgentBridge exposed as an MCP server | Implemented |
| `@jeonhui/agentbridge-permission` | Policy evaluation, approval queue, audit hook | Implemented |
| `@jeonhui/agentbridge-runtime` | Local REST and WebSocket runtime, all 28 documented routes | Implemented |
| `@jeonhui/agentbridge-sdk` | One client over the embedded and HTTP backends | Implemented |
| `@jeonhui/agentbridge-cli` | `agentbridge serve` daemon with all three adapters registered | Implemented |

## Requirements

- Node.js 20 LTS or newer (22 LTS recommended)
- pnpm 9 or newer

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Listing local agents

`pnpm agents` reports which agent CLIs are installed on this machine. Add `--json` for machine-readable output.

```text
ID      NAME         STATUS     VERSION  PATH / REASON
claude  Claude Code  installed  2.1.220  /Users/you/.local/share/mise/installs/node/24.4.1/bin/claude
codex   Codex CLI    installed  0.132.0  /opt/homebrew/bin/codex
```

Detection resolves the binary against `PATH` plus the common install directories, then reads its version. It never throws: a missing or broken CLI is reported as `available: false` with a reason.

Only CLIs AgentBridge can actually drive are listed, so a detected entry never fails at session
creation. Claude sessions work end to end; Codex is covered under provider status below.

Deleting `dist/` by hand leaves `tsconfig.tsbuildinfo` behind, and `tsc -b` will then consider the build up to date and emit nothing — tests will report zero passing. Use `pnpm clean` or `tsc -b --force` instead.

## Talking to Claude

```typescript
import { AgentBridge } from "@jeonhui/agentbridge-core";
import { ClaudeProvider } from "@jeonhui/agentbridge-provider-claude";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

const session = await agent.sessions.create({ provider: "claude", model: "sonnet" });
session.on("message", (e) => process.stdout.write(e.content));
session.on("tool_call", (e) => console.log("[tool]", e.tool));

await session.send("Analyze the project structure");
await agent.stop();
```

`pnpm scenario:a` runs acceptance scenario A from the spec against the real CLI: two turns, checking event
ordering, turn ids, status transitions, and that the second turn remembers the first through `--resume`.

```text
  seq= 2 status running
  seq= 3 message "ok"
  seq= 4 status ready
  seq= 5 status running
  seq= 6 message "ok"
  seq= 7 status ready

scenario A PASSED in 7901ms
```

The adapter runs one CLI process per turn in `--print --output-format stream-json` mode and keeps
continuity through the CLI's own session id. Its line mapping was built against captured output from
claude 2.1.220 rather than assumed, and unknown line types are ignored so new CLI telemetry does not
break the parser.

## Giving an agent your own tools

Register an MCP server, bind it to a session, and the agent can use it:

```typescript
import { McpManager } from "@jeonhui/agentbridge-mcp-manager";

const mcp = new McpManager();
agent.attachMcp(mcp);

await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: "node",
  args: ["./filesystem-mcp.js", "/workspace"],
  watch: { enabled: true },
});

const session = await agent.sessions.create({
  provider: "claude",
  workingDirectory: "/workspace",
  mcp: ["filesystem"],
  permissionMode: "allow",
});
```

`permissionMode` matters here. Agent CLIs run their own approval prompt, and in non-interactive mode
that prompt has nobody to ask, so it denies. Under `allow`, AgentBridge pre-authorizes the bound
servers so the agent can actually call them; under `ask` the CLI's prompt applies and MCP tool calls
fail until an adapter implements the permission hook. See spec 25.4.

`pnpm scenario:b` proves the whole path against the real CLI and a real MCP server:

```text
  seq= 3 tool_call ToolSearch {"query":"select:mcp__filesystem__write_file"}
  seq= 5 tool_call mcp__filesystem__write_file {"path":"README.md","content":"# scenario b\n"}
  seq= 6 tool_result
  seq= 7 message "done"

file content: "# scenario b\n"
scenario B PASSED in 6933ms
```

`pnpm mcp:check` exercises the MCP layer on its own: discovery, permission inference from
annotations, tool invocation, path-escape rejection, and hot reload (registry diff in 166ms against
the spec's 3s target).

## Integrating from a host application

A host attaches the pieces it needs and renders its own approval UI:

```typescript
const agent = new AgentBridge({ defaultPermissionMode: "ask" });
agent.registerProvider(new ClaudeProvider());
agent.attachMcp(mcp);
agent.attachPermissions(permissions);
await agent.start();

// The host decides. AgentBridge only asks.
agent.on("permission_request", (event) => {
  showDialog(event.tool, event.permissions, {
    onAllow: () => agent.permissions.approve(event.requestId, { remember: "session" }),
    onDeny: () => agent.permissions.deny(event.requestId),
  });
});

const result = await agent.tools.call("mcp:filesystem:write_file", { path: "a.txt", content: "hi" });
if (!result.ok) console.error(result.error);   // AB-4001 when policy denied it
```

A denied call resolves with `ok: false` rather than throwing, so a host rendering a list of tools
does not need a try/catch around every invocation. `pnpm integration:check` exercises this surface
on its own, without an agent CLI: approve, deny by policy, and confirm the file did not change.

## Using it from another language

`agentbridge serve` starts the daemon with every adapter registered, prints its address and token,
and writes them to `~/.agentbridge/runtime.json` with owner-only permissions:

```bash
node apps/runtime/dist/cli.js serve          # or `agentbridge serve` once installed
node apps/runtime/dist/cli.js agents         # what is installed on this machine
```

`pnpm serve` runs a smaller version from the repo and prints the same shape:

```json
{"host":"127.0.0.1","port":60069,"token":"ab_local_51e6b5c9..."}
```

`scripts/python-client-check.py` drives a real Claude session from Python using only the standard
library — no SDK, no Node — over REST plus a hand-rolled WebSocket handshake:

```text
  PASS  GET /providers finds claude  (version 2.1.220)
  PASS  GET /tools lists the MCP tools  (['read_file', 'write_file'])
  PASS  WebSocket upgrade accepted  (HTTP/1.1 101 Switching Protocols)
  PASS  streamed a message event over WebSocket  (message)
  PASS  the response arrived  ('ok')
```

The runtime binds to `127.0.0.1` only, generates a fresh token per start, and compares tokens in
constant time so a caller cannot learn one character at a time by timing rejections.

## One client, two transports

`@jeonhui/agentbridge-sdk` exposes the same interface whether it runs in-process or against the runtime, so
moving a feature between them is a configuration change:

```typescript
const client = createClient({ transport: "embedded", agent });
// or
const client = createClient({ transport: "http", baseUrl, token, webSocket: (u) => new WebSocket(u) });

await client.connect();
const session = await client.sessions.create({ provider: "claude" });
session.on("message", (e) => render(e.content));
await session.send("hello");
```

Spec 10.8 makes identical signatures an invariant; the parity suite runs one set of assertions
against both backends, so a drift between them fails the build rather than surprising an integrator.

## Letting an agent drive AgentBridge

`@jeonhui/agentbridge-mcp-server` is the other direction: an external agent connects and uses AgentBridge as
a set of tools — listing providers, creating sessions, calling registered tools under policy.

```typescript
await new AgentBridgeMcpServer({ agent }).serveStdio();
```

`pnpm scenario:e` closes the loop against the real CLI: AgentBridge drives Claude, and Claude calls
back into AgentBridge through its MCP server.

```text
  seq= 5 tool_call mcp__agentbridge__agentbridge_providers_list
  seq= 6 tool_result
  seq= 7 message "Only one CLI found: Claude Code (id `claude`), avail=true..."

scenario E PASSED in 8546ms
```

Call depth is tracked and capped at 2 by default, so a session AgentBridge created cannot recurse
back into itself indefinitely.

## Examples

| Example | What it shows | Needs |
| --- | --- | --- |
| `examples/basic` | Connect to a local agent and stream its reply | Claude CLI |
| `examples/mcp` | Give an agent your own tools and watch the tool calls | Claude CLI |
| `examples/tools` | Call tools directly while the host answers the approval prompt | nothing |
| `examples/runtime-python` | Drive a session from Python over REST and WebSocket | Claude CLI |

`examples/tools` runs without any agent installed, because the tool and permission surface is what a
UI binds to and it should be explorable on its own.

## Provider status

Claude is verified end to end. The other two are honest about what has and has not been confirmed.

### Codex

The adapter is implemented against event names read out of the codex 0.132.0 binary and
confirmed against live output (`thread.started`, `turn.started/completed/failed`,
`item.started/updated/completed`). It spawns the CLI, parses the real stream, captures the thread id
for resume, and unwraps Codex's nested error JSON into a readable message.

It has not completed a turn on this machine: every model is rejected with "not supported when using
Codex with a ChatGPT account", and the CLI cannot refresh its model catalog. That is an account and
CLI-version problem rather than an adapter defect — `pnpm scenario:codex` shows the adapter handling
the failure correctly and surfacing the upstream reason. Run `codex update` and retry to verify it
end to end.

### Gemini — not supported

Google retired the "Gemini Code Assist for individuals" sign-in the CLI used, and sign-in now
redirects to Antigravity, which ships a GUI IDE rather than a headless CLI. There is nothing for an
adapter to drive on an individual account, so the adapter was removed rather than shipped
unverified.

The CLI binary itself still runs with a `GEMINI_API_KEY`, so this is a reachable gap rather than a
dead end. It comes back when a turn can be completed end to end. `listAgents()` deliberately does
not report Gemini in the meantime: listing a CLI implies AgentBridge can drive it, and a truthful
"not supported" beats a detected entry that fails at session creation.

## Persistence and logging

The default storage backend is in-memory, which is right for a library embedded in an application:
the app owns its own lifecycle. A daemon outlives the processes talking to it, so
`agentbridge serve` uses the file backend instead.

```typescript
const agent = new AgentBridge({ storage: new FileStorage({ dataDir: "~/.agentbridge" }) });
```

Sessions, MCP registrations, and permission rules survive a restart. A restored session comes back
`stopped`, because its agent process is gone — what survives is the metadata and the provider's own
session id, so `sessions.resume()` picks the conversation up where it left off.

```text
run 1   POST /sessions  ->  bfa73af0-...  (daemon killed)
run 2   GET  /sessions  ->  bfa73af0-...  status "stopped", title "survives restart"
```

Every field logged passes through redaction, so a caller cannot leak a secret by logging an object
that happens to carry one. Message bodies reduce to a length and a digest; tool arguments to key
names and a digest.

```json
{"level":"info","event":"mcp.connected","serverId":"filesystem","transport":"stdio","toolCount":2}
{"level":"info","event":"session.created","sessionId":"37a70a81-...","provider":"claude"}
{"level":"info","event":"mcp.reloaded","serverId":"filesystem","added":0,"durationMs":122}
```

## Secrets

An MCP server or a session can reference a secret instead of carrying it:

```jsonc
{ "id": "github", "transport": "stdio", "command": "gh-mcp",
  "env": { "GITHUB_TOKEN": "secret://github/token" } }
```

The reference is what gets stored and what the API returns; only the child process ever sees the
real value.

```text
API response       "GITHUB_TOKEN": "***"
state on disk      "GITHUB_TOKEN": "secret://github/token"
process env        the actual token
```

`agentbridge serve` resolves against the OS credential store first (macOS Keychain, Linux
`secret-tool`, Windows Credential Manager) and the environment second, which is usually what CI has.
Hosts can supply their own `SecretResolver`.

An unresolved reference is an error, not a passthrough. Handing the literal `secret://...` to a
child process looks like a real value and resurfaces later as a confusing authentication failure
somewhere else entirely, so registration fails with `AB-6004` instead.

## Layout

```text
packages/
├── core/              # events, session model, SessionManager, AgentBridge, errors, config
├── provider/
│   ├── core/          # provider contract, manager, detection, process and stream plumbing
│   ├── claude/        # Claude Code adapter
│   └── codex/         # Codex CLI adapter
├── mcp/
│   ├── client/        # MCP client and transports
│   ├── registry/      # Tool Registry and permission inference
│   ├── manager/       # registration, connection, hot reload
│   └── server/        # AgentBridge exposed as an MCP server
├── permission/        # policy evaluation and approval queue
├── runtime/           # local REST and WebSocket server
└── sdk/               # one client over both transports
scripts/
├── list-agents.mjs         # pnpm agents
├── scenario-a.mjs          # pnpm scenario:a
├── scenario-b.mjs          # pnpm scenario:b
├── mcp-check.mjs           # pnpm mcp:check
├── scenario-e.mjs          # pnpm scenario:e
├── scenario-codex.mjs      # pnpm scenario:codex
├── integration-check.mjs   # pnpm integration:check
├── runtime-serve.mjs       # pnpm serve
└── python-client-check.py  # drives the runtime from Python
docs/
└── AgentBridge-Product-Spec.md
```

## Design principles

- **Headless** — no UI. Every state change is emitted as an event.
- **Provider-agnostic** — the core only knows the `AgentProvider` interface; CLI specifics stay in adapters.
- **MCP-first** — integrations are added as MCP servers rather than accreting into the core.
- **Local-first** — works without network access; sessions, config, and logs stay on the machine.

## License

MIT
