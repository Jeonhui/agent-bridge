# @jeonhui/agentbridge-core

Core runtime for AgentBridge: events, sessions, storage, logging, secrets.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-core
```

## Usage

```typescript
import { AgentBridge } from "@jeonhui/agentbridge-core";

const agent = new AgentBridge();
agent.registerProvider(myProvider);
await agent.start();

const session = await agent.sessions.create({ provider: "claude" });
session.on("message", (event) => process.stdout.write(event.content));
await session.send("Analyze the project structure");
```

The core owns sessions, the event bus, error codes, storage, logging, and secret resolution. It
imports no adapter and no MCP package, so the dependency direction stays one way.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
