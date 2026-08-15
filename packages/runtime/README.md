# @jeonhui/agentbridge-runtime

Local REST and WebSocket runtime for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-runtime
```

## Usage

```typescript
import { RuntimeServer } from "@jeonhui/agentbridge-runtime";

const server = new RuntimeServer({ agent });
const { host, port, token } = await server.start();
```

REST plus WebSocket over loopback, so applications that cannot import the SDK reach the same
functionality. A fresh token per start, compared in constant time. Events replay from the last
sequence number a client saw, so a dropped connection does not lose what happened while it was
away.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
