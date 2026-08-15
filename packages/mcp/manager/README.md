# @jeonhui/agentbridge-mcp-manager

MCP registration, connection, and hot reload for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-mcp-manager
```

## Usage

```typescript
import { McpManager } from "@jeonhui/agentbridge-mcp-manager";

const mcp = new McpManager();
agent.attachMcp(mcp);

await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: "node",
  args: ["./filesystem-mcp.js"],
  watch: { enabled: true },   // edit the server, tools refresh without restarting the session
});
```

Registers, connects, and hot reloads MCP servers, keeping the tool registry in step. A failure on
one server never affects another.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
