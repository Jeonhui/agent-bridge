# @jeonhui/agentbridge-mcp-registry

Tool registry and permission inference for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-mcp-registry
```

## Usage

```typescript
import { ToolRegistry } from "@jeonhui/agentbridge-mcp-registry";

const registry = new ToolRegistry();
const diff = registry.replaceServerTools("filesystem", discoveredTools);
console.log(diff.added, diff.removed, diff.changed);
```

Indexes every tool as `{source}:{server}:{name}` regardless of origin, and derives permissions from
MCP annotations, then explicit overrides, then name heuristics, falling back to `WRITE` because an
unclassified tool must not be assumed harmless.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
