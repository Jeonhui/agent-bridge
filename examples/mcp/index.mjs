#!/usr/bin/env node
// Give an agent your own tools through MCP, and watch the tool calls as they happen.
//
//   node examples/mcp/index.mjs

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "@agentbridge/core";
import { ClaudeProvider } from "@agentbridge/provider-claude";
import { McpManager } from "@agentbridge/mcp-manager";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-example-"));
await writeFile(join(workspace, "notes.txt"), "before\n", "utf8");

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager();
agent.attachMcp(mcp);
await agent.start();

const server = await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: process.execPath,
  args: [new URL("../../scripts/fixtures/filesystem-mcp.mjs", import.meta.url).pathname, workspace],
  // Edit the server and its tools refresh without restarting the session.
  watch: { enabled: true },
});
console.log(`discovered ${server.toolCount} tools: ${server.tools.join(", ")}`);

const session = await agent.sessions.create({
  provider: "claude",
  workingDirectory: workspace,
  mcp: ["filesystem"],
  // Agent CLIs prompt for approval themselves, and in non-interactive mode that prompt denies.
  // "allow" tells AgentBridge to pre-authorize the bound servers. See spec 25.4.
  permissionMode: "allow",
});

session.on("tool_call", (event) => console.log(`[tool] ${event.tool} ${JSON.stringify(event.arguments)}`));
session.on("message", (event) => console.log(`[agent] ${event.content}`));

await session.send("Use the write_file MCP tool to put 'hello from mcp' in notes.txt, then reply done.");

console.log(`\nfile now reads: ${JSON.stringify(await readFile(join(workspace, "notes.txt"), "utf8"))}`);
await agent.stop();
