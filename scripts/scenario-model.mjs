#!/usr/bin/env node
// setModel mid-conversation: the model changes, the context survives (spec 13.3).
// Adapters run one process per turn, so the next turn simply spawns with the new --model
// while --resume carries the conversation. Usage: pnpm scenario:model

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { ClaudeProvider } from "../packages/agentbridge/dist/provider/claude/index.js";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

const session = await agent.sessions.create({ provider: "claude", model: "sonnet" });
const replies = [];
session.on("message", (e) => replies.push(e.content));

await session.send("Remember the word PLUM. Reply with exactly: noted");
console.log(`turn 1 (model=${session.info.model}): ${JSON.stringify(replies[0])}`);

await session.setModel("haiku");
await session.send("What word did I ask you to remember? Reply with only that word.");
console.log(`turn 2 (model=${session.info.model}): ${JSON.stringify(replies[1])}`);

const checks = [
  ["the session reports the new model", session.info.model === "haiku"],
  ["the new model remembers the old model's conversation", /plum/i.test(replies[1] ?? "")],
];
let failed = 0;
for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
await agent.stop();
console.log(`\nscenario model ${failed === 0 ? "PASSED" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
