# @jeonhui/agentbridge-provider-core

Provider contract and CLI detection for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-provider-core
```

## Usage

```typescript
import { listAgents, ProcessRunner, StreamParser } from "@jeonhui/agentbridge-provider-core";

// Which agent CLIs are installed on this machine
for (const agent of await listAgents()) {
  console.log(agent.id, agent.available, agent.version);
}
```

Implement `AgentProvider` to add a new agent. `ProcessRunner` and `StreamParser` carry the parts
every CLI adapter needs: spawning, stdin, a stderr cap, SIGTERM then SIGKILL, and chunk-boundary
safe line parsing.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
