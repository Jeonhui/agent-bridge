# AgentBridge

**Use the AI agents already installed on your machine — Claude Code, Codex — or any model API, from your own program.**

You write an app. AgentBridge runs the agent CLI for you, streams its replies back as events, lets
you hand the agent your own tools, and asks *you* before the agent touches anything.

```text
        your app  (any language)
            │
      ┌─────▼─────────────────────────────┐
      │           AgentBridge             │
      │  sessions · events · permissions  │
      └──┬────────────────────────┬───────┘
         │ runs                   │ provides tools (MCP)
   ┌─────▼─────┐            ┌─────▼──────────────┐
   │ claude /  │            │ your filesystem,   │
   │ codex CLI │◀──uses────│ your DB, your API…  │
   └───────────┘            └────────────────────┘
```

No chat UI is included — that is the point. You build the UI; AgentBridge does the plumbing.

[![npm](https://img.shields.io/npm/v/@jeonhui/agentbridge)](https://www.npmjs.com/package/@jeonhui/agentbridge)
[![license](https://img.shields.io/npm/l/@jeonhui/agentbridge)](LICENSE)

## What you can build with it

- **An editor or desktop app with an AI panel** — stream agent replies into your own UI, and show an
  approval dialog before the agent writes a file.
- **A tool the agent can use** — expose your app's features over MCP; the agent calls them like any
  other tool, under your permission rules.
- **A Python / Swift / anything integration** — run AgentBridge as a small local daemon and talk
  REST + WebSocket. No Node required in your app.
- **Automation that survives restarts** — sessions, tool registrations, and permission rules persist,
  and a conversation can resume where it left off.

## Install

```bash
pnpm add @jeonhui/agentbridge        # or npm / yarn
```

One package. Import only the part you need:

| Import | What it gives you |
| --- | --- |
| `@jeonhui/agentbridge` | Sessions, events, errors, storage, logging, secrets |
| `@jeonhui/agentbridge/claude` | The Claude Code adapter |
| `@jeonhui/agentbridge/codex` | The Codex CLI adapter |
| `@jeonhui/agentbridge/api` | API providers: OpenAI-compatible endpoints, LiteLLM, Gemini API |
| `@jeonhui/agentbridge/mcp` | Register MCP servers and give agents your tools |
| `@jeonhui/agentbridge/permission` | Decide which tool calls may run; show an approval UI |
| `@jeonhui/agentbridge/runtime` | Expose everything over local REST + WebSocket |
| `@jeonhui/agentbridge/sdk` | Write host code once, switch transports by configuration |
| `@jeonhui/agentbridge/mcp-server` | Let an external agent drive AgentBridge |
| `@jeonhui/agentbridge/provider` | The adapter contract, for writing your own |

Or skip the library and just run the daemon:

```bash
npx @jeonhui/agentbridge-cli agents    # which agent CLIs are installed here?
npx @jeonhui/agentbridge-cli serve     # start the local runtime, prints URL + token
```

## Quickstart — first reply in a minute

Requires the `claude` CLI installed and logged in.

```typescript
import { AgentBridge } from "@jeonhui/agentbridge";
import { ClaudeProvider } from "@jeonhui/agentbridge/claude";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

const session = await agent.sessions.create({ provider: "claude" });
session.on("message", (event) => process.stdout.write(event.content));

await session.send("Summarise this project in one sentence.");
await agent.stop();
```

Every reply, tool call, and status change arrives as an event (`message`, `tool_call`,
`tool_result`, `status`, `permission_request`, …), each with a per-session sequence number, so your
UI can render exactly what the agent is doing — and recover the gap after a dropped connection.

---

## Recipes

### Give the agent your own tools

Anything you can wrap in an [MCP server](https://modelcontextprotocol.io) becomes a tool the agent
can call — your filesystem, your database, your internal API:

```typescript
import { McpManager } from "@jeonhui/agentbridge/mcp";

const mcp = new McpManager();
agent.attachMcp(mcp);

await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: "node",
  args: ["./filesystem-mcp.js", "/workspace"],
  watch: { enabled: true },   // edit the server file → tools refresh, session keeps running
});

const session = await agent.sessions.create({
  provider: "claude",
  mcp: ["filesystem"],        // each session picks its own tool set
  permissionMode: "allow",
});
```

`watch: true` is the development loop: save your MCP server file and the agent sees the new tools
in about 150 ms, without restarting the session.

### Ask the user before the agent acts

Under `permissionMode: "ask"`, the agent stops before **its own** tool calls and waits for your
answer:

```typescript
import { PermissionManager } from "@jeonhui/agentbridge/permission";

const permissions = new PermissionManager({ promptHook: { enabled: true } });
agent.attachPermissions(permissions);

agent.on("permission_request", (event) => {
  // The agent wants to run event.tool. Your dialog decides.
  showDialog(event.tool, event.permissions, {
    onAllow: () => agent.permissions.approve(event.requestId, { remember: "session" }),
    onDeny: () => agent.permissions.deny(event.requestId),
  });
});
```

Proven against the real CLI (`pnpm scenario:ask`):

```text
mode=approve  the host was asked once   → file written
mode=deny     the host was asked once   → file unchanged
mode=auto     autoApprove(true), no ask → file written
```

Rules can also decide without asking — glob-match on tool, path, session, or permission class:

```typescript
permissions.setRule({
  id: "workspace-writes-ok",
  match: { toolPattern: "mcp:filesystem:*", pathScope: "/workspace/**" },
  effect: "allow",
  priority: 10,
  createdAt: new Date().toISOString(),
});
```

Everything is deny-by-default: no answer within the timeout means no.

### Use it from Python (or any language)

Start the daemon, then talk plain REST + WebSocket:

```bash
npx @jeonhui/agentbridge-cli serve
# {"host":"127.0.0.1","port":60069,"token":"ab_local_..."}
```

```python
import requests

session = requests.post(f"{base}/sessions", headers=auth,
                        json={"provider": "claude"}).json()
requests.post(f"{base}/sessions/{session['id']}/messages", headers=auth,
              json={"message": "hello"})
# events stream over ws://…/events — see examples/runtime-python
```

The daemon binds to `127.0.0.1` only and mints a fresh token per start.
`examples/runtime-python/client.py` drives a full session using nothing but the Python standard
library — that is the whole point of the wire protocol.

### Same code, in-process or over the wire

The SDK exposes one interface over both transports, so moving from an embedded integration to a
shared daemon is a configuration change, not a rewrite:

```typescript
import { createClient } from "@jeonhui/agentbridge/sdk";

const client = createClient({ transport: "embedded", agent });
// …later, same code, different deployment:
const client = createClient({ transport: "http", baseUrl, token, webSocket: (u) => new WebSocket(u) });
```

One parity test suite runs against both backends, so they cannot quietly drift apart.

### Let an agent drive AgentBridge

The reverse direction also works: expose AgentBridge itself as an MCP server, and an external agent
can list providers, create sessions, and call tools — under the same permission rules:

```typescript
import { AgentBridgeMcpServer } from "@jeonhui/agentbridge/mcp-server";
await new AgentBridgeMcpServer({ agent }).serveStdio();
```

Call depth is capped (default 2), so a session AgentBridge created cannot recurse into itself.

### No agent CLI? Talk to a model API

Not every machine has an agent CLI installed. The `/api` providers speak HTTP instead: point one at
any OpenAI-compatible endpoint — LiteLLM, OpenRouter, Ollama, vLLM, OpenAI itself — or at the
Gemini API, and it behaves like every other provider. AgentBridge supplies the agent loop the CLI
would have brought, and executes the model's tool calls through the same MCP and permission
machinery, so ask-mode approval works with no extra setup:

```typescript
import { LiteLLMProvider, OpenAICompatProvider, GeminiApiProvider } from "@jeonhui/agentbridge/api";

agent.registerProvider(new LiteLLMProvider());                    // http://127.0.0.1:4000/v1
agent.registerProvider(new GeminiApiProvider());                  // needs GEMINI_API_KEY
agent.registerProvider(new OpenAICompatProvider({                 // any compatible endpoint
  id: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "llama3.2",
}));

const session = await agent.sessions.create({ provider: "litellm", model: "gpt-4o", mcp: ["fs"] });
```

Sessions, events, `/model`, `/tools`, MCP bindings, and approvals all work identically. The one
honest difference: `resume` is `false` — the conversation lives in process memory, so a restart
starts fresh. Writing your own is two methods: extend `ApiProviderBase` and implement `detect()`
plus `complete()` (one request/response in your wire format); the loop, history, abort handling,
and permission flow are inherited.

### Name your agents — and let them call each other

If you keep assembling the same provider + model + role + tools, declare it once:

```typescript
agent.agents.define({
  id: "reviewer",
  name: "Code Reviewer",
  description: "Reviews code for correctness and style.",
  role: "You are a strict but fair code reviewer. Point at lines, not vibes.",
  provider: "claude",
  model: "sonnet",
  mcp: ["filesystem"],
});

const session = await agent.sessions.create({ agent: "reviewer" });   // overrides allowed
```

Every defined agent is also a **tool**: `agent:reviewer:ask` (shown to models as
`ask_reviewer`, input `{ message }`). Any other agent — a CLI session via the AgentBridge MCP
server, an API provider through its tool loop, or your own code — can call it and gets back the
reviewer's reply:

```typescript
const result = await agent.tools.call("agent:reviewer:ask", {
  message: "Review the diff in src/auth.ts",
});
// → { agent: "reviewer", sessionId: "…", reply: "…" }
```

Agent-to-agent calls run through the same permission system as every other tool (class
`EXECUTE`), so ask-mode and policy rules decide before anything runs. Chains are depth-capped
(`maxAgentCallDepth`, default 2), so two agents can consult each other without recursing forever.
By default each call is a fresh conversation; set `memory: "persistent"` on the definition to
keep one session that remembers across calls.

### Use it from a web page

The runtime itself is Node-only — it spawns CLI processes and reads the OS keychain, which no
browser allows. The web story is a split: the daemon runs locally, and the page talks to it.

```typescript
// this file can be bundled for the browser (~13 kB)
import { createClient } from "@jeonhui/agentbridge/sdk";

const client = createClient({
  transport: "http",
  baseUrl: "http://127.0.0.1:8760",
  token,                                   // from ~/.agentbridge/runtime.json
  webSocket: (url) => new WebSocket(url),  // the browser's own WebSocket
});
```

`@jeonhui/agentbridge/sdk` deliberately imports nothing from Node, so
`esbuild --platform=browser` (or Vite/webpack) bundles it clean. Everything else in the package is
server-side.

---

## Bundling

Verified with esbuild against the published package:

| Target | Works |
| --- | --- |
| `--platform=node --format=cjs` | ✅ as-is |
| `--platform=node --format=esm` (single file) | ✅ with the standard banner¹ |
| `--platform=browser`, importing `/sdk` only | ✅ as-is, ~13 kB |
| `--packages=external` (either format) | ✅ as-is |

¹ Some dependencies use dynamic `require`, which esbuild's single-file ESM output cannot express.
The usual one-liner fixes it:

```bash
esbuild app.ts --bundle --platform=node --format=esm \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);"
```

The permission prompt tool survives bundling by design: it is dependency-free source the library
writes to a temp file at runtime, not a file that has to be found inside `node_modules`.

---

## Good to know

**Sessions survive restarts.** With file storage (`agentbridge serve` uses it by default), sessions,
MCP registrations, and permission rules come back after the daemon restarts. A restored session
returns as `stopped` — its process is gone — but `sessions.resume()` continues the same conversation
via the provider's own session id.

**Secrets never touch disk in plain text.** Reference them instead of pasting them:

```jsonc
{ "env": { "GITHUB_TOKEN": "secret://github/token" } }
```

The reference is what gets stored and what the API shows (`"***"`); only the spawned process sees
the real value, resolved from the OS keychain or the environment. An unresolvable reference fails
loudly (`AB-6004`) instead of passing the literal through — a fake-looking token that "works" until
it hits the network is much harder to debug.

**Logs cannot leak.** Every logged field passes through redaction: message bodies become a length +
digest, tool arguments become key names + digest, and anything named like a secret becomes `***`.

## Provider status

Honesty over optimism — an adapter that looks supported and then fails is worse than one labelled
unsupported.

| Provider | Status |
| --- | --- |
| **Claude Code** | ✅ Verified end to end against the real CLI: streaming, resume, MCP tools, approval hook |
| **Codex** | ⚠️ Adapter implemented and tested against captured output, but no turn has completed on the dev machine (the account rejects every model). `pnpm scenario:codex` shows it failing *correctly*. Run `codex update` and retry |
| **OpenAI-compatible APIs** (LiteLLM, OpenRouter, Ollama, vLLM, OpenAI) | ✅ `OpenAICompatProvider` / `LiteLLMProvider`, verified against wire-accurate fake servers including the full MCP + ask-approval loop |
| **Gemini (API)** | ✅ `GeminiApiProvider` with `GEMINI_API_KEY`, verified against a wire-accurate fake server |
| **Gemini (CLI)** | ❌ Removed. Google retired the individual sign-in the CLI used, and its successor (Antigravity) is a GUI IDE with no headless entry point. Comes back if a CLI turn can complete end to end — use the API provider meanwhile |

## Examples

| Example | Shows | Needs |
| --- | --- | --- |
| [`examples/chat`](examples/chat) | **A complete host app**: terminal chat, tools, interactive y/N approvals | Claude CLI |
| [`examples/basic`](examples/basic) | Stream a reply into your program | Claude CLI |
| [`examples/mcp`](examples/mcp) | Give the agent your tools, watch the calls | Claude CLI |
| [`examples/tools`](examples/tools) | Approval flow, no agent required | nothing |
| [`examples/runtime-python`](examples/runtime-python) | Drive a session from Python | Claude CLI |

## Documentation

The full design — API contracts, the event protocol, error codes, acceptance scenarios — lives in
the [Product & Functional Specification](docs/AgentBridge-Product-Spec.md). Code comments cite spec
section numbers, so the two can be checked against each other.

---

## Development

```bash
pnpm install
pnpm build
pnpm test          # 285 tests
pnpm scenario:a    # real-CLI acceptance scenarios (needs claude)
```

Node 20+, pnpm 9+. Publishing must go through `pnpm publish` — a guard blocks `npm publish`, which
would ship a tarball npm itself cannot install (it leaves the `workspace:` protocol in
dependencies).

Heads-up: deleting `dist/` by hand leaves `tsconfig.tsbuildinfo` behind, and `tsc -b` will then emit
nothing while tests report zero passing. Use `pnpm clean` or `tsc -b --force`.

### Layout

```text
packages/agentbridge/src/
├── core/          # AgentBridge, sessions, events, errors, storage, secrets
├── provider/      # adapter contract, CLI detection, Claude + Codex adapters
├── mcp/           # client + transports, tool registry, hot-reload manager, MCP server
├── permission/    # policy rules, approval queue, the prompt-hook gateway
├── runtime/       # local REST + WebSocket server
└── sdk/           # one client over both transports
apps/runtime/      # the `agentbridge` daemon (@jeonhui/agentbridge-cli)
```

The directories are the module boundaries: `sdk → core → provider/mcp/permission → storage`, one
way. Shipping as a single package does not relax this — an import that reverses the arrow is a
defect.

### Design principles

- **Headless** — no UI; every state change is an event.
- **Provider-agnostic** — the core knows only the `AgentProvider` interface; CLI details stay in adapters.
- **MCP-first** — integrations are MCP servers, not core features.
- **Local-first** — works offline; sessions, config, and logs stay on the machine.

## License

MIT
