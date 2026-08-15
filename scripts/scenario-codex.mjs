#!/usr/bin/env node
// Scenario A against the Codex adapter, so provider swapping is verified rather than assumed:
// the only difference from scenario-a.mjs is the provider string.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { CodexProvider } from "../packages/agentbridge/dist/provider/codex/index.js";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-codex-"));

const agent = new AgentBridge();
agent.registerProvider(new CodexProvider());
await agent.start();

const providers = await agent.providers.list();
console.log(`providers.list() -> ${JSON.stringify(providers)}`);
if (!providers.find((p) => p.id === "codex")?.available) {
  console.error("codex is not installed");
  process.exit(1);
}

const session = await agent.sessions.create({
  provider: "codex",
  workingDirectory: workspace,
  ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
});
console.log(`session created: ${session.id}`);

const events = [];
for (const type of ["status", "message", "tool_call", "error"]) {
  session.on(type, (e) => events.push(e));
}

let failure;
try {
  await session.send("reply with exactly: ok");
} catch (error) {
  failure = error;
}

console.log("\n--- observed ---");
for (const e of events) {
  const detail =
    e.type === "message" ? JSON.stringify(e.content.slice(0, 80))
    : e.type === "error" ? `${e.error.code} ${e.error.message.slice(0, 120)}`
    : e.type === "status" ? e.status
    : "";
  console.log(`  seq=${String(e.seq).padStart(2)} ${e.type} ${detail}`);
}

const messages = events.filter((e) => e.type === "message");
const errors = events.filter((e) => e.type === "error");

const codex = providers.find((p) => p.id === "codex");
const statuses = events.filter((e) => e.type === "status").map((e) => e.status);

const checks = [
  ["codex was detected with a version", Boolean(codex?.available && codex.version)],
  ["the process ran and produced events", events.length > 0],
  ["status moved to running", statuses.includes("running")],
  [
    "an upstream failure is surfaced as a readable message, not raw JSON",
    errors.length === 0 || !errors[0].error.message.trim().startsWith("{"),
  ],
  ["a message came back", messages.length > 0],
];

console.log("\n--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

if (failure) console.log(`\nturn failed: ${failure.message}`);
if (errors.length > 0) console.log(`agent error: ${errors[0].error.message.slice(0, 200)}`);

await agent.stop();
console.log(`\nscenario codex ${failed === 0 ? "PASSED" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
