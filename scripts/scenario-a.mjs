#!/usr/bin/env node
// Acceptance scenario A (spec 31.1):
// external program -> AgentBridge -> Claude -> response -> external program
//
// This talks to the real claude CLI. Usage: pnpm scenario:a

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { ClaudeProvider } from "../packages/agentbridge/dist/provider/claude/index.js";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

const providers = await agent.providers.list();
const claude = providers.find((p) => p.id === "claude");
console.log(`providers.list() -> ${JSON.stringify(providers)}`);
if (!claude?.available) {
  console.error("claude is not installed; scenario A cannot run");
  process.exit(1);
}

const session = await agent.sessions.create({ provider: "claude", model: "sonnet" });
console.log(`session created: ${session.id} status=${session.info.status}`);

const events = [];
for (const type of ["status", "message", "tool_call", "error"]) {
  session.on(type, (e) => events.push(e));
}

const started = Date.now();
const firstTurn = await session.send("reply with exactly: ok");
const firstTurnEvents = events.length;

// Continuity: the CLI session id is reused through --resume, so turn 2 must remember turn 1.
await session.send("what single word did you just say? reply with only that word.");
const elapsedMs = Date.now() - started;

console.log("\n--- observed ---");
for (const e of events) {
  const detail = e.type === "message" ? JSON.stringify(e.content) : e.type === "status" ? e.status : "";
  console.log(`  seq=${String(e.seq).padStart(2)} ${e.type} ${detail}`);
}

const messages = events.filter((e) => e.type === "message");
const statuses = events.filter((e) => e.type === "status").map((e) => e.status);
const seqs = events.map((e) => e.seq);
const firstTurnOnly = events.slice(0, firstTurnEvents);
const secondTurnMessages = messages.slice(1);

const checks = [
  ["a message event arrived", messages.length > 0],
  ["the response is non-empty", (messages[0]?.content ?? "").trim().length > 0],
  ["status cycled running/ready per turn", statuses.join(">") === "running>ready>running>ready"],
  ["seq is strictly increasing across turns", seqs.every((s, i) => i === 0 || s > seqs[i - 1])],
  [
    "turn 1 events all carry turn 1's id",
    firstTurnOnly.filter((e) => e.type !== "status").every((e) => e.turnId === firstTurn.turnId),
  ],
  [
    "turn 2 reuses the session and the agent remembers turn 1",
    secondTurnMessages.some((e) => /ok/i.test(e.content)),
  ],
  ["session ends ready", session.info.status === "ready"],
];

console.log("\n--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

await agent.stop();
console.log(`\nscenario A ${failed === 0 ? "PASSED" : "FAILED"} in ${elapsedMs}ms`);
process.exit(failed === 0 ? 0 : 1);
