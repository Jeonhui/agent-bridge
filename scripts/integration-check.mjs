#!/usr/bin/env node
// What an integrating application actually does:
// attach MCP and permissions, list tools, call one, and answer the approval prompt itself.
// No agent CLI is involved here - this is the host-application surface on its own.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { McpManager } from "../packages/agentbridge/dist/mcp/manager/index.js";
import { PermissionManager } from "../packages/agentbridge/dist/permission/index.js";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-integration-"));
await writeFile(join(workspace, "notes.txt"), "before\n", "utf8");

const checks = [];
const check = (label, ok, detail = "") => checks.push([label, ok, detail]);

const agent = new AgentBridge({ defaultPermissionMode: "ask" });

const mcp = new McpManager();
const permissions = new PermissionManager({
  approvalTimeoutMs: 5_000,
  emit: (payload) => agent.events.emit({
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
  args: [new URL("./fixtures/filesystem-mcp.mjs", import.meta.url).pathname, workspace],
});

// The host renders its own approval UI from this event.
const prompts = [];
agent.on("permission_request", (event) => {
  prompts.push(event);
  agent.permissions.approve(event.requestId, { decidedBy: "host-ui", remember: "once" });
});

const tools = agent.tools.list();
check("tools are listed with their permissions", tools.length === 2, tools.map((t) => `${t.name}:${t.permissions}`).join(" "));

const write = await agent.tools.call("mcp:filesystem:write_file", {
  path: "notes.txt",
  content: "after\n",
});
check("the approved call ran", write.ok, write.error?.message ?? "");
check("the host was asked exactly once", prompts.length === 1, String(prompts.length));
check("the file changed", (await readFile(join(workspace, "notes.txt"), "utf8")) === "after\n");

// Now the host installs a policy that denies writes outright, so no prompt should be raised.
const promptsBeforeDenial = prompts.length;
agent.permissions.setPolicy({
  id: "block-writes",
  match: { toolPattern: "mcp:filesystem:write*" },
  effect: "deny",
  priority: 100,
  createdAt: new Date().toISOString(),
});

const blocked = await agent.tools.call("mcp:filesystem:write_file", { path: "notes.txt", content: "nope\n" });
check("a denied call returns ok:false rather than throwing", blocked.ok === false);
check("the denial carries AB-4001", blocked.error?.code === "AB-4001", blocked.error?.code ?? "");
check("no extra prompt was raised for a denied call", prompts.length === promptsBeforeDenial);
check("the file was not modified", (await readFile(join(workspace, "notes.txt"), "utf8")) === "after\n");

// A read stays allowed because the rule only covers writes.
const read = await agent.tools.call("mcp:filesystem:read_file", { path: "notes.txt" });
check("an unrelated tool is unaffected by the rule", read.ok, read.error?.message ?? "");

// A tool that does not exist.
const missing = await agent.tools.call("mcp:filesystem:nope", {}).catch((error) => ({ ok: false, error }));
check("an unknown tool id fails cleanly", missing.ok === false);

await agent.stop();

let failed = 0;
console.log("--- checks ---");
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed += 1;
}
console.log(`\nintegration check ${failed === 0 ? "PASSED" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
