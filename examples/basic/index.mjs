#!/usr/bin/env node
// The smallest useful integration: connect to a local agent and stream its reply.
//
//   node examples/basic/index.mjs "what is 1+1?"

import { AgentBridge } from "@jeonhui/agentbridge-core";
import { ClaudeProvider } from "@jeonhui/agentbridge-provider-claude";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

const [claude] = await agent.providers.list();
if (!claude?.available) {
  console.error(`claude is not available: ${claude?.reason ?? "unknown"}`);
  process.exit(1);
}

const session = await agent.sessions.create({ provider: "claude" });

session.on("message", (event) => process.stdout.write(event.content));
session.on("status", (event) => process.stderr.write(`[${event.previous} -> ${event.status}]\n`));

await session.send(process.argv[2] ?? "Say hello in one short sentence.");

await agent.stop();
