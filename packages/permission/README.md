# @jeonhui/agentbridge-permission

Permission policy evaluation and approval queue for AgentBridge.

Part of [AgentBridge](https://github.com/Jeonhui/agent-bridge#readme), a headless runtime that connects locally installed AI agent
CLIs to any program and supplies them with user-defined tools over MCP.

## Install

```bash
pnpm add @jeonhui/agentbridge-permission
```

## Usage

```typescript
import { PermissionManager } from "@jeonhui/agentbridge-permission";

const permissions = new PermissionManager();
agent.attachPermissions(permissions);

agent.on("permission_request", (event) => {
  showDialog(event.tool, event.permissions, {
    onAllow: () => agent.permissions.approve(event.requestId, { remember: "session" }),
    onDeny: () => agent.permissions.deny(event.requestId),
  });
});
```

Deny-by-default throughout: an unanswered request expires into a denial, and a decision that is not
an explicit allow ends as one. Rules match on tool id, permission, session, provider, and path
scope, with priority ordering and a specificity tiebreak.

## Documentation

The full design, including the API contracts and the acceptance scenarios, is in the
[product specification](https://github.com/Jeonhui/agent-bridge/blob/main/docs/AgentBridge-Product-Spec.md).

## License

MIT
