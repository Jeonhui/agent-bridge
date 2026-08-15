#!/usr/bin/env node
// Acceptance scenario E (spec 31.5):
// external program -> AgentBridge -> Claude -> AgentBridge MCP Server -> AgentBridge tool
//
// Closes the bidirectional loop: AgentBridge drives an agent, and that agent calls back into
// AgentBridge through its own MCP server. Usage: pnpm scenario:e

import { AgentBridge } from "../packages/core/dist/index.js";
import { ClaudeProvider } from "../packages/provider/claude/dist/index.js";
import { McpManager } from "../packages/mcp/manager/dist/index.js";

const agent = new AgentBridge({ defaultPermissionMode: "allow" });
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager();
agent.attachMcp(mcp);
await agent.start();

const server = await mcp.add({
  id: "agentbridge",
  transport: "stdio",
  command: process.execPath,
  args: [new URL("./fixtures/agentbridge-mcp-stdio.mjs", import.meta.url).pathname],
});
console.log(`agentbridge MCP server: state=${server.state} tools=${server.tools.length}`);
console.log(`  ${server.tools.join("\n  ")}`);

const session = await agent.sessions.create({
  provider: "claude",
  model: "sonnet",
  mcp: ["agentbridge"],
  permissionMode: "allow",
});

const events = [];
for (const type of ["status", "message", "tool_call", "tool_result", "error"]) {
  session.on(type, (e) => events.push(e));
}

const started = Date.now();
await session.send(
  "Call the mcp__agentbridge__agentbridge_providers_list tool and tell me which agent CLIs it reports. " +
    "Use only that MCP tool.",
);
const elapsedMs = Date.now() - started;

console.log("\n--- observed ---");
for (const e of events) {
  const detail =
    e.type === "message" ? JSON.stringify(e.content.slice(0, 100))
    : e.type === "tool_call" ? e.tool
    : e.type === "status" ? e.status
    : "";
  console.log(`  seq=${String(e.seq).padStart(2)} ${e.type} ${detail}`);
}

const toolCalls = events.filter((e) => e.type === "tool_call");
const bridgeCalls = toolCalls.filter((e) => /agentbridge_providers_list/.test(e.tool));
const messages = events.filter((e) => e.type === "message");

const checks = [
  ["the AgentBridge MCP server connected", server.state === "connected"],
  ["it exposed its tool surface", server.tools.length === 7],
  ["the agent called back into AgentBridge", bridgeCalls.length > 0],
  ["a tool result came back", events.some((e) => e.type === "tool_result")],
  ["the answer mentions claude", messages.some((e) => /claude/i.test(e.content))],
  ["the session ended ready", session.info.status === "ready"],
];

console.log("\n--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

await agent.stop();
console.log(`\nscenario E ${failed === 0 ? "PASSED" : "FAILED"} in ${elapsedMs}ms`);
process.exit(failed === 0 ? 0 : 1);
