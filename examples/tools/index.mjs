#!/usr/bin/env node
// Calling tools directly, with the host answering the approval prompt.
// No agent is involved: this is the surface a UI binds to.
//
//   node examples/tools/index.mjs

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "@agentbridge/core";
import { McpManager } from "@agentbridge/mcp-manager";
import { PermissionManager } from "@agentbridge/permission";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-tools-"));
await writeFile(join(workspace, "notes.txt"), "before\n", "utf8");

const agent = new AgentBridge({ defaultPermissionMode: "ask" });
const mcp = new McpManager();
const permissions = new PermissionManager({
  emit: (payload) =>
    agent.events.emit({
      id: `perm_${Date.now()}`,
      seq: 0,
      sessionId: "host",
      timestamp: new Date().toISOString(),
      ...payload,
    }),
});

agent.attachMcp(mcp);
agent.attachPermissions(permissions);
await agent.start();

await mcp.add({
  id: "filesystem",
  transport: "stdio",
  command: process.execPath,
  args: [new URL("../../scripts/fixtures/filesystem-mcp.mjs", import.meta.url).pathname, workspace],
});

// This is where a desktop app would open a dialog instead.
agent.on("permission_request", (event) => {
  console.log(`[approval] ${event.tool} wants ${event.permissions.join(", ")}`);
  console.log(`           arguments: ${JSON.stringify(event.arguments)}`);
  agent.permissions.approve(event.requestId, { remember: "session" });
});

for (const tool of agent.tools.list()) {
  console.log(`${tool.id}  permissions=${tool.permissions.join(",")}`);
}

const write = await agent.tools.call("mcp:filesystem:write_file", {
  path: "notes.txt",
  content: "written through the tools API\n",
});
console.log(`\nwrite ok=${write.ok} in ${write.durationMs}ms`);

// A policy denies without asking the host. Priority decides against a remembered answer:
// higher wins, and a tie goes to the more specific rule.
agent.permissions.setPolicy({
  id: "no-writes",
  match: { toolPattern: "mcp:filesystem:write*" },
  effect: "deny",
  priority: 200,
  createdAt: new Date().toISOString(),
});

const blocked = await agent.tools.call("mcp:filesystem:write_file", { path: "notes.txt", content: "nope" });
console.log(`second write ok=${blocked.ok} error=${blocked.error?.code}`);

await agent.stop();
