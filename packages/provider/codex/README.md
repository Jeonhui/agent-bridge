# @jeonhui/agentbridge-provider-codex

Codex CLI adapter for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-provider-codex
```

## Usage

```typescript
import { CodexProvider } from "@jeonhui/agentbridge-provider-codex";
agent.registerProvider(new CodexProvider());
```

Requires the `codex` CLI on PATH. Runs `codex exec --json` per turn and resumes through the CLI's
thread id. Authorization maps to a sandbox level rather than a tool allowlist: pre-authorized
sessions get `workspace-write`, everything else `read-only`, and `danger-full-access` is never
selected implicitly.

Not yet verified end to end: see the provider status notes in the repository README.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
