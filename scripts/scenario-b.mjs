#!/usr/bin/env node
// Acceptance scenario B (spec 31.2), with Claude standing in for Codex until that adapter lands:
// external program -> AgentBridge -> agent -> filesystem MCP -> file modified -> result returned
//
// This talks to the real claude CLI and a real stdio MCP server. Usage: pnpm scenario:b

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "../packages/core/dist/index.js";
import { ClaudeProvider } from "../packages/provider/claude/dist/index.js";
import { McpManager } from "../packages/mcp/manager/dist/index.js";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-scenario-b-"));
const target = join(workspace, "README.md");
await writeFile(target, "placeholder\n", "utf8");

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager({ emit: (payload) => agent.events.emit({
  id: `mcp_${Date.now()}`,
  seq: 0,
  sessionId: "mcp",
  timestamp: new Date().toISOString(),
  ...payload,
}) });
agent.attachMcp(mcp);
await agent.start();

const server = await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: process.execPath,
  args: [new URL("./fixtures/filesystem-mcp.mjs", import.meta.url).pathname, workspace],
});
console.log(`mcp registered: ${server.id} state=${server.state} tools=${server.tools.join(", ")}`);

const session = await agent.sessions.create({
  provider: "claude",
  model: "sonnet",
  workingDirectory: workspace,
  mcp: ["filesystem"],
  permissionMode: "allow",
});
console.log(`session created: ${session.id}`);

const events = [];
for (const type of ["status", "message", "tool_call", "tool_result", "error"]) {
  session.on(type, (e) => events.push(e));
}

const started = Date.now();
await session.send(
  "Use the filesystem MCP tool write_file to replace README.md with exactly '# scenario b\\n'. " +
    "Use only that MCP tool, not your built-in file tools. Then reply done.",
);
const elapsedMs = Date.now() - started;

const finalContent = await readFile(target, "utf8");
const toolCalls = events.filter((e) => e.type === "tool_call");
const mcpCalls = toolCalls.filter((e) => /write_file/.test(e.tool));

console.log("\n--- observed ---");
for (const e of events) {
  const detail =
    e.type === "message" ? JSON.stringify(e.content.slice(0, 60))
    : e.type === "tool_call" ? `${e.tool} ${JSON.stringify(e.arguments).slice(0, 80)}`
    : e.type === "status" ? e.status
    : "";
  console.log(`  seq=${String(e.seq).padStart(2)} ${e.type} ${detail}`);
}

const checks = [
  ["the MCP server connected and exposed tools", server.state === "connected" && server.toolCount >= 2],
  ["the agent called a write tool", mcpCalls.length > 0],
  ["the file on disk actually changed", finalContent.includes("scenario b")],
  ["tool_call events reached the external program", toolCalls.length > 0],
  ["the session ended ready", session.info.status === "ready"],
];

console.log("\n--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}
console.log(`\nfile content: ${JSON.stringify(finalContent)}`);

await agent.stop();
console.log(`\nscenario B ${failed === 0 ? "PASSED" : "FAILED"} in ${elapsedMs}ms`);
process.exit(failed === 0 ? 0 : 1);
