# @jeonhui/agentbridge-cli

Runs AgentBridge as a local daemon.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-cli
```

## Usage

```bash
agentbridge agents      # which agent CLIs are installed
agentbridge serve       # start the daemon, print its address and token
```

Starts the runtime with every adapter registered, writes credentials to `~/.agentbridge/runtime.json`
with owner-only permissions, and persists sessions, MCP registrations, and permission rules so they
survive a restart.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
