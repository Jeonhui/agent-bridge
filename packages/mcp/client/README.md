# @jeonhui/agentbridge-mcp-client

MCP client and transports for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-mcp-client
```

## Usage

```typescript
import { McpClient } from "@jeonhui/agentbridge-mcp-client";

const client = new McpClient({ id: "filesystem", transport: "stdio", command: "node", args: ["fs.js"] });
await client.connect();
const tools = await client.listTools();
```

Wraps the official MCP SDK so transport differences (stdio, SSE, streamable HTTP) stop at this
layer. Validates configuration before anything is spawned, and masks secret-looking values for
anything returned over an API.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
