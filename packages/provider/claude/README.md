# @jeonhui/agentbridge-provider-claude

Claude Code adapter for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-provider-claude
```

## Usage

```typescript
import { AgentBridge } from "@jeonhui/agentbridge-core";
import { ClaudeProvider } from "@jeonhui/agentbridge-provider-claude";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();
```

Requires the `claude` CLI on PATH. Runs one process per turn in `--print --output-format stream-json`
mode and keeps continuity through the CLI's own session id. The line mapping was built against
captured output from claude 2.1.220 rather than assumed, and unknown line types are ignored so new
CLI telemetry does not break the parser.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
