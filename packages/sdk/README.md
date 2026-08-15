# @jeonhui/agentbridge-sdk

One client for AgentBridge over the embedded core or the local runtime.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-sdk
```

## Usage

```typescript
import { createClient } from "@jeonhui/agentbridge-sdk";

const client = createClient({ transport: "embedded", agent });
// or
const client = createClient({ transport: "http", baseUrl, token, webSocket: (u) => new WebSocket(u) });

await client.connect();
const session = await client.sessions.create({ provider: "claude" });
session.on("message", (event) => render(event.content));
await session.send("hello");
```

The same interface over both backends, so moving a feature between an in-process integration and a
shared runtime is a configuration change. One parity suite runs against both, so a drift between
them fails the build rather than surprising an integrator.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
