# AgentBridge Product & Functional Specification

| Field | Value |
| --- | --- |
| Document | AgentBridge Product & Functional Specification |
| Product | AgentBridge |
| Version | v1.0 |
| Date | 2026-08-15 |
| Status | Approved (baseline for MVP development) |
| Audience | AgentBridge core developers, SDK integrators, technical product owners |
| Scope | All of Phase 1 (MVP), plus direction for Phases 2–4 |

---

## Table of contents

1. [Document overview](#1-document-overview)
2. [Product definition](#2-product-definition)
3. [Problems being solved](#3-problems-being-solved)
4. [Goals](#4-goals)
5. [Non-goals](#5-non-goals)
6. [Users and personas](#6-users-and-personas)
7. [Core use cases](#7-core-use-cases)
8. [System architecture](#8-system-architecture)
9. [Execution modes](#9-execution-modes)
10. [Module specifications](#10-module-specifications)
11. [Package layout](#11-package-layout)
12. [Provider system](#12-provider-system)
13. [Session specification](#13-session-specification)
14. [SDK API specification](#14-sdk-api-specification)
15. [Event system](#15-event-system)
16. [Runtime REST API](#16-runtime-rest-api)
17. [Runtime WebSocket protocol](#17-runtime-websocket-protocol)
18. [Error code scheme](#18-error-code-scheme)
19. [Data models](#19-data-models)
20. [Storage](#20-storage)
21. [MCP specification](#21-mcp-specification)
22. [MCP hot reload](#22-mcp-hot-reload)
23. [AgentBridge MCP Server (bidirectional)](#23-agentbridge-mcp-server-bidirectional)
24. [Tool Registry](#24-tool-registry)
25. [Permissions and approval](#25-permissions-and-approval)
26. [Security and secret management](#26-security-and-secret-management)
27. [Logging and observability](#27-logging-and-observability)
28. [Non-functional requirements](#28-non-functional-requirements)
29. [MVP scope](#29-mvp-scope)
30. [Roadmap](#30-roadmap)
31. [Acceptance scenarios](#31-acceptance-scenarios)
32. [Risks and mitigations](#32-risks-and-mitigations)
33. [Open decisions and defaults](#33-open-decisions-and-defaults)
34. [Glossary](#34-glossary)
35. [Appendix: minimal examples](#35-appendix-minimal-examples)
36. [Final product definition](#36-final-product-definition)

---

## 1. Document overview

This document consolidates AgentBridge's product definition, architecture, functional specification, API contracts, data models, and acceptance criteria into a single development baseline. It aims to be detailed enough that the MVP can be built from this document alone.

Conventions:

- **MUST** — required. Counts toward MVP completion.
- **SHOULD** — strongly recommended. Record a rationale if not implemented.
- **MAY** — optional. May be deferred past Phase 2.
- TypeScript signatures in code blocks are implementation contracts. Changing a field name or type requires revising this document.
- "Agent" means a locally installed AI coding agent CLI (Claude, Gemini, Codex, etc.). "AgentBridge" means the runtime that connects them.

---

## 2. Product definition

### 2.1 One-line definition

> A general-purpose local agent runtime that connects locally installed AI agents — Claude, Gemini, Codex — to external programs, and supplies those agents with user-defined tools through MCP.

### 2.2 Product type

**A headless local AI agent runtime and SDK.** AgentBridge provides no chat UI. When a UI is needed, the external program consuming AgentBridge builds it.

### 2.3 Positioning

AgentBridge is deliberately **not** any of the following.

| Category | How AgentBridge differs |
| --- | --- |
| Chat UI | Ships no conversation surface. Emits an event stream instead. |
| AI assistant product | Does not productize end-user features such as summarization or drafting. |
| LLM API wrapper | Never calls a model API directly. It orchestrates local agent CLI processes. |
| MCP client GUI | Ships no MCP management screen, only a management API. |

The target category is **local agent infrastructure**: the connection layer that lets any application use local AI agents.

### 2.4 Four design principles

| Principle | Meaning | Consequence for implementation |
| --- | --- | --- |
| Headless | No UI | Core packages carry no DOM or renderer dependency. Every state change is emitted as an event. |
| Provider-agnostic | Not bound to one AI | The core knows only the `AgentProvider` interface; CLI specifics stay isolated in adapters. |
| MCP-first | Extend through MCP | Integrations become MCP servers instead of accreting into the core. |
| Local-first | Local by default | Works without network access. Sessions, config, and logs live on the machine. Cloud sync is a non-goal. |

---

## 3. Problems being solved

| # | Problem | Today | AgentBridge's answer |
| --- | --- | --- | --- |
| P1 | Local agents are trapped in their own CLI or UI | Claude Code, Gemini CLI, and Codex CLI each run in a separate terminal | One SDK and runtime API reaches all of them |
| P2 | Every agent has a different launch, stream, and session contract | CLI flags, output formats, and resume mechanics all differ | Provider adapters unify the interface |
| P3 | MCP configuration is fragmented per agent | Each CLI registers MCP servers in its own config file | The MCP Manager centralizes registration and injects per session |
| P4 | The MCP development loop is slow | Editing server code requires restarting the whole agent | Hot reload refreshes tools without dropping the session |
| P5 | External apps cannot observe tool execution | Only CLI text output exists | Structured `tool_call` / `tool_result` events |
| P6 | Permission control is dictated by each agent's policy | Approval UX differs per agent | The Permission Manager delegates approval to the external app |
| P7 | Non-TypeScript languages cannot reach local agents | Only Node-based SDKs exist | Local Runtime Mode (HTTP/WebSocket) is language-neutral |

---

## 4. Goals

### 4.1 Product goals

- **G1** — An external program can create a local agent session and exchange messages in five lines of code or fewer, with the provider chosen by name. (MUST) Met for Claude; Codex and Gemini are covered in 33.2 and the provider status notes.
- **G2** — Switching providers requires changing only the `provider` string; the session API is identical across providers. (MUST)
- **G3** — User-authored MCP servers can be registered and removed at runtime, and each session can carry a different MCP combination. (MUST)
- **G4** — Changes to MCP server code reach the Tool Registry and running sessions without restarting the agent session. (MUST)
- **G5** — Every tool execution reaches the external program as a structured event in real time. (MUST)
- **G6** — Tool executions that require permission pass through the external program's allow/deny decision. (MUST)
- **G7** — AgentBridge itself acts as an MCP server, exposing its own tools to external agents. (MUST)
- **G8** — Non-TypeScript languages (Python, Swift, Kotlin, …) reach the same functionality through the runtime API. (MUST)

### 4.2 Measurable success metrics

| Metric | Target | Method |
| --- | --- | --- |
| Integration time | A new external app reaches its first response within 30 minutes | Measured onboarding against the examples |
| Cost of a new provider | A new provider adapter fits in 500 LOC or fewer | Adapter package line count |
| Hot reload latency | File change to Tool Registry refresh within 3 seconds | Automated test instrumentation |
| Event loss | Zero events lost for subscribed sessions | Sequence-number verification test |
| Scenario pass rate | Acceptance scenarios A–E all pass | Automation of chapter 31 |

---

## 5. Non-goals

The MVP deliberately does **not** implement the following. Each is classified as a later phase or a permanent exclusion.

| Non-goal | Rationale | Plan |
| --- | --- | --- |
| GUI automation (screenshot, mouse, keyboard, window control) | OS-specific area that MCP cannot cover, and unnecessary for MVP validation | Phase 2 |
| Vision agent (screen-understanding decisions) | Requires the GUI engine first | Phase 2 |
| Virtual desktop (isolated agent workspace) | Demands virtualization infrastructure; scope too large | Phase 3 |
| Routine (user-defined automation scenarios) | Requires an execution engine and scheduler first | Phase 4 |
| Scheduler (timed execution) | Requires an always-on daemon policy | Phase 4 |
| MCP marketplace (discovery, install, versioning) | Requires a registry and trust model | Phase 4 |
| Cloud sync (config and session sync) | Conflicts with local-first; needs a separate product decision | Reassess after Phase 4 |
| Multi-agent orchestration | Requires stable single-session behavior first | Phase 4 |
| Shipping a chat UI | Excluded by the product definition | Permanent |
| Direct model API calls (own inference) | Would turn the product into an LLM API wrapper | Permanent (extensible via a provider adapter) |

---

## 6. Users and personas

AgentBridge's users are developers, not end consumers.

### 6.1 Persona A — IDE and editor developer (Jiwoo)

- **Role**: front-end and desktop developer adding AI features to an internal editor.
- **Need**: build the editor UI themselves, but not the agent execution, streaming, and tool-approval logic.
- **How they use AgentBridge**: imports the SDK in Embedded Mode and binds `message` / `tool_call` events to their own UI components. Approval UI renders from `permission_request` events.

### 6.2 Persona B — Internal tooling backend developer (Hyunwoo)

- **Role**: operates Python and Java automation servers.
- **Need**: cannot use the TypeScript SDK, but wants to call the agents on a local dev machine over HTTP.
- **How they use AgentBridge**: runs AgentBridge in Local Runtime Mode, creates sessions over REST, and receives events over WebSocket.

### 6.3 Persona C — MCP server developer (Seoyeon)

- **Role**: builds MCP servers exposing internal ERP and database systems.
- **Need**: see tool changes immediately without restarting the agent on every edit.
- **How they use AgentBridge**: registers the in-development server with `mcp.add()` and `watch: true`, then watches hot reload refresh the registry and the live session.

### 6.4 Persona D — Desktop automation product developer (Minjae)

- **Role**: builds a desktop agent product that touches local files and applications.
- **Need**: let the agent operate the local system, but strictly under user control.
- **How they use AgentBridge**: sets the permission policy to `ask` and handles WRITE/EXECUTE requests in a custom dialog. Exposes their own product features to the agent as tools through the AgentBridge MCP Server.

### 6.5 Persona E — Platform and infrastructure engineer (Taeyoon)

- **Role**: standardizes the agent execution environment for a whole team.
- **Need**: manage provider environments, MCP configuration, and logging consistently, with an audit trail.
- **How they use AgentBridge**: distributes provider and MCP profiles as configuration and forwards structured logs into a collection pipeline.

---

## 7. Core use cases

| ID | Use case | Actor | Flow | Goals |
| --- | --- | --- | --- | --- |
| UC-01 | Discover local agents | External app | Call `providers.list()` and receive detection results for installed CLIs | G1 |
| UC-02 | Create a session and ask | External app | `sessions.create()` → `send()` → receive `message` events | G1, G5 |
| UC-03 | Swap providers | External app | Change `provider: "codex"` in otherwise identical code | G2 |
| UC-04 | Register a user MCP server | MCP developer | `mcp.add()` → connect → tool discovery → registry update | G3 |
| UC-05 | Per-session MCP sets | External app | Session A gets filesystem + github; session B gets filesystem only | G3 |
| UC-06 | MCP hot reload | MCP developer | Save server code → detect → reconnect → refresh tools → apply to session | G4 |
| UC-07 | Observe tool execution | External app | Receive `tool_call` → `tool_progress` → `tool_result` | G5 |
| UC-08 | Approve a permission | End user | WRITE tool call → `permission_request` → `approve()` / `deny()` | G6 |
| UC-09 | Interrupt execution | End user | Call `interrupt()` mid-run; session returns to idle | G6 |
| UC-10 | Expose AgentBridge tools | External agent | An external Claude connects to the AgentBridge MCP Server and calls a tool | G7 |
| UC-11 | Non-TypeScript integration | Backend developer | Drive sessions from Python over REST and WebSocket | G8 |
| UC-12 | Resume a session | External app | After a process restart, `resume()` with the stored session id | G1 |

---

## 8. System architecture

### 8.1 Overall structure

```text
                         ┌───────────────────────┐
                         │    Any Application    │
                         │  (IDE / SaaS / Tool)  │
                         └───────────┬───────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
            @jeonhui/agentbridge/sdk         HTTP / WebSocket / IPC
              (Embedded)                        (Local Runtime)
                    │                                 │
                    └────────────────┬────────────────┘
                                     ▼
                    ┌────────────────────────────────┐
                    │        AgentBridge Core        │
                    │  Agent Runtime / Event Bus     │
                    └────────────────┬───────────────┘
                                     │
       ┌──────────────┬──────────────┼──────────────┬───────────────┐
       ▼              ▼              ▼              ▼               ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐
│  Provider  │ │  Session   │ │    MCP     │ │ Permission │ │   Storage   │
│  Manager   │ │  Manager   │ │  Manager   │ │  Manager   │ │  & Logging  │
└─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────────────┘
      │              │              │              │
      │              │              ▼              │
      │              │      ┌───────────────┐      │
      │              └─────▶│ Tool Registry │◀─────┘
      │                     └───────┬───────┘
      ▼                             ▼
┌──────────────────┐   ┌──────────────────────────────┐
│ Claude / Gemini  │   │ Built-in MCP / User MCP /    │
│ Codex processes  │   │ External MCP (stdio·SSE·HTTP)│
└──────────────────┘   └──────────────────────────────┘
```

### 8.2 Layers

| Layer | Components | Responsibility |
| --- | --- | --- |
| Interface | SDK, runtime (REST/WS/IPC) | External contact surface: serialization, auth, subscription management |
| Orchestration | Core, Session Manager, Event Bus | Session lifecycle, event fan-out, state transitions |
| Capability | Provider Manager, MCP Manager, Tool Registry, Permission Manager | Agent execution, tool supply, permission decisions |
| Adapter | Provider adapters, MCP transports | Isolates external process and protocol details |
| Infrastructure | Storage (JSON documents), secret store (OS keychain), logger | Persistence, secrets, observability |

### 8.3 Data flow for one message round trip

```text
External App
   │ send(sessionId, text)
   ▼
Core ── Session Manager: transition to running, assign event sequence
   │
   ▼
Provider adapter ── write stdin ──▶ Agent CLI process
   │                                     │
   │◀──── stdout stream (JSON lines) ────┘
   ▼
Adapter normalizes → AgentEvent
   │
   ├─ if tool_call → Permission Manager evaluates
   │        └─ under the ask policy, emit permission_request and wait
   ▼
Event Bus → SDK subscribers / WebSocket subscribers
   │
   ▼
Storage: persist session state and event metadata
```

### 8.4 Dependency rules

- The core (`src/core`) imports no provider implementation directly. (MUST)
- Provider adapters never reference the MCP Manager. The core injects MCP configuration at session creation. (MUST)
- The Tool Registry knows nothing about providers. A tool's origin is expressed only through its `source` field. (MUST)
- The runtime package depends on the core, not on the SDK. The SDK is a client that can select either backend. (MUST)
- No circular dependencies. The direction is `sdk → core → provider/mcp/permission → storage`, one way. Shipping as one package does not relax this: the directories are the boundary, and a cross-directory import that reverses the arrow is a defect. (MUST)

---

## 9. Execution modes

### 9.1 Embedded Mode

The external program imports the SDK and runs it in the same Node process.

```typescript
import { AgentBridge } from "@jeonhui/agentbridge";

const agent = new AgentBridge();
await agent.start();

const session = await agent.sessions.create({ provider: "claude" });
await session.send("Analyze the current project");
```

### 9.2 Local Runtime Mode

AgentBridge runs as a separate local process reached over HTTP, WebSocket, or IPC.

```text
My App ──HTTP/WS/IPC──▶ agentbridge daemon ──▶ Claude / Codex / MCP
```

### 9.3 Mode comparison

| Aspect | Embedded Mode | Local Runtime Mode |
| --- | --- | --- |
| Calling language | TypeScript / JavaScript | Any language that speaks HTTP or WebSocket |
| Process | Same process as the host app | Independent daemon |
| Latency | Function-call level (minimal) | Adds a local socket round trip (single-digit ms) |
| Fault isolation | Host crash ends the sessions | Sessions can survive a host restart |
| Event delivery | In-process EventEmitter | WebSocket frames or IPC messages |
| Multiple clients | Single host | Several apps share one runtime |
| Deployment complexity | Low (add a dependency) | Medium (manage a daemon lifecycle) |
| Best for | Node-based IDEs, CLIs, Electron apps | Python/Swift/Kotlin/Java/C# apps, multi-client setups |

**Selection rule**: choose Embedded when the host is Node and the runtime serves that app alone; otherwise choose Runtime. The SDK keeps an identical API surface, so switching must require only a `transport` setting change. (MUST)

---

## 10. Module specifications

Each module is defined by responsibility, inputs, outputs, dependencies, and invariants.

### 10.1 Core (`src/core`)

| Field | Value |
| --- | --- |
| Responsibility | Runtime bootstrap, manager wiring, event bus, public API surface |
| Inputs | `AgentBridgeConfig` (storage path, log level, default permission policy, MCP presets) |
| Outputs | `AgentBridge` instance, global event stream |
| Dependencies | provider-core, mcp, permission, storage |
| Invariants | No session may be created before `start()`. Every event carries a monotonically increasing `seq`. Shutdown reclaims every child process. |

### 10.2 Provider Manager (`src/provider/core`)

| Field | Value |
| --- | --- |
| Responsibility | Adapter registration, local installation discovery, adapter selection and delegation |
| Inputs | Adapter list, detection requests, `AgentStartOptions` |
| Outputs | `ProviderInfo[]`, `ProviderSessionHandle` |
| Dependencies | None (references core interfaces only) |
| Invariants | No duplicate adapter ids. Detection results are TTL-cached and explicitly invalidatable. |

### 10.3 Session Manager (`src/core/session`)

| Field | Value |
| --- | --- |
| Responsibility | Session create, read, list, interrupt, resume, stop; state transitions; message queueing |
| Inputs | `CreateSessionOptions`, user messages, control commands |
| Outputs | `AgentSession`, session events |
| Dependencies | Provider Manager, MCP Manager, storage |
| Invariants | Transitions never leave the state machine in 13.2. A `stopped` session rejects `send`. One in-flight turn per session. |

### 10.4 MCP Manager (`@jeonhui/agentbridge-mcp/manager`)

| Field | Value |
| --- | --- |
| Responsibility | MCP server registration, connection, teardown, reconnection, hot reload; triggering tool discovery |
| Inputs | `McpServerConfig`, file change events, reload requests |
| Outputs | Connection state, discovered tools, MCP events |
| Dependencies | MCP client (transports), Tool Registry |
| Invariants | Server ids are unique. A connection failure never kills a session. During reload, calls to that server are queued or rejected. |

### 10.5 Tool Registry (`@jeonhui/agentbridge-mcp/registry`)

| Field | Value |
| --- | --- |
| Responsibility | Unified index of every tool (mcp/builtin/system); computing the visible tool set per session |
| Inputs | Discovery results, built-in tool registration, session MCP bindings |
| Outputs | `AgentTool[]`, session-scoped tool views |
| Dependencies | Permission Manager (attaches permission metadata) |
| Invariants | Tool ids follow `{source}:{server}:{name}` and are globally unique. Name collisions are resolved with a server prefix. |

### 10.6 Permission Manager (`src/permission`)

| Field | Value |
| --- | --- |
| Responsibility | Tool-to-permission mapping, policy evaluation, approval request creation and resolution |
| Inputs | Tool call requests, policy configuration, allow/deny responses from the external app |
| Outputs | `PermissionDecision`, `permission_request` events |
| Dependencies | Storage (policies and audit records) |
| Invariants | Deny-by-default. No response means denial after the timeout. Every decision is written to the audit log. |

### 10.7 Runtime (`src/runtime`, `apps/runtime`)

| Field | Value |
| --- | --- |
| Responsibility | REST, WebSocket, and IPC servers; authentication; request validation; event fan-out |
| Inputs | HTTP requests, WS frames, IPC messages |
| Outputs | JSON responses, event frames |
| Dependencies | Core |
| Invariants | Binds to `127.0.0.1` by default. Requests without a token are rejected. Events reach only that session's subscribers. |

### 10.8 SDK (`src/sdk`)

| Field | Value |
| --- | --- |
| Responsibility | One client API over the embedded and runtime backends; type distribution |
| Inputs | `transport: "embedded" \| "http"` |
| Outputs | An isomorphic `AgentBridge` interface |
| Dependencies | Core (embedded) or an HTTP client |
| Invariants | Both backends expose identical public signatures. Backend-specific features are not surfaced. |

### 10.9 Storage and logging (`src/core/storage`)

| Field | Value |
| --- | --- |
| Responsibility | Persistence behind the Storage interface, structured log emission, sensitive-value redaction |
| Inputs | Session, MCP, permission, and event records; log entries |
| Outputs | Query results, log stream or files |
| Dependencies | None |
| Invariants | User message bodies and tool arguments are not stored in plaintext by default. Document writes are atomic. |

---

## 11. Package layout

A pnpm workspace monorepo.

```text
agentbridge/
├── package.json                     # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   └── agentbridge/                 # the published package, @jeonhui/agentbridge
│       ├── src/
│       │   ├── core/                # AgentBridge, sessions, events, errors, storage, logging, secrets
│       │   ├── provider/
│       │   │   ├── core/            # AgentProvider contract, detection, process and stream plumbing
│       │   │   ├── claude/          # Claude Code adapter
│       │   │   └── codex/           # Codex CLI adapter
│       │   ├── mcp/
│       │   │   ├── client/          # transports: stdio, SSE, streamable HTTP
│       │   │   ├── registry/        # Tool Registry and permission inference
│       │   │   ├── manager/         # registration, connection, hot reload
│       │   │   └── server/          # AgentBridge exposed as an MCP server
│       │   ├── permission/          # policy, approval queue, prompt hook gateway
│       │   ├── runtime/             # REST and WebSocket server
│       │   └── sdk/                 # embedded and HTTP backends behind one interface
│       └── bin/approval-mcp.mjs     # the permission prompt tool the agent CLI launches
├── apps/
│   └── runtime/                     # @jeonhui/agentbridge-cli, the `agentbridge` daemon
├── examples/
│   ├── basic/                       # session + message
│   ├── mcp/                         # user MCP registration + hot reload
│   ├── tools/                       # calling tools with host-side approval
│   └── runtime-python/              # REST/WS client example
└── docs/
    └── AgentBridge-Product-Spec.md
```

The MVP shipped as twelve packages and was consolidated into one before release. Nobody installs a
runtime without a provider, or an MCP manager without its registry, so the split asked consumers to
make an install decision that carried no choice. Subpath exports keep the boundaries visible in
imports; the directories above are still the module boundaries the dependency rules in 8.4 govern.


---

## 12. Provider system

### 12.1 Provider interface contract

```typescript
export interface AgentProvider {
  readonly id: string;              // "claude" | "gemini" | "codex" | custom
  readonly name: string;            // display name
  readonly capabilities: ProviderCapabilities;

  /** Detects local installation and version. Must be free of side effects. */
  detect(): Promise<ProviderDetection>;

  /** Starts the agent process and returns a session handle. */
  start(options: AgentStartOptions): Promise<ProviderSessionHandle>;

  /** Delivers a user message to the agent. */
  send(handle: ProviderSessionHandle, message: string): Promise<void>;

  /** Interrupts the in-flight turn. The session stays alive. */
  interrupt(handle: ProviderSessionHandle): Promise<void>;

  /** Terminates the agent process and reclaims its resources. */
  stop(handle: ProviderSessionHandle): Promise<void>;

  /** Normalizes raw agent output into events. */
  parse(chunk: string): AgentEvent[];
}

export interface ProviderCapabilities {
  streaming: boolean;          // token or chunk streaming
  mcp: boolean;                // MCP server injection
  resume: boolean;             // session resume
  interrupt: boolean;          // mid-run interruption
  workingDirectory: boolean;   // working directory selection
  permissionHook: boolean;     // external approval hook
}

export interface ProviderDetection {
  available: boolean;
  version?: string;
  executablePath?: string;
  reason?: string;             // why detection failed
}

export interface AgentStartOptions {
  sessionId: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  mcpServers?: ResolvedMcpServer[];   // MCP configuration to inject
  model?: string;
  systemPrompt?: string;
  resumeToken?: string;               // provider-specific resume token
}

/** Injection-ready configuration resolved when binding to a session. Secret references are already expanded. */
export interface ResolvedMcpServer {
  id: string;
  transport: McpTransport;
  command?: string;                   // stdio
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;                       // sse | streamable-http
  headers?: Record<string, string>;
  toolPrefix?: string;
}

export interface ProviderSessionHandle {
  sessionId: string;
  providerId: string;
  pid?: number;
  nativeSessionId?: string;           // the agent CLI's own session id
}
```

### 12.2 Adapter principles

```text
Agent Core
    ↓ (depends on the interface only)
AgentProvider
    ↓
ClaudeProvider / GeminiProvider / CodexProvider
    ↓
each CLI process (child_process)
```

- The core never learns CLI flags or output formats. (MUST)
- Adapters treat parse failures as `error` events rather than silent event loss, so CLI format drift is visible. (MUST)
- Adapters handle stdout and stderr separately; stderr is logged only by default. (SHOULD)

### 12.3 Adapter implementation notes

Exact CLI flags shift between versions, so each adapter implements the **baseline interface** below while checking the version during `detect()` and reflecting the supported surface in `capabilities`. Unsupported features are reported as `false` so the core can pick an alternative path. (MUST)

#### 12.3.1 ClaudeProvider

| Aspect | Design |
| --- | --- |
| Detection | `claude --version` exits 0. On failure, walk PATH and standard install locations |
| Launch | Non-interactive streaming mode with JSON stream output (`--print`, `--output-format stream-json` family) |
| Input | User turns over streamed stdin (JSON lines). Versions without stdin streaming fall back to one process per turn |
| MCP injection | Write a session-scoped MCP config file to a temp directory and pass it through the CLI's MCP config option |
| Stream parsing | Map line-delimited JSON onto `message` / `tool_call` / `tool_result` / `status` events |
| Interrupt | Send an interrupt signal to the process and return the session to `waiting` |
| Resume | Store the CLI's session identifier as `nativeSessionId` and pass it to the resume option |

#### 12.3.2 GeminiProvider

Not shipped in the MVP; see 33.2 for why. The design below is what it returns to when a turn can be
completed end to end, and the flag names have been corrected against gemini 0.55.1 rather than left
as they were first guessed.

| Aspect | Design |
| --- | --- |
| Detection | `gemini --version` exits 0 |
| Authentication | An individual Code Assist sign-in no longer works; `GEMINI_API_KEY` does (33.2) |
| Launch | Non-interactive prompt mode with stream output parsing |
| Input | stdin or a prompt argument. Without stdin streaming, restart the process per turn |
| MCP injection | There is no `--settings` flag. Point `GEMINI_CLI_HOME` at a per-session directory and write `.gemini/settings.json` there, then restrict visibility with `--allowed-mcp-server-names` |
| Stream parsing | On versions without structured output, accumulate text and emit a single `message` event at turn end |
| Interrupt | Signal-based process interruption |
| Resume | Where unsupported, expose `capabilities.resume=false` and let the core replay conversation history instead |

#### 12.3.3 CodexProvider

| Aspect | Design |
| --- | --- |
| Detection | `codex --version` exits 0 |
| Launch | Non-interactive execution mode (`exec` family) with JSON output |
| Input | Prompt passed per execution; continuity is preserved through `nativeSessionId` resume options |
| MCP injection | Inject `mcp_servers` through the config file or execution-time config overrides |
| Stream parsing | Map the JSON event stream onto standard events. File change events normalize to `tool_result` |
| Interrupt | Terminate the process while retaining session state; resume on the next turn |
| Sandbox | Pin the CLI's own approval and sandbox options to the least-privilege setting so they do not double up with AgentBridge policy; AgentBridge owns approval |

#### 12.3.4 Custom providers

External developers may implement `AgentProvider` and register it with `providers.register()`. (MUST) Registered adapters follow the same detection and session-creation flow as built-in ones.

### 12.4 Provider discovery

```text
detectProviders()
  ├─ iterate built-in adapters
  ├─ run each detect() in parallel (3s timeout)
  ├─ cache results (60s TTL)
  └─ return ProviderInfo[]
       → { id, name, available, version, capabilities, reason? }
```

- Detection runs in parallel, and one adapter's failure never aborts the sweep. (MUST)
- Uninstalled providers still appear in the results with `available: false` and a `reason`. (MUST)
---

## 13. Session specification

### 13.1 Session shape

```typescript
export interface AgentSession {
  id: string;                       // ULID
  provider: string;                 // provider id
  title?: string;                   // label for the external app
  workingDirectory?: string;
  status: SessionStatus;
  mcpServers: string[];             // MCP server ids bound to this session
  model?: string;
  env?: Record<string, string>;
  permissionMode: PermissionMode;   // "ask" | "allow" | "deny"
  createdAt: Date;
  updatedAt: Date;
  lastError?: AgentBridgeErrorInfo;
}

export type SessionStatus =
  | "starting"   // process starting
  | "ready"      // idle, awaiting input
  | "running"    // processing a turn
  | "waiting"    // awaiting approval or user input
  | "stopped"    // terminated normally
  | "error";     // terminated abnormally
```

### 13.2 State machine

```text
          create()
             │
             ▼
        ┌─────────┐  start fails  ┌───────┐
        │starting │──────────────▶│ error │
        └────┬────┘               └───┬───┘
             │ started                │ stop()
             ▼                        ▼
        ┌─────────┐   send()   ┌─────────┐
   ┌───▶│  ready  │───────────▶│ running │
   │    └────┬────┘            └────┬────┘
   │         │ stop()               │ approval or input needed
   │         ▼                      ▼
   │    ┌─────────┐            ┌─────────┐
   │    │ stopped │            │ waiting │
   │    └─────────┘            └────┬────┘
   │                                │ approve() / deny() / response
   └────────────────────────────────┘
        turn end moves running → ready
```

Transition rules:

| Current | Allowed actions | Resulting state |
| --- | --- | --- |
| starting | stop | stopped |
| ready | send, stop, updateMcp | running / stopped / ready |
| running | interrupt, stop | ready / stopped |
| waiting | approve, deny, interrupt, stop | running / ready / stopped |
| stopped | resume | starting |
| error | resume, stop | starting / stopped |

- `send` on a `stopped` or `error` session returns `AB-3002`. (MUST)
- One in-flight turn per session. A `send` during `running` is queued, or rejected with `AB-3003`. Queueing is the default; `queueing: false` switches to rejection. (MUST)

### 13.3 Session operations

| Operation | Description | Level |
| --- | --- | --- |
| `createSession` | Create with provider, working directory, MCP set, and permission mode | MUST |
| `getSession` | Read a single session | MUST |
| `listSessions` | List with status and provider filters | MUST |
| `sendMessage` | Deliver a user message | MUST |
| `interrupt` | Interrupt the current turn, keep the session | MUST |
| `resume` | Restart a stopped or failed session | MUST |
| `stopSession` | Terminate the session and reclaim the process | MUST |
| `updateMcp` | Change MCP bindings on a live session | SHOULD |
| `setPermissionMode` | Change the permission mode on a live session | SHOULD |

### 13.4 Working directory

- When `workingDirectory` is set at creation, it becomes the CLI process `cwd`. (MUST)
- When absent, the runtime's default working directory applies. (MUST)
- A non-existent path fails session creation with `AB-3005`. (MUST)
- The working directory serves as the default permission scope boundary for filesystem tools. (SHOULD)

### 13.5 Environment variables

```text
Merge order (lowest to highest)
1. runtime process environment
2. provider defaults from global config
3. per-provider env
4. env passed at session creation
```

- MCP servers own their `env` independently of session env. Neither inherits from the other. (MUST)
- Secrets such as API keys should be referenced as `secret://<key>` rather than written in plaintext config. (SHOULD)

---

## 14. SDK API specification

### 14.1 Entry point

```typescript
import { AgentBridge } from "@jeonhui/agentbridge";

const agent = new AgentBridge(config?: AgentBridgeConfig);

await agent.start();   // initialize storage, connect MCP presets, register built-in tools
await agent.stop();    // tear down every session, MCP connection, and process
```

```typescript
export interface AgentBridgeConfig {
  dataDir?: string;                     // defaults to ~/.agentbridge
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  defaultPermissionMode?: PermissionMode;      // defaults to "ask"
  approvalTimeoutMs?: number;                  // defaults to 120000
  providers?: Record<string, ProviderConfig>;
  mcpServers?: McpServerConfig[];              // registered at startup
  workingDirectory?: string;
}
```

### 14.2 Providers namespace

```typescript
interface ProvidersApi {
  list(): Promise<ProviderInfo[]>;                 // all registered adapters plus detection
  detect(id?: string): Promise<ProviderDetection | ProviderInfo[]>;
  register(provider: AgentProvider): void;         // register a custom adapter
  get(id: string): ProviderInfo | undefined;
}

interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  executablePath?: string;
  capabilities: ProviderCapabilities;
  reason?: string;
}
```

### 14.3 Sessions namespace

```typescript
interface SessionsApi {
  create(options: CreateSessionOptions): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  list(filter?: SessionFilter): Promise<AgentSession[]>;
  stop(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<Session>;
}

interface CreateSessionOptions {
  provider: string;
  workingDirectory?: string;
  mcp?: string[];                  // MCP server ids
  model?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
  title?: string;
  queueing?: boolean;              // defaults to true
}

interface SessionFilter {
  provider?: string;
  status?: SessionStatus | SessionStatus[];
  limit?: number;
  cursor?: string;
}

/** Session facade. Provides session-scoped event subscription. */
interface Session {
  readonly id: string;
  readonly info: AgentSession;

  send(message: string, options?: SendOptions): Promise<SendResult>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  updateMcp(serverIds: string[]): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  tools(): Promise<AgentTool[]>;             // tools visible to this session
  on<E extends AgentEventType>(event: E, handler: (e: AgentEventOf<E>) => void): Unsubscribe;
}

interface SendOptions {
  attachments?: Attachment[];      // extra context such as file paths
  timeoutMs?: number;
}

interface SendResult {
  turnId: string;
  queued: boolean;
}

export interface Attachment {
  type: "file" | "text";
  path?: string;                   // type === "file"
  text?: string;                   // type === "text"
  mimeType?: string;
}

/** Unsubscribe function. Safe to call more than once (idempotent). */
export type Unsubscribe = () => void;
```

### 14.4 MCP namespace

```typescript
interface McpApi {
  add(config: McpServerConfig): Promise<McpServerState>;
  remove(serverId: string): Promise<void>;
  connect(serverId: string): Promise<McpServerState>;
  disconnect(serverId: string): Promise<void>;
  reload(serverId: string): Promise<McpReloadResult>;
  list(): Promise<McpServerState[]>;
  get(serverId: string): Promise<McpServerState | undefined>;
}

interface McpReloadResult {
  serverId: string;
  addedTools: string[];
  removedTools: string[];
  changedTools: string[];
  durationMs: number;
  affectedSessions: string[];
}
```

### 14.5 Tools namespace

```typescript
interface ToolsApi {
  list(filter?: ToolFilter): Promise<AgentTool[]>;
  get(toolId: string): Promise<AgentTool | undefined>;
  call(toolId: string, args: unknown, options?: ToolCallOptions): Promise<ToolCallResult>;
  permissions(toolId: string): Promise<Permission[]>;
}

interface ToolFilter {
  sessionId?: string;              // restrict to tools visible in that session
  source?: "mcp" | "builtin" | "system";
  server?: string;
}

interface ToolCallOptions {
  sessionId?: string;              // permission evaluation context
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ToolCallResult {
  toolId: string;
  ok: boolean;
  content?: unknown;
  error?: AgentBridgeErrorInfo;
  durationMs: number;
}
```

### 14.6 Permissions namespace

```typescript
interface PermissionsApi {
  approve(requestId: string, options?: ApproveOptions): Promise<void>;
  deny(requestId: string, reason?: string): Promise<void>;
  pending(sessionId?: string): Promise<ApprovalRequest[]>;
  setPolicy(rule: PermissionRule): Promise<void>;
  listPolicies(): Promise<PermissionRule[]>;
}

interface ApproveOptions {
  remember?: "once" | "session" | "always";   // defaults to "once"
}
```

### 14.7 API summary

```text
AgentBridge
├── start() / stop()
├── providers  → list() / detect() / register() / get()
├── sessions   → create() / get() / list() / stop() / resume()
├── mcp        → add() / remove() / connect() / disconnect() / reload() / list() / get()
├── tools      → list() / get() / call() / permissions()
├── permissions→ approve() / deny() / pending() / setPolicy() / listPolicies()
└── on(event, handler)   # global event subscription
```

---

## 15. Event system

### 15.1 Common envelope

```typescript
export interface AgentEventBase {
  id: string;            // event ULID
  seq: number;           // monotonic sequence within the session, for reconnect recovery
  sessionId: string;
  turnId?: string;       // identifies one user message and its processing
  timestamp: string;     // ISO 8601
}

export type AgentEventType =
  | "message"
  | "tool_call"
  | "tool_progress"
  | "tool_result"
  | "tool_error"
  | "status"
  | "permission_request"
  | "mcp_status"
  | "error";
```

### 15.2 Payloads

```typescript
export interface MessageEvent extends AgentEventBase {
  type: "message";
  role: "assistant" | "user" | "system";
  content: string;          // delta or complete text
  delta: boolean;           // true for a partial chunk
  done: boolean;            // whether this message is complete
}

export interface ToolCallEvent extends AgentEventBase {
  type: "tool_call";
  callId: string;
  tool: string;             // e.g. "filesystem.read"
  toolId: string;           // registry-wide id
  arguments: unknown;       // subject to redaction when logged
  source: ToolSource;
}

export interface ToolProgressEvent extends AgentEventBase {
  type: "tool_progress";
  callId: string;
  tool: string;
  progress?: number;        // 0–1
  message?: string;
}

export interface ToolResultEvent extends AgentEventBase {
  type: "tool_result";
  callId: string;
  tool: string;
  ok: true;
  content: unknown;
  durationMs: number;
}

export interface ToolErrorEvent extends AgentEventBase {
  type: "tool_error";
  callId: string;
  tool: string;
  ok: false;
  error: AgentBridgeErrorInfo;
  durationMs: number;
}

export interface StatusEvent extends AgentEventBase {
  type: "status";
  status: SessionStatus;
  previous: SessionStatus;
  reason?: string;
}

export interface PermissionRequestEvent extends AgentEventBase {
  type: "permission_request";
  requestId: string;
  tool: string;
  toolId: string;
  arguments: unknown;
  permissions: Permission[];
  expiresAt: string;        // timeout instant
}

export interface McpStatusEvent extends AgentEventBase {
  type: "mcp_status";
  serverId: string;
  state: McpConnectionState;
  toolCount?: number;
  error?: AgentBridgeErrorInfo;
}

export interface ErrorEvent extends AgentEventBase {
  type: "error";
  error: AgentBridgeErrorInfo;
  fatal: boolean;           // true moves the session to error
}

export interface AgentBridgeErrorInfo {
  code: string;             // e.g. "AB-2101"
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "reloading"
  | "disconnected"
  | "error";

/** Discriminated union of every event. Defined in packages/core/events/types.ts. */
export type AgentEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StatusEvent
  | PermissionRequestEvent
  | McpStatusEvent
  | ErrorEvent;

/** Narrows the payload type from an event type string. */
export type AgentEventOf<E extends AgentEventType> = Extract<AgentEvent, { type: E }>;
```

### 15.3 Subscription contract

```typescript
agent.on("message", (e) => { /* every session */ });
session.on("tool_call", (e) => { /* this session only */ });

const off = session.on("status", handler);
off();   // unsubscribe
```

- Ordering is guaranteed within a session. Ordering across sessions is not. (MUST)
- An exception thrown by one subscriber never reaches another. (MUST)
- `seq` starts at 1 when the session is created and continues across resume. (MUST)
- Backpressure: keep a ring buffer per slow subscriber (1000 entries by default); beyond that, drop the oldest events and report `error` (`AB-5002`). (SHOULD)

---

## 16. Runtime REST API

### 16.1 Conventions

| Aspect | Value |
| --- | --- |
| Default binding | `http://127.0.0.1:8760` (configurable) |
| Authentication | `Authorization: Bearer <localToken>` required. The token is generated at startup and written to `~/.agentbridge/runtime.json` (mode 0600) |
| Content type | `application/json; charset=utf-8` |
| Error body | `{ "error": { "code", "message", "details", "retryable" } }` |
| Status codes | 200 OK, 201 created, 202 accepted (async), 204 no content, 400 validation, 401 auth, 404 missing, 409 state conflict, 408 timeout, 500 internal |
| Pagination | `?limit=&cursor=` with `{ items, nextCursor }` |

### 16.2 Endpoints

| # | Method | Path | Request body | Response | Notable errors |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | `/health` | – | `{ status, version, uptimeMs }` | – |
| 2 | GET | `/providers` | – | `{ items: ProviderInfo[] }` | 500 |
| 3 | POST | `/providers/detect` | `{ id? }` | `{ items: ProviderInfo[] }` | 500 |
| 4 | GET | `/sessions` | – (query `provider`,`status`,`limit`,`cursor`) | `{ items: AgentSession[], nextCursor }` | – |
| 5 | POST | `/sessions` | `CreateSessionOptions` | 201 `AgentSession` | 400 `AB-3001`/`AB-3005`, 404 `AB-1002`, 502 `AB-1003` |
| 6 | GET | `/sessions/:id` | – | `AgentSession` | 404 `AB-3004` |
| 7 | POST | `/sessions/:id/messages` | `{ message, attachments?, timeoutMs? }` | 202 `{ turnId, queued }` | 404 `AB-3004`, 409 `AB-3002` |
| 8 | POST | `/sessions/:id/interrupt` | – | 204 | 404, 409 `AB-3006` |
| 9 | POST | `/sessions/:id/resume` | – | 200 `AgentSession` | 404, 409 |
| 10 | DELETE | `/sessions/:id` | – | 204 | 404 |
| 11 | PATCH | `/sessions/:id/mcp` | `{ servers: string[] }` | 200 `AgentSession` | 404, 400 `AB-2004` |
| 12 | PATCH | `/sessions/:id/permission-mode` | `{ mode }` | 200 `AgentSession` | 404, 400 |
| 13 | GET | `/sessions/:id/events` | – (query `sinceSeq`,`limit`) | `{ items: AgentEvent[] }` | 404 |
| 14 | GET | `/mcp` | – | `{ items: McpServerState[] }` | – |
| 15 | POST | `/mcp` | `McpServerConfig` | 201 `McpServerState` | 400 `AB-2001`, 409 `AB-2002` |
| 16 | GET | `/mcp/:id` | – | `McpServerState` | 404 `AB-2003` |
| 17 | DELETE | `/mcp/:id` | – | 204 | 404, 409 (requires `force=true` when sessions still use it) |
| 18 | POST | `/mcp/:id/connect` | – | 200 `McpServerState` | 404, 502 `AB-2101` |
| 19 | POST | `/mcp/:id/disconnect` | – | 204 | 404 |
| 20 | POST | `/mcp/:id/reload` | – | 200 `McpReloadResult` | 404, 502 `AB-2102` |
| 21 | GET | `/tools` | – (query `sessionId`,`source`,`server`) | `{ items: AgentTool[] }` | – |
| 22 | GET | `/tools/:id` | – | `AgentTool` | 404 `AB-2201` |
| 23 | POST | `/tools/:id/call` | `{ arguments, sessionId?, timeoutMs? }` | 200 `ToolCallResult` | 403 `AB-4001`, 408 `AB-4003`, 502 `AB-2202` |
| 24 | GET | `/permissions/pending` | – (query `sessionId`) | `{ items: ApprovalRequest[] }` | – |
| 25 | POST | `/permissions/:requestId/approve` | `{ remember? }` | 204 | 404 `AB-4002`, 409 (already decided) |
| 26 | POST | `/permissions/:requestId/deny` | `{ reason? }` | 204 | 404, 409 |
| 27 | GET | `/permissions/policies` | – | `{ items: PermissionRule[] }` | – |
| 28 | PUT | `/permissions/policies` | `PermissionRule` | 200 `PermissionRule` | 400 |

The mapping to the SDK is 1:1 with a single exception: `providers.register()`. Registering a custom provider requires injecting code, so it is not exposed over REST. To use a custom provider with the runtime, load the adapter package when the runtime starts. (MUST)

### 16.3 Example exchange

```http
POST /sessions HTTP/1.1
Host: 127.0.0.1:8760
Authorization: Bearer ab_local_9f3c...
Content-Type: application/json

{
  "provider": "claude",
  "workingDirectory": "/workspace/project",
  "mcp": ["filesystem", "github"],
  "permissionMode": "ask"
}
```

```json
{
  "id": "01J8ZK9M4Q7B2N5X",
  "provider": "claude",
  "workingDirectory": "/workspace/project",
  "status": "ready",
  "mcpServers": ["filesystem", "github"],
  "permissionMode": "ask",
  "createdAt": "2026-08-15T09:12:03.114Z",
  "updatedAt": "2026-08-15T09:12:04.902Z"
}
```

### 16.4 IPC channel

- Support a Unix domain socket (`~/.agentbridge/runtime.sock`) and a Windows named pipe (`\\.\pipe\agentbridge`). (SHOULD)
- IPC messages use the same JSON structure as the WebSocket frames in chapter 17. (MUST)
- For IPC, filesystem permissions (0600) stand in for token authentication. (MUST)

---

## 17. Runtime WebSocket protocol

### 17.1 Connection

```text
ws://127.0.0.1:8760/events?token=<localToken>
```

- The token may travel in the query string or the `Sec-WebSocket-Protocol` header. (MUST)
- The server sends a `ready` frame immediately after connecting. (MUST)

### 17.2 Frame format

Every frame is a JSON object carrying a `t` (type) field.

```typescript
// client → server
type ClientFrame =
  | { t: "subscribe"; sessionIds?: string[]; events?: AgentEventType[]; sinceSeq?: number }
  | { t: "unsubscribe"; sessionIds?: string[] }
  | { t: "ping"; ts: number };

// server → client
type ServerFrame =
  | { t: "ready"; runtimeVersion: string; serverTime: string }
  | { t: "event"; event: AgentEvent }
  | { t: "subscribed"; sessionIds: string[] }
  | { t: "pong"; ts: number }
  | { t: "error"; error: AgentBridgeErrorInfo };
```

### 17.3 Subscription rules

- Omitting `sessionIds` subscribes to every session. (MUST)
- Omitting `events` receives every event type. (MUST)
- With `sinceSeq`, the server replays retained events from that point. If the request falls outside retention, it sends `AB-5003` and resumes from the present. (MUST)
- Session creation and termination are reflected without re-subscribing when subscribed globally. (SHOULD)

### 17.4 Heartbeat and reconnection

| Aspect | Rule |
| --- | --- |
| Heartbeat | The server sends a WebSocket ping every 30s; clients may also use the application-level `{t:"ping"}` |
| Timeout | The server closes the connection if no pong arrives within 60s |
| Reconnection | Clients retry with exponential backoff (1s → 2s → 4s → 8s, capped at 30s) |
| Recovery | On reconnect, send the last received `seq` as `sinceSeq` to recover the gap |
| Retention | The most recent 1000 events per session, or 24 hours (configurable) |

### 17.5 Frame examples

```json
{"t":"subscribe","sessionIds":["01J8ZK9M4Q7B2N5X"],"sinceSeq":42}
```

```json
{"t":"event","event":{"id":"01J8ZKA1...","seq":43,"sessionId":"01J8ZK9M4Q7B2N5X",
 "turnId":"t_02","timestamp":"2026-08-15T09:12:31.552Z","type":"tool_call",
 "callId":"c_11","tool":"filesystem.read","toolId":"mcp:filesystem:read",
 "arguments":{"path":"/workspace/project/README.md"},
 "source":{"type":"mcp","server":"filesystem"}}}
```

---

## 18. Error code scheme

### 18.1 Code format

Codes take the form `AB-<domain><number>`.

| Range | Domain |
| --- | --- |
| AB-1xxx | Provider |
| AB-2xxx | MCP / tool |
| AB-3xxx | Session |
| AB-4xxx | Permission |
| AB-5xxx | Runtime / transport |
| AB-6xxx | Storage / config |

### 18.2 Code table

| Code | Meaning | Retryable | Response |
| --- | --- | --- | --- |
| AB-1001 | Unknown provider id | No | Check `providers.list()` |
| AB-1002 | Provider not installed or detection failed | No | Install the CLI and re-run `detect()` |
| AB-1003 | Provider process failed to start | Yes | Verify the executable path and permissions |
| AB-1004 | Failed to parse provider output | Yes | Check CLI version compatibility |
| AB-1005 | Provider does not support the requested capability | No | Inspect `capabilities` and take an alternative path |
| AB-1006 | Provider process exited unexpectedly | Yes | Try `resume` on the session |
| AB-1007 | Duplicate provider id at registration | No | Register the custom adapter under a different id |
| AB-2001 | MCP configuration validation failed | No | Check the transport's required fields |
| AB-2002 | Duplicate MCP server id | No | Use a different id |
| AB-2003 | MCP server not found | No | Check `mcp.list()` |
| AB-2004 | MCP server cannot be bound to the session | No | Check the server's connection state |
| AB-2101 | MCP connection failed | Yes | Verify the command, URL, and environment |
| AB-2102 | MCP hot reload failed | Yes | Previous connection retained; check logs |
| AB-2103 | MCP initialize failed (protocol mismatch) | No | Check the MCP SDK version |
| AB-2104 | MCP connection lost | Yes | Wait for automatic reconnection |
| AB-2201 | Tool not found | No | Check `tools.list()` |
| AB-2202 | Tool execution failed (server error) | Yes | Check the MCP server logs |
| AB-2203 | Tool input schema validation failed | No | Check `inputSchema` |
| AB-2204 | Tool execution timed out | Yes | Adjust `timeoutMs` |
| AB-2205 | Tool name conflict | No | Use a server prefix |
| AB-3001 | Session options validation failed | No | Check required fields |
| AB-3002 | Operation on a terminated session | No | `resume` first, then retry |
| AB-3003 | Session already running (queueing disabled) | Yes | Wait for completion or `interrupt` |
| AB-3004 | Session not found | No | Check `sessions.list()` |
| AB-3005 | Working directory is not accessible | No | Verify the path and permissions |
| AB-3006 | Nothing to interrupt | No | Check the session status |
| AB-3007 | Session cannot be resumed (provider limitation) | No | Create a new session |
| AB-4001 | Permission denied | No | Change the policy or approve |
| AB-4002 | Approval request not found or expired | No | Wait for a fresh request |
| AB-4003 | Approval wait timed out | Yes | Adjust the timeout |
| AB-4004 | Permission rule validation failed | No | Check the rule syntax |
| AB-5001 | Authentication failed | No | Check the local token |
| AB-5002 | Events dropped due to backpressure | Yes | Improve subscriber throughput |
| AB-5003 | Requested `sinceSeq` is beyond retention | No | Re-fetch full state |
| AB-5004 | Request body validation failed | No | Check the schema |
| AB-5005 | Runtime is not running | Yes | Verify the daemon is up |
| AB-6001 | Storage initialization failed | Yes | Check data directory permissions |
| AB-6002 | State document is corrupt | No | Quarantined automatically; inspect the .corrupt file |
| AB-6003 | Config file parsing failed | No | Check the syntax |
| AB-6004 | Secret store access failed | Yes | Check OS keychain permissions |

### 18.3 Error class

```typescript
export class AgentBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryable: boolean = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentBridgeError";
  }

  toJSON(): AgentBridgeErrorInfo {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}
```

- Every public API throws `AgentBridgeError` or reports through an `error` event rather than throwing arbitrary exceptions. (MUST)
- The originating exception is preserved in `cause` but excluded from external serialization. (MUST)
---

## 19. Data models

### 19.1 Model overview

| Model | Description | Persisted |
| --- | --- | --- |
| `AgentSession` | Session metadata and state | Yes |
| `ProviderConfig` | Per-provider execution options | Yes (`config.json`) |
| `McpServerConfig` | MCP server registration | Yes |
| `McpServerState` | MCP runtime connection state | Partially (metadata only) |
| `AgentTool` | Unified tool index entry | Cached |
| `PermissionRule` | Permission policy rule | Yes |
| `ApprovalRequest` | Approval request | Yes (for audit) |
| `EventRecord` | Event metadata record | Yes (redacted) |
| `TurnRecord` | Per-turn execution record | Yes |

### 19.2 AgentSession

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (ULID) | Yes | Session identifier |
| `provider` | string | Yes | Provider id |
| `title` | string | No | Display label |
| `workingDirectory` | string | No | Absolute path |
| `status` | SessionStatus | Yes | Current state |
| `mcpServers` | string[] | Yes | Bound MCP ids (empty array allowed) |
| `model` | string | No | Provider model selection |
| `env` | Record<string,string> | No | Session environment (secrets as references) |
| `permissionMode` | "ask"\|"allow"\|"deny" | Yes | Permission mode |
| `nativeSessionId` | string | No | Provider-native session id |
| `createdAt` | ISO datetime | Yes | Creation time |
| `updatedAt` | ISO datetime | Yes | Last update time |
| `lastError` | AgentBridgeErrorInfo | No | Most recent error |

### 19.3 McpServerConfig

```typescript
export type McpTransport = "stdio" | "sse" | "streamable-http";

export interface McpServerConfigBase {
  id: string;                       // unique identifier (^[a-z0-9][a-z0-9._-]*$)
  name?: string;
  transport: McpTransport;
  enabled?: boolean;                // defaults to true
  autoConnect?: boolean;            // defaults to true
  toolPrefix?: string;              // avoids tool name collisions
  timeoutMs?: number;               // defaults to 30000
  retry?: { maxAttempts: number; backoffMs: number };   // defaults to {3, 1000}
}

export interface StdioMcpConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;                  // e.g. "node"
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  watch?: WatchConfig;              // hot reload
}

export interface SseMcpConfig extends McpServerConfigBase {
  transport: "sse";
  url: string;                      // SSE endpoint
  headers?: Record<string, string>;
}

export interface StreamableHttpMcpConfig extends McpServerConfigBase {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  sessionHeader?: string;           // defaults to "Mcp-Session-Id"
}

export interface WatchConfig {
  enabled: boolean;
  paths?: string[];                 // defaults to cwd or the script path in args
  ignore?: string[];                // defaults to excluding node_modules, .git, build output
  debounceMs?: number;              // defaults to 300
}

export type McpServerConfig = StdioMcpConfig | SseMcpConfig | StreamableHttpMcpConfig;
```

### 19.4 McpServerState

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Server id |
| `config` | McpServerConfig | Registered config with secrets masked |
| `state` | McpConnectionState | connecting / connected / reloading / disconnected / error |
| `toolCount` | number | Number of discovered tools |
| `tools` | string[] | Tool names |
| `serverInfo` | `{ name, version, protocolVersion }` | initialize response |
| `connectedAt` | ISO datetime | Most recent connection |
| `lastError` | AgentBridgeErrorInfo | Most recent error |
| `boundSessions` | string[] | Sessions using this server |

```typescript
export interface McpServerState {
  id: string;
  config: McpServerConfig;            // copy with secret fields replaced by "***"
  state: McpConnectionState;
  toolCount: number;
  tools: string[];
  serverInfo?: { name: string; version: string; protocolVersion: string };
  connectedAt?: string;
  lastError?: AgentBridgeErrorInfo;
  boundSessions: string[];
}
```

### 19.5 AgentTool

```typescript
export interface AgentTool {
  id: string;                       // "{source}:{server}:{name}", globally unique
  name: string;                     // name exposed to the agent
  description: string;
  source: ToolSource;
  inputSchema: unknown;             // JSON Schema
  outputSchema?: unknown;
  permissions: Permission[];        // derived from the mapping rules
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
  discoveredAt: string;
}

export interface ToolSource {
  type: "mcp" | "builtin" | "system";
  server?: string;                  // MCP server id when type === "mcp"
}
```

### 19.6 PermissionRule and ApprovalRequest

```typescript
export type Permission = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "SYSTEM";
export type PermissionMode = "ask" | "allow" | "deny";

export interface PermissionRule {
  id: string;
  match: {
    toolId?: string;                // exact match
    toolPattern?: string;           // glob, e.g. "mcp:filesystem:*"
    permission?: Permission;
    sessionId?: string;
    provider?: string;
    pathScope?: string;             // restricts argument paths, e.g. "/workspace/**"
  };
  effect: "allow" | "deny" | "ask";
  priority: number;                 // higher wins
  expiresAt?: string;               // used by "session" and "always" memory
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId?: string;
  callId: string;
  toolId: string;
  tool: string;
  arguments: unknown;
  permissions: Permission[];
  requestedAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  decidedBy?: string;               // external app identifier
  reason?: string;
}
```

### 19.7 EventRecord and TurnRecord

| Model | Fields | Description |
| --- | --- | --- |
| `EventRecord` | `id`, `seq`, `sessionId`, `turnId`, `type`, `payloadDigest`, `payloadRedacted`, `createdAt` | Stores a redacted payload and a digest instead of the raw payload |
| `TurnRecord` | `id`, `sessionId`, `startedAt`, `endedAt`, `status`, `toolCallCount`, `errorCode` | Per-turn execution statistics |

### 19.8 ProviderConfig

Per-provider execution defaults. When a session omits an option, these values apply. Because this is user configuration, it lives in `~/.agentbridge/config.json` rather than the state directory, and has no repository of its own.

```typescript
export interface ProviderConfig {
  enabled?: boolean;                    // defaults to true; false excludes it from detection
  executablePath?: string;              // use this binary instead of a PATH lookup
  defaultModel?: string;
  defaultSystemPrompt?: string;
  env?: Record<string, string>;         // secrets as secret:// references
  args?: string[];                      // appended to the adapter's default arguments
  defaultMcp?: string[];                // MCP servers bound by default at session creation
  startTimeoutMs?: number;              // defaults to 30000
  detectTimeoutMs?: number;             // defaults to 3000
}
```

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | No | `true` | When false, `providers.list()` reports `available: false` with `reason: "disabled"` |
| `executablePath` | string | No | – | Skips PATH discovery when set |
| `defaultModel` | string | No | – | Used when the session omits `model` |
| `defaultSystemPrompt` | string | No | – | Used when the session omits `systemPrompt` |
| `env` | Record<string,string> | No | `{}` | Merge order follows 13.5 |
| `args` | string[] | No | `[]` | Appended after the adapter's own arguments |
| `defaultMcp` | string[] | No | `[]` | Used when the session omits `mcp` |
| `startTimeoutMs` | number | No | `30000` | Process start deadline. Exceeding it yields `AB-1003` |
| `detectTimeoutMs` | number | No | `3000` | Detection deadline. Exceeding it yields `available: false` |

---

## 20. Storage

### 20.1 Layout on disk

```text
~/.agentbridge/
├── config.json           # user configuration
├── state/
│   ├── sessions.json     # session metadata
│   ├── mcp.json          # registered MCP servers (secrets masked)
│   └── permissions.json  # permission rules
├── audit/
│   └── approvals-YYYY-MM.jsonl   # append-only approval decisions
├── runtime.json          # local token and port (0600)
├── logs/
│   └── agentbridge-YYYY-MM-DD.log
└── tmp/
    └── session-<id>/     # per-session MCP config files and other scratch output
```

### 20.2 Storage interface

Persistence sits behind one interface so the backend can change without touching the managers.

```typescript
export interface Storage {
  sessions: Repository<AgentSession>;
  mcpServers: Repository<McpServerConfig>;
  permissionRules: Repository<PermissionRule>;
  /** Append-only; approval decisions are never edited after the fact. */
  appendApproval(record: ApprovalRequest): Promise<void>;
  listApprovals(filter?: { sessionId?: string; since?: string }): Promise<ApprovalRequest[]>;
}

export interface Repository<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  put(value: T): Promise<void>;
  delete(id: string): Promise<void>;
}
```

Two backends ship:

| Backend | When to use | Notes |
| --- | --- | --- |
| `MemoryStorage` | Embedded Mode, tests | Default. Nothing survives the host process, which matches a library embedded in an app |
| `FileStorage` | Local Runtime Mode | JSON documents written atomically (write to a temp file, then rename). Approvals append to JSONL |

### 20.3 Why not SQLite in the MVP

The MVP does not use a database. Measured against what is actually stored, a relational engine buys nothing:

| Data | Volume | Access pattern |
| --- | --- | --- |
| Sessions | Tens | Read all at startup, write on state change |
| MCP servers | Tens | Read all at startup, write on registration |
| Permission rules | Tens to hundreds | Read all, evaluate in memory |
| Approval audit | Thousands per month | Append only, read rarely |

The one workload that would justify a database is a persisted event log — at 100 events per second that is millions of rows. But events are already retained in memory per session (1000 entries, spec 17.4) for reconnect replay, and the persisted copy exists only for audit and debugging. Dropping it from the MVP removes the need for a database, a migration system, and a native dependency.

Add a database when one of these becomes true:

- Persisted event history is required for audit or analytics.
- Several runtime processes must share state concurrently.
- Session or rule counts grow past what a full-file rewrite can handle comfortably.

At that point use `node:sqlite`, built into Node 22 and later, so the dependency count stays at zero. The `Storage` interface above is the seam that makes the swap local.

### 20.4 What is and is not stored

| Category | Items |
| --- | --- |
| Stored | Session metadata and state, MCP registrations (masked), permission rules, approval audit records |
| Not stored | User message bodies, assistant response bodies, raw tool arguments and results, plaintext API keys and tokens, the event stream |
| Held in memory only | Event ring buffer per session, tool registry index, live connection state |

### 20.5 Durability rules

- Every document write is atomic: serialize to a temp file in the same directory, then rename over the target. A crash mid-write leaves the previous version intact. (MUST)
- State files are written with mode 0600, since they name working directories and MCP commands. (MUST)
- A corrupt state file is quarantined by renaming it to `<name>.corrupt-<timestamp>` and starting from empty rather than refusing to boot, with `AB-6001` logged. (SHOULD)
- Approval audit records are append-only. Rotation is monthly by filename. (MUST)

## 21. MCP specification

### 21.1 From registration to use

```text
mcp.add(config)
   │  1) validate schema (per-transport required fields)
   │  2) check id uniqueness
   │  3) persist to mcp_servers, state = "connecting"
   ▼
create transport (stdio | sse | streamable-http)
   │  stdio: spawn a child process (cwd/env applied)
   │  sse/http: establish the HTTP connection (headers applied)
   ▼
initialize request/response
   │  exchange protocolVersion, capabilities, serverInfo
   │  failure → AB-2103, state = "error"
   ▼
tools/list (tool discovery)
   │  supports cursor pagination
   ▼
apply to the Tool Registry
   │  id: mcp:{serverId}:{toolName}
   │  apply the permission mapping rules (25.2)
   │  on name collision apply toolPrefix; if unresolved, AB-2205
   ▼
emit mcp_status (state = "connected", toolCount)
   ▼
if bound to sessions, inject or refresh the provider's MCP configuration
```

### 21.2 Transport configuration

| Transport | Required | Optional | Connection management |
| --- | --- | --- | --- |
| `stdio` | `command` | `args`, `cwd`, `env`, `watch` | Child process lifecycle, stderr collection, SIGTERM then SIGKILL after 5s |
| `sse` | `url` | `headers` | EventSource connection with backoff on disconnect |
| `streamable-http` | `url` | `headers`, `sessionHeader` | Maintains the session header, streams requests and responses |

### 21.3 Connection policy

- Connection failures retry with exponential backoff up to `retry.maxAttempts`. On final failure the server stays at `state="error"` without affecting other servers or sessions. (MUST)
- On disconnect (`AB-2104`), reconnect automatically and re-run tool discovery to refresh the registry. (MUST)
- `mcp.remove` returns 409 while sessions are still bound; only `force=true` detaches it, notifying those sessions with `mcp_status(disconnected)`. (MUST)
- Every MCP server process is reclaimed when AgentBridge shuts down. No orphans. (MUST)

### 21.4 Per-session binding

```typescript
const a = await agent.sessions.create({
  provider: "claude",
  mcp: ["filesystem", "github", "pencil"],
});

const b = await agent.sessions.create({
  provider: "codex",
  mcp: ["filesystem", "github"],
});
```

```text
Claude session A          Codex session B
 ├── filesystem            ├── filesystem
 ├── github                └── github
 └── pencil
```

- One MCP server connection is shared across sessions (a single process). For isolation, register the same server twice under different ids. (MUST)
- A session's visible tool set is the bound servers' tools plus the built-in tools. (MUST)
- When a provider reports `capabilities.mcp === false`, tool calls in that session are only possible through the AgentBridge MCP Server, and creation emits a warning event. (SHOULD)

---

## 22. MCP hot reload

### 22.1 Purpose

Apply MCP server code changes without restarting the agent session. This is the core of the MCP development loop.

### 22.2 Triggers

| Trigger | Condition | Notes |
| --- | --- | --- |
| File change | `watch.enabled === true` and a file under `paths` changes | 300ms debounce by default |
| Explicit call | `mcp.reload(serverId)` / `POST /mcp/:id/reload` | Works without watch configured |
| Recovery | Automatic reconnection after an abnormal exit | Re-runs discovery |

### 22.3 Procedure

```text
change detected (debounced)
      ▼
state = "reloading", emit mcp_status
      ▼
handle in-flight tool calls
  ├─ wait for completion (default, graceMs 5000)
  └─ cancel past the grace period and return AB-2204
      ▼
begin queueing new requests (queueLimit 50; beyond that, AB-2202)
      ▼
close the existing connection (stdio: SIGTERM → 5s → SIGKILL)
      ▼
restart the MCP server and initialize
      ▼
re-run tools/list
      ▼
diff the Tool Registry (added / removed / changed)
      ▼
apply to each bound session
  ├─ provider supports live tool refresh: update configuration only
  └─ otherwise: re-inject MCP configuration before the next turn
      ▼
drain the queued requests
      ▼
state = "connected", emit mcp_status and McpReloadResult
```

### 22.4 Failure and rollback

| Failure point | Handling |
| --- | --- |
| Restart fails (process will not start) | The old connection is already closed, so `state="error"` and `AB-2102`. Retry with backoff, up to 3 attempts |
| initialize fails | Emit `AB-2103`; queued requests fail with `AB-2202` |
| tools/list fails | Keep the previous tool index, emit an `AB-2102` warning, retry on the next trigger |
| Applied later than 3 seconds | Log a warning; the operation continues |

- A failed reload never terminates a session. Only that server's tools become temporarily unavailable. (MUST)
- Reloads serialize per server. Concurrent reloads for one server collapse into a single run. (MUST)
- Target latency from detection to registry refresh is 3 seconds. (SHOULD)

### 22.5 Applying to sessions

| Provider support | Strategy |
| --- | --- |
| Live MCP reconfiguration | Request reconfiguration immediately; applies to the current turn |
| Config-file based only | Rewrite the session's temp MCP config and apply at the next turn start. A `status` event explains the delay |

---

## 23. AgentBridge MCP Server (bidirectional)

### 23.1 Structure

AgentBridge is both an MCP client and an MCP server.

```text
             AgentBridge
            /            \
     MCP client        MCP server
          │                 │
          ▼                 ▼
   External MCP      External / connected agent
```

- **MCP client**: AgentBridge consumes external MCP servers (Pencil, GitHub, internal servers).
- **MCP server**: external agents consume the tools AgentBridge provides.

### 23.2 How the server is exposed

| Aspect | Value |
| --- | --- |
| Transport | stdio (default) and streamable-http (optional) |
| Launch | `agentbridge mcp-server`, or the runtime's `/mcp-server` endpoint |
| Authentication | stdio relies on process launch rights; HTTP uses the local token |
| Consumers | External Claude/Gemini/Codex and other MCP clients |

### 23.3 Tools provided in the MVP

| Tool | Permission | Description |
| --- | --- | --- |
| `agentbridge.providers.list` | READ | List providers detected locally |
| `agentbridge.sessions.list` | READ | List sessions |
| `agentbridge.sessions.create` | EXECUTE | Create a new agent session |
| `agentbridge.sessions.send` | EXECUTE | Send a message to a session and return the response |
| `agentbridge.sessions.stop` | EXECUTE | Stop a session |
| `agentbridge.mcp.list` | READ | List registered MCP servers and their tools |
| `agentbridge.tools.call` | Inherits the target tool's | Invoke a registered tool on behalf of the caller |
| `agentbridge.filesystem.read` | READ | Read a file inside the allowed scope |
| `agentbridge.filesystem.write` | WRITE | Write a file inside the allowed scope |
| `agentbridge.process.exec` | EXECUTE | Run a command from an allowlist |

Phase 2 adds `desktop.*` and `browser.*` tools.

### 23.4 Recursion guard

- Track call depth (`X-AgentBridge-Depth`, carried in MCP metadata) so a session AgentBridge created cannot call back into the AgentBridge MCP Server indefinitely. Reject beyond a default maximum depth of 2. (MUST)
- `agentbridge.sessions.send` caps its synchronous wait at 120 seconds by default. (MUST)

---

## 24. Tool Registry

### 24.1 Role

Indexes every tool in one place regardless of origin. The agent never needs to know where a tool came from.

### 24.2 Identifier rules

```text
{sourceType}:{server}:{name}

mcp:filesystem:read       → read from the filesystem MCP server
builtin::session_info     → built-in tool (no server)
system::process_list      → system tool
```

- The name exposed to the agent is unique within its server; global collisions are resolved with `toolPrefix`. (MUST)
- When a reload changes a server's tools, the index updates by diff. Calls to removed tools return `AB-2201`. (MUST)

### 24.3 Session-scoped view

```text
session.tools()
  = built-in tools
  + Σ(tools of MCP servers bound to the session)
  - tools permanently denied by policy (optionally hidden)
```

- Whether denied tools are hidden is controlled by `hideDeniedTools`, defaulting to false (listed, but rejected when called). (SHOULD)

---

## 25. Permissions and approval

### 25.1 Permission categories

| Permission | Meaning | Examples |
| --- | --- | --- |
| `READ` | Read local data | `filesystem.read`, `mcp.list` |
| `WRITE` | Modify local data | `filesystem.write`, `filesystem.delete` |
| `EXECUTE` | Run processes or commands | `terminal.execute`, `process.exec` |
| `NETWORK` | Reach the network | `http.fetch`, remote API tools |
| `SYSTEM` | Control system settings or services | Environment changes, starting/stopping services |

### 25.2 Tool-to-permission mapping

Rules apply in priority order.

1. MCP tool annotations win when present. `readOnlyHint: true` implies `READ`; `destructiveHint: true` implies `WRITE`. (MUST)
2. Explicit entries in the mapping table (`mapping.ts`) apply to matching tool ids and patterns. (MUST)
3. Name heuristics: `read|get|list|search|query` → READ, `write|create|update|delete|remove|move` → WRITE, `exec|run|spawn|shell|command` → EXECUTE, `fetch|http|request|download|upload` → NETWORK. (SHOULD)
4. Anything else falls back conservatively to `WRITE` (deny-by-default). (MUST)

```typescript
// example mappings
"mcp:filesystem:read"      → ["READ"]
"mcp:filesystem:write"     → ["WRITE"]
"builtin::terminal.execute"→ ["EXECUTE", "SYSTEM"]
"mcp:github:create_issue"  → ["NETWORK", "WRITE"]
```

### 25.3 Policy evaluation

```typescript
export interface PermissionDecision {
  effect: "allow" | "deny";
  matchedRuleId?: string;             // absent means the session permissionMode applied
  approvalRequestId?: string;         // present when the request went through the ask path
  reason?: string;
}
```

```text
tool call request
   ▼
collect applicable PermissionRules (match conditions)
   ▼
sort by priority descending; take the first rule's effect
   ├─ allow → execute immediately
   ├─ deny  → return AB-4001 and emit tool_error
   └─ ask   → create an ApprovalRequest
   ▼
with no matching rule, fall back to the session permissionMode
   ├─ "allow" → execute
   ├─ "deny"  → reject
   └─ "ask"   → request approval (default)
```

- Rules with `pathScope` extract the path from the tool arguments and glob-match it. Outside the scope, the rule does not match. (MUST)
- WRITE outside the session's `workingDirectory` always falls to `ask` when no rule matches. (SHOULD)

### 25.4 Agent CLI approval and who owns the decision

Agent CLIs carry their own approval prompts. In non-interactive mode those prompts have nobody to
ask, so they resolve to a denial — an MCP tool call simply fails with a permission error even though
the server is connected and the tool was discovered. This was observed with Claude Code: the agent
found the tool, called it twice, and was refused both times.

AgentBridge therefore owns the permission decision and passes the outcome down to the CLI rather
than letting the two systems negotiate:

| Session `permissionMode` | What AgentBridge sends the CLI | Effect |
| --- | --- | --- |
| `allow` | The bound MCP servers, pre-authorized (`preauthorizedMcpServers`) | The agent may call those servers' tools without a CLI prompt |
| `ask` | A permission prompt tool (`permissionPrompt`) | The agent consults AgentBridge before each tool call, and the host decides |
| `deny` | Nothing pre-authorized | Tool calls fail |

Each adapter expresses this in its own CLI's vocabulary; the core never learns the flag names. For
Claude Code that is `--allowedTools mcp__<server>` and `--permission-prompt-tool`.

#### The prompt hook

An agent CLI runs the prompt tool as an MCP server in its own process and blocks on the answer, so
the decision has to cross a process boundary to reach the host:

```text
agent decides to call a tool
   ▼
CLI invokes the permission prompt tool (an MCP server AgentBridge injected)
   ▼
that process POSTs to the approval gateway: loopback, token minted per start
   ▼
PermissionManager.authorize() → permission_request event
   ▼
host approves or denies → { behavior: "allow", updatedInput } | { behavior: "deny", message }
   ▼
the CLI runs or refuses the tool call
```

Rules for the gateway, each of which exists because the agent is blocked while it waits:

- A host failure, a malformed request, or an unreachable gateway all resolve to a denial. Never a
  hang. (MUST)
- The gateway binds to loopback and serves one route, authenticated with a per-start token. (MUST)
- A tool the registry cannot resolve is treated as `WRITE`, matching deny-by-default. (MUST)

Providers advertise support through `capabilities.permissionHook`. Where an adapter does not
implement it, `ask` falls back to the CLI's own prompt, which denies in non-interactive mode; the
limitation is reported rather than hidden. (MUST)

`autoApprove(true)` answers every request without asking. It installs a highest-priority allow rule
rather than a separate switch, so it appears in `listPolicies()` and is lifted the same way it was
set. (SHOULD)

### 25.5 Approval flow

```text
agent → tool call
   ▼
Permission Manager: effect = ask
   ▼
create ApprovalRequest (expiresAt = now + approvalTimeoutMs)
   ▼
emit permission_request, session status → waiting
   ▼
external app: agent.permissions.approve(requestId) / deny(requestId)
   ├─ approve → execute the tool, status → running
   ├─ deny    → AB-4001, emit tool_error, status → running (the agent decides what to do next)
   └─ silence → treated as denial at the timeout, AB-4003
```

- Decisions are promoted to rules according to `remember`: `once` (not stored), `session` (until the session ends), `always` (persisted rule). (MUST)
- Every approval and denial is written to `approval_requests` as an audit record. (MUST)
- A second decision for the same `callId` is rejected with 409. (MUST)

### 25.6 Cancellation

| API | Target | Behavior |
| --- | --- | --- |
| `session.interrupt()` | Current turn | Signals the provider, propagates an AbortSignal to in-flight tool calls, returns to `ready` |
| `tools.call(..., { signal })` | One tool call | Cancels via AbortSignal, yielding `AB-2204` or a cancellation result |
| `session.stop()` | Whole session | Terminates the provider process, expires pending approvals, moves to `stopped` |

- Long-running tools must clean up within 5 seconds of a cancellation signal; beyond that they are force-terminated. (MUST)
- Conversation context survives an interrupt. (MUST)

---

## 26. Security and secret management

### 26.1 Trust boundaries

```text
[trusted]      external app ↔ AgentBridge (local token or IPC permissions)
[semi-trusted] AgentBridge ↔ provider CLI (local process, user privileges)
[untrusted]    MCP servers (external code), tool arguments produced by the agent
```

- Tool arguments produced by an agent are always untrusted input and pass through schema validation and path normalization. (MUST)
- Path arguments are resolved with `path.resolve` and blocked from escaping via `..`. (MUST)

### 26.2 Network exposure

- The runtime binds to `127.0.0.1` only by default. External binding requires explicit configuration and emits a warning. (MUST)
- CORS is disabled by default and enabled only with an explicit origin allowlist. (MUST)
- The token is regenerated on each start and written to `runtime.json` with mode 0600. (MUST)

### 26.3 Secrets

| Aspect | Policy |
| --- | --- |
| API keys and tokens | Prefer OS secure storage (macOS Keychain, Windows Credential Manager, Linux Secret Service) |
| Config references | Use `"env": { "GITHUB_TOKEN": "secret://github/token" }` and resolve at execution time |
| Storage | Never write plaintext secrets to the database or config files |
| Transfer | Pass only through child process env, never on the command line |
| Exposure | Mask secret fields as `"***"` in API responses |

### 26.4 Process isolation

- Every child process (provider, MCP stdio) starts with `detached: false`, and the whole tree is reclaimed at shutdown. (MUST)
- Cap per-process stdout and stderr buffers (10MB by default), truncating with a warning beyond that. (SHOULD)

---

## 27. Logging and observability

### 27.1 Log events

| Event | Level | Required fields |
| --- | --- | --- |
| `agent.started` | info | version, dataDir |
| `provider.detected` | info | providerId, available, version |
| `provider.connected` | info | sessionId, providerId, pid |
| `provider.error` | error | sessionId, providerId, code |
| `session.created` | info | sessionId, provider, mcpServers |
| `session.stopped` | info | sessionId, reason, durationMs |
| `mcp.connected` | info | serverId, transport, toolCount |
| `mcp.reloaded` | info | serverId, added, removed, durationMs |
| `mcp.error` | error | serverId, code |
| `tool.discovered` | debug | serverId, toolName, permissions |
| `tool.called` | info | sessionId, toolId, callId, argsDigest |
| `tool.completed` | info | sessionId, toolId, callId, durationMs, ok |
| `permission.requested` | info | requestId, toolId, permissions |
| `permission.decided` | info | requestId, decision, remember |
| `runtime.request` | debug | method, path, status, durationMs |

### 27.2 Record format

```json
{
  "ts": "2026-08-15T09:12:31.552Z",
  "level": "info",
  "event": "tool.called",
  "sessionId": "01J8ZK9M4Q7B2N5X",
  "turnId": "t_02",
  "toolId": "mcp:filesystem:read",
  "callId": "c_11",
  "argsDigest": "sha256:9c1f...",
  "durationMs": null,
  "traceId": "01J8ZK9Z..."
}
```

### 27.3 Redaction rules

- User message bodies and assistant response bodies are not logged by default. Only length and a digest are recorded. (MUST)
- Tool arguments are logged as key names plus a digest (`argsDigest`). Values appear only when `logging.includeToolArgs: true`. (MUST)
- Values matching `token`, `secret`, `password`, `apiKey`, `authorization`, `cookie`, `credential` are always replaced with `***`. (MUST)
- File paths are recorded with the home directory abbreviated to `~`. (SHOULD)

### 27.4 Level policy

| Level | Use |
| --- | --- |
| `trace` | Raw protocol frames (development only, off by default) |
| `debug` | Internal state transitions, HTTP requests, tool discovery |
| `info` | Lifecycle events (session, MCP, permission, tool calls) |
| `warn` | Retries, backpressure drops, unsupported-capability fallbacks |
| `error` | Failed operations, abnormal process exits |

- Default level is `info`, with daily file rotation and 7-day retention (configurable). (SHOULD)
- Assign a `traceId` per request and per turn to correlate events with logs. (SHOULD)

---

## 28. Non-functional requirements

### 28.1 Performance

| Metric | Target | Conditions |
| --- | --- | --- |
| Runtime startup | Within 1s (excluding MCP auto-connect) | Cold start on SSD |
| Provider detection | Within 3s total | Three adapters in parallel, 3s each |
| Session creation | Within 2s including process start | With 3 MCP servers bound |
| First-token overhead | AgentBridge adds at most 100ms | Compared with running the CLI directly |
| Event delivery latency | Within 20ms p95 over local WebSocket | At 100 events/second |
| Hot reload | Within 3s | Detection to registry refresh |
| Concurrent sessions | 10 or more, stable | Within the memory ceiling |
| Runtime memory | Under 150MB idle | Zero sessions, two MCP connections |

### 28.2 Reliability

- One MCP server's failure never propagates to other MCP servers, sessions, or the runtime. (MUST)
- An abnormal provider exit moves the session to `error` and it must remain resumable. (MUST)
- After a runtime restart, stored session metadata is restored, and where the provider supports it, `resume` continues the conversation. (MUST)
- A top-level handler logs and contains unexpected exceptions so the process does not die. (MUST)

### 28.3 Extensibility

- Adding a provider requires only implementing and registering `AgentProvider`, with no core changes. (MUST)
- Adding a transport requires only implementing the MCP client's transport interface. (MUST)
- Registry lookups stay under 50ms at 1000 tools. (SHOULD)

### 28.4 Compatibility

| Aspect | Support |
| --- | --- |
| OS | macOS 13+, Windows 11, Ubuntu 22.04+ |
| Node.js | 20 LTS or newer (22 LTS recommended) |
| Package manager | pnpm 9+ |
| MCP protocol | Whatever the MCP SDK currently supports, degrading according to the `initialize` negotiation |
| Client languages | Any, through the runtime API |

### 28.5 Observability and testing

- Unit test coverage target is 80%+ for the core, permission, and registry modules. (SHOULD)
- Provider adapters ship contract tests against a mocked CLI. (MUST)
- Acceptance scenarios A–E are runnable as automated integration tests. (MUST)
---

## 29. MVP scope

### 29.1 In scope (Phase 1)

| # | Item | Owning module | Scenario |
| --- | --- | --- | --- |
| 1 | AgentBridge core (bootstrap, event bus) | `packages/core` | A |
| 2 | Provider interface | `packages/provider/core` | A, B, C |
| 3 | Claude provider | `packages/provider/claude` | A, E |
| 4 | Codex provider | `packages/provider/codex` | B |
| 5 | Provider discovery | `packages/provider/core/detect.ts` | A |
| 6 | Agent sessions (create, read, interrupt, resume, stop) | `packages/core/session` | A, B, C |
| 7 | Message streaming | `packages/core/events`, each adapter's `parse()` | A |
| 8 | MCP client (stdio, SSE, streamable HTTP) | `packages/mcp/client` | B, C |
| 9 | MCP server registration and removal | `packages/mcp/manager` | C |
| 10 | MCP tool discovery | `packages/mcp/manager`, `registry` | B, C |
| 11 | Tool Registry | `packages/mcp/registry` | B, C, E |
| 12 | Per-session MCP binding | `packages/core/session`, `mcp/manager` | B, C |
| 13 | MCP hot reload | `packages/mcp/manager/HotReloadWatcher.ts` | D |
| 14 | Permission Manager and approval | `packages/permission` | B |
| 15 | Event system (9 event types) | `packages/core/events` | A–E |
| 16 | Local runtime API (REST + WebSocket) | `packages/runtime`, `apps/runtime` | A–E |
| 17 | AgentBridge MCP Server | `packages/mcp/server` | E |
| 18 | Base logging and redaction | `packages/core/logging` | All |
| 19 | Storage interface with memory and file backends | `packages/core/storage` | All |
| 20 | SDK (embedded and HTTP backends) | `packages/sdk` | A, C |
| 21 | Five examples | `examples/` | A–E |

### 29.2 Out of scope (Phase 2 and later)

| Item | Deferred to |
| --- | --- |
| GUI automation (screenshot, mouse, keyboard, window, app control) | Phase 2 |
| Vision agent | Phase 2 |
| Browser engine | Phase 2 |
| Virtual desktop / virtual agent workspace | Phase 3 |
| Routine | Phase 4 |
| Scheduler, task queue, background agent | Phase 4 |
| MCP marketplace, install, update, versioning, private registry | Phase 4 |
| Cloud sync | Undecided (requires revisiting the local-first principle) |
| Gemini provider | Removed from the MVP — see 33.2 |
| Multi-agent orchestration | Phase 4 |

### 29.3 Definition of done

1. All 22 items in 29.1 are implemented and their unit tests pass.
2. Acceptance scenarios A–E pass as automated tests.
3. Measured results meet the 28.1 targets for hot reload (3s), event delivery (20ms p95), and session creation (2s).
4. All five examples work as documented.
5. The README and this specification match the implemented API signatures.

---

## 30. Roadmap

### 30.1 Phase 1 — MVP (local agent runtime)

| Goal | Deliverables |
| --- | --- |
| Core agent connection, sessions, MCP, and permissions | `@jeonhui/agentbridge`, `provider/*`, `mcp/*`, `permission`, `runtime`, `sdk`, `apps/runtime`, five examples |

Recommended build order:

```text
1)  core skeleton + event bus + storage
2)  provider interface + ClaudeProvider + detection
3)  Session Manager + streaming
4)  MCP client (stdio) + discovery + Tool Registry
5)  per-session MCP binding
6)  Permission Manager + approval
7)  runtime REST/WebSocket + SDK HTTP backend
8)  Codex and Gemini providers
9)  MCP SSE and streamable HTTP transports
10) hot reload
11) AgentBridge MCP Server
12) logging and redaction cleanup + examples and docs
```

### 30.2 Phase 2 — Desktop capability

```text
AgentBridge
 ├── GUI engine
 │   ├── screenshot
 │   ├── mouse
 │   ├── keyboard
 │   ├── window
 │   └── app control
 ├── browser engine
 └── desktop adapter
```

| Goal | Deliverables |
| --- | --- |
| Let agents drive local applications that have no MCP server | `@jeonhui/agentbridge-gui`, `@jeonhui/agentbridge-browser`, expanded AgentBridge MCP Server tools (`desktop.*`, `browser.*`), per-OS permission handling |

### 30.3 Phase 3 — Virtual agent workspace

```text
Agent
 └── virtual desktop
      ├── Chrome
      ├── terminal
      ├── editor
      └── other apps
```

| Goal | Deliverables |
| --- | --- |
| Let agents work in an environment isolated from the user's real desktop | Virtual display and container adapters, workspace lifecycle API, isolation policy |

### 30.4 Phase 4 — Automation and MCP ecosystem

| Area | Deliverables |
| --- | --- |
| Automation | Routine definition format, scheduler, task queue, background agent, long-running sessions |
| MCP ecosystem | Marketplace, install/update/version management, per-MCP permissions, private registry |
| Orchestration | Multi-agent collaboration (inter-session message routing, role assignment) |

---

## 31. Acceptance scenarios

Passing these five scenarios defines the MVP as complete. All of them are implemented as automated tests.

### 31.1 Scenario A — Basic round trip

```text
external program → AgentBridge → Claude → response → external program
```

| Aspect | Detail |
| --- | --- |
| Preconditions | Claude CLI installed and authenticated, AgentBridge running |
| Steps | 1) `providers.list()` reports claude `available: true` 2) `sessions.create({provider:"claude"})` 3) `session.send("what is 1+1?")` 4) receive `message` events |
| Expected | Status moves `starting → ready → running`, at least one `message` event including `done: true`, and a return to `ready` |
| Verification | Snapshot the event sequence, assert the response is non-empty, assert `seq` increases monotonically |

### 31.2 Scenario B — File modification through MCP

```text
external program → AgentBridge → Codex → filesystem MCP → file modified → result returned
```

| Aspect | Detail |
| --- | --- |
| Preconditions | Codex CLI installed, filesystem MCP registered, temp working directory created, `permissionMode: "ask"` |
| Steps | 1) `mcp.add(filesystem)` 2) `sessions.create({provider:"codex", workingDirectory: tmp, mcp:["filesystem"]})` 3) `send("add a title line to README.md")` 4) `approve()` on `permission_request` |
| Expected | `tool_call` (filesystem write family) → `tool_result`, the file actually changes, and a final `message` reports the outcome |
| Verification | Compare the filesystem before and after, assert `tool_result.ok === true`, assert one approval audit record exists |

### 31.3 Scenario C — Internal data lookup through a user MCP server

```text
external program → AgentBridge → second provider → user MCP → company data → result returned
```

**Status: not met.** The scenario exists to prove the MCP path works through a provider other than
the one it was built against, so a passing run needs a second provider that can complete a turn.
Gemini is out of the MVP (33.2) and Codex cannot complete a turn on the development machine, so
neither can carry it today. The MCP path itself is proven by scenario B; what remains unproven is
that it is provider-independent.

| Aspect | Detail |
| --- | --- |
| Preconditions | A second provider able to complete a turn, plus a test internal MCP server returning a fixed dataset |
| Steps | 1) `mcp.add({id:"company", transport:"stdio", command:"node", args:["./company-mcp.js"]})` 2) confirm discovery includes `customer.search` 3) `sessions.create({provider:"<second provider>", mcp:["company"]})` 4) `send("look up customer Hong Gil-dong")` |
| Expected | `tool_call(customer.search)` → `tool_result` carrying the fixed dataset → the response reflects the lookup |
| Verification | `mcp:company:customer.search` exists in the registry, and `tool_result.content` matches the expected record |

### 31.4 Scenario D — MCP hot reload

```text
edit MCP server code → hot reload → tool added → visible to the live session
```

| Aspect | Detail |
| --- | --- |
| Preconditions | A stdio MCP server registered with `watch.enabled: true`, one active session |
| Steps | 1) record the initial tool count (N) 2) add a new tool to the MCP source and save 3) wait for `mcp_status(reloading → connected)` 4) re-read `session.tools()` 5) call the new tool |
| Expected | Tool count becomes N+1 without a session restart, `McpReloadResult.addedTools` contains the new tool, and calling it succeeds |
| Verification | Detection-to-refresh under 3 seconds, session `id` and process `pid` unchanged, no session termination in the `status` events |

### 31.5 Scenario E — Tool execution through the AgentBridge MCP Server

```text
external program → AgentBridge → Claude → AgentBridge MCP Server → AgentBridge tool
```

| Aspect | Detail |
| --- | --- |
| Preconditions | AgentBridge MCP Server running, a Claude session bound to it |
| Steps | 1) register the `agentbridge` MCP server via `mcp.add` 2) bind it at session creation 3) `send("list the MCP servers currently registered")` |
| Expected | `tool_call(agentbridge.mcp.list)` → `tool_result` returns the server list → the response reflects it, with no depth-limit violation |
| Verification | `agentbridge.mcp.list` appears in the tool call log, depth counter reads 1, no recursion occurs |

---

## 32. Risks and mitigations

| # | Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | Agent CLI flags and output formats change between versions | Adapters break entirely | High | Check the version in `detect()` and adjust `capabilities`; run contract tests per CLI version; isolate parse failures as `AB-1004` with a fallback path |
| R2 | A provider does not support dynamic MCP reconfiguration | Hot reload cannot apply immediately | High | Config-file fallback applied at the next turn, with user notification; manage expectations through `capabilities.mcp` |
| R3 | Child process leaks (orphans) | System resource exhaustion | Medium | Track the process tree, clean up on SIGINT/SIGTERM/beforeExit, sweep leftovers at startup |
| R4 | Permission bypass leading to unintended file changes | Data loss | Medium | Deny-by-default, path normalization and scope checks, `ask` by default for destructive tools, mandatory audit logging |
| R5 | Secrets leaking into logs or the database | Security incident | Medium | Do not store by default, mask key patterns, warn when storage is enabled, keep files at 0600 |
| R6 | An MCP server hangs indefinitely | Session stalls | Medium | Tool call timeout (30s default), reload and connect timeouts, AbortSignal propagation |
| R7 | Event floods growing memory | Runtime instability | Medium | Ring buffer limit, backpressure drop with `AB-5002`, retention policy (1000 events / 24h) |
| R8 | Exposing the local runtime port externally | Remote code execution risk | Low | Bind 127.0.0.1 by default, require token authentication, explicit confirmation for external binding |
| R9 | Tool name collisions invoking the wrong tool | Incorrect behavior | Low | Global id scheme, `toolPrefix`, refuse registration with `AB-2205` on conflict |
| R10 | Recursion (AgentBridge → agent → AgentBridge MCP) | Infinite loop | Low | Depth tracking (max 2 by default), synchronous call timeout |
| R11 | Concurrent writers corrupting a state document | Lost state | Low | Atomic write-and-rename, serialized writes per document, quarantine a corrupt file instead of refusing to boot |
| R12 | Cross-platform differences (paths, signals, IPC) | Windows behaves differently | Medium | Named pipe alternative, process termination APIs instead of signals, a three-OS CI matrix |

---

## 33. Open decisions and defaults

Each item should be settled before implementation begins; until then, the default below applies.

| # | Decision | Options | Default |
| --- | --- | --- | --- |
| D1 | Who owns conversation history | Delegate to the provider CLI / AgentBridge keeps its own | Delegate to the provider and resume via `nativeSessionId`. AgentBridge replays the last N turns only where resume is unsupported |
| D2 | Default approval timeout | 60s / 120s / unlimited | 120s, then treated as denial |
| D3 | Event retention limit | 500 / 1000 / 5000 per session | 1000 events plus 24 hours |
| D4 | Runtime default port | Fixed 8760 / ephemeral | Fixed 8760, falling back to an ephemeral port on conflict and recording it in `runtime.json` |
| D5 | Concurrent `send` on one session | Queue / reject | Queue by default; `queueing: false` switches to rejection |
| D6 | Fallback when permission inference fails | READ / WRITE | WRITE (conservative) |
| D7 | MCP process sharing | Global sharing / per-session isolation | Global sharing; register the server twice under different ids when isolation is needed |
| D8 | SDK package name | Use `@jeonhui/agentbridge` directly / go through `@jeonhui/agentbridge/sdk` | External apps should use `@jeonhui/agentbridge/sdk`; documentation shows both |
| D9 | Core implementation language | TypeScript / Rust with napi bindings / Go | **TypeScript, decided** (see 33.1) |
| D10 | Persistence backend | SQLite / JSON documents / memory only | **JSON documents behind a Storage interface, decided** (see 20.3). Memory is the default for Embedded Mode |

### 33.1 Rationale for the core language

A Rust core with napi-rs JavaScript bindings was evaluated and rejected in favor of TypeScript.

The workload is I/O-bound, not CPU-bound. Reading child process stdout, parsing JSON lines, and fanning out WebSocket frames is the whole of it, and most of the latency belongs to the agent CLI's own response time (hundreds of milliseconds to seconds). The 28.1 targets — 100ms first-token overhead, 20ms p95 event delivery, 2s session creation — are met by either choice.

| Aspect | TypeScript / Node | Rust | Assessment |
| --- | --- | --- | --- |
| Stream parsing throughput | Baseline | Several times faster | Only matters above a few thousand events per second |
| Idle daemon memory | 60–150MB | 10–20MB | Rust wins, but acceptable on a developer machine |
| Distributed binary | 80–110MB via Node SEA | 10–15MB | Rust wins |
| MCP SDK maturity | Reference implementation | Official SDK exists but younger | TypeScript wins |
| Agent CLI integration | CLIs are Node-based, so conventions line up | Comparable | TypeScript slightly ahead |
| Embedded Mode | Native | Requires napi-rs (N-API) and a six-target build matrix | TypeScript wins |
| MVP velocity | Ahead | Behind | TypeScript wins |

**This decision is reversible.** The wire contracts in chapters 16 and 17 are the language boundary, so replacing the core leaves Local Runtime Mode clients untouched. Only Embedded Mode would need a napi binding underneath, and the TypeScript surface would stay the same. Revisit when any of the following is measured:

- Event delivery p99 misses the target at 10 concurrent sessions and the cause is traced to GC pauses.
- Resident memory or distribution size is reported as an adoption barrier.
- The Phase 2 GUI engine requires native modules — in which case only that module is split out as native code.

### 33.2 Why Gemini is out of the MVP

Google retired the "Gemini Code Assist for individuals" sign-in that the CLI used, so an individual
account can no longer authenticate it; sign-in now redirects to the Antigravity product. Antigravity
ships a GUI IDE rather than a headless CLI — its `antigravity-ide` entry point is the VS Code launcher
script, taking `--diff` and `--goto`, and the app bundle contains a language server and a media
encoder, not an agent runner. There is nothing for a provider adapter to drive.

The CLI binary still works with a `GEMINI_API_KEY`, so the adapter was not wrong, only unverifiable
on an individual account. It was removed rather than shipped unverified, because an adapter nobody
can run is a liability: it invites bug reports for a path the project cannot reproduce.

`listAgents()` no longer reports Gemini either. Listing a CLI as detected implies AgentBridge can
drive it, and a truthful "not supported" beats a detected entry that fails at session creation.

Reinstate it when a turn can be completed end to end and the `-o json` success shape has been
captured from a live run rather than guessed.

This is risk R1 arriving early and harder than written: the table anticipated flags and output
formats drifting, not an authentication path being withdrawn.

---

## 34. Glossary

| Term | Definition |
| --- | --- |
| **AgentBridge** | The headless runtime and SDK that connects local AI agents to external programs |
| **Agent** | A locally installed AI coding agent CLI (Claude, Gemini, Codex, …) |
| **Provider** | An adapter that abstracts one agent behind the AgentBridge interface |
| **Provider adapter** | An `AgentProvider` implementation. Isolates CLI launch and parsing details |
| **Session** | One agent execution context, with its own working directory, MCP set, and permission mode |
| **Turn** | One user message and the agent's complete processing of it |
| **Embedded Mode** | Importing the SDK and running in the host application's process |
| **Local Runtime Mode** | Running AgentBridge as a separate local daemon reached over HTTP, WS, or IPC |
| **MCP (Model Context Protocol)** | An open protocol for supplying tools and resources to AI models |
| **MCP client** | The side that connects to external MCP servers. AgentBridge plays this role |
| **MCP server** | The side that provides tools. AgentBridge can play this role too |
| **Transport** | An MCP communication method (stdio, SSE, streamable HTTP) |
| **Tool discovery** | Enumerating available tools with `tools/list` after connecting |
| **Tool Registry** | The module that indexes every tool regardless of origin |
| **Hot reload** | Applying MCP server changes without restarting the agent session |
| **Permission** | The permission class required by a tool (READ/WRITE/EXECUTE/NETWORK/SYSTEM) |
| **Permission mode** | The per-session permission behavior (ask/allow/deny) |
| **Approval request** | A pending decision awaiting the external app under the `ask` policy |
| **Event bus** | The internal module that fans session events out to subscribers |
| **seq** | The per-session event sequence number, used to recover gaps on reconnect |
| **Deny-by-default** | The security principle of rejecting when a decision is uncertain |
| **Redaction** | Masking sensitive values before logging or storage |

---

## 35. Appendix: minimal examples

### 35.1 Embedded Mode (TypeScript)

```typescript
import { AgentBridge } from "@jeonhui/agentbridge";

const agent = new AgentBridge({ defaultPermissionMode: "ask" });
await agent.start();

// 1) register an MCP server
await agent.mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: "node",
  args: ["./filesystem-mcp.js"],
  watch: { enabled: true },
});

// 2) create a session
const session = await agent.sessions.create({
  provider: "claude",
  workingDirectory: "/workspace/project",
  mcp: ["filesystem"],
});

// 3) subscribe to events
session.on("message", (e) => process.stdout.write(e.content));
session.on("tool_call", (e) => console.log("[tool]", e.tool, e.arguments));
session.on("permission_request", async (e) => {
  await agent.permissions.approve(e.requestId, { remember: "session" });
});

// 4) send a message
await session.send("Analyze the project structure");
```

### 35.2 Local Runtime Mode (Python)

```python
import json
import requests
import websocket

BASE = "http://127.0.0.1:8760"
TOKEN = json.load(open("/Users/me/.agentbridge/runtime.json"))["token"]
H = {"Authorization": f"Bearer {TOKEN}"}

# create a session
s = requests.post(f"{BASE}/sessions", headers=H, json={
    "provider": "gemini",
    "workingDirectory": "/workspace/project",
    "mcp": ["company"],
}).json()

# subscribe to events
ws = websocket.create_connection(f"ws://127.0.0.1:8760/events?token={TOKEN}")
ws.send(json.dumps({"t": "subscribe", "sessionIds": [s["id"]]}))

# send a message
requests.post(f"{BASE}/sessions/{s['id']}/messages", headers=H,
              json={"message": "Look up customer Hong Gil-dong"})

while True:
    frame = json.loads(ws.recv())
    if frame["t"] != "event":
        continue
    ev = frame["event"]
    if ev["type"] == "message":
        print(ev["content"], end="")
    elif ev["type"] == "permission_request":
        requests.post(f"{BASE}/permissions/{ev['requestId']}/approve", headers=H, json={})
    elif ev["type"] == "status" and ev["status"] == "ready":
        break
```

### 35.3 MCP registration and hot reload

```typescript
const before = await agent.tools.list({ server: "company" });

// after editing company-mcp.js to add an order.cancel tool and saving it
agent.on("mcp_status", (e) => {
  if (e.serverId === "company" && e.state === "connected") {
    console.log("reloaded, tools:", e.toolCount);
  }
});

const result = await agent.mcp.reload("company");   // explicit reload also works
console.log(result.addedTools);                     // ["order.cancel"]

const after = await agent.tools.list({ server: "company" });
console.log(after.length - before.length);          // 1
```

### 35.4 Registering a custom provider

```typescript
import { AgentBridge, type AgentProvider } from "@jeonhui/agentbridge";

const myProvider: AgentProvider = {
  id: "my-agent",
  name: "My Local Agent",
  capabilities: {
    streaming: true, mcp: false, resume: false,
    interrupt: true, workingDirectory: true, permissionHook: false,
  },
  async detect() {
    return { available: true, version: "0.1.0", executablePath: "/usr/local/bin/my-agent" };
  },
  async start(options) {
    return { sessionId: options.sessionId, providerId: "my-agent" };
  },
  async send(handle, message) { /* write to stdin */ },
  async interrupt(handle) { /* send a signal */ },
  async stop(handle) { /* terminate the process */ },
  parse(chunk) { return []; },
};

const agent = new AgentBridge();
agent.providers.register(myProvider);
await agent.start();
```

---

## 36. Final product definition

**AgentBridge is the agent runtime and MCP infrastructure that lets any program use local AI agents.**

The point is not to build a UI; it is to build the API, SDK, and runtime. External programs use AgentBridge to pick Claude, Gemini, or Codex, attach MCP servers, create agent sessions, send messages, and consume tool execution events to build their own UI and UX. AgentBridge itself therefore stays as **headless, provider-agnostic, MCP-first, and local-first** as possible.
