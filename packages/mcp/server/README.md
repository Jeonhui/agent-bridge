# @jeonhui/agentbridge-mcp-server

Exposes AgentBridge itself as an MCP server.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-mcp-server
```

## Usage

```typescript
import { AgentBridgeMcpServer } from "@jeonhui/agentbridge-mcp-server";

await new AgentBridgeMcpServer({ agent }).serveStdio();
```

The other direction: an external agent connects and drives AgentBridge as a set of tools, listing
providers, creating sessions, and calling registered tools under policy. Call depth is tracked and
capped, so a session AgentBridge created cannot recurse back into itself.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
