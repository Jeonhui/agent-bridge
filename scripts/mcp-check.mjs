#!/usr/bin/env node
// Exercises the MCP path against a real stdio MCP server:
// register -> connect -> discover -> call a tool -> hot reload -> observe the registry diff.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../packages/agentbridge/dist/mcp/manager/index.js";

const workspace = await mkdtemp(join(tmpdir(), "agentbridge-mcp-"));
await writeFile(join(workspace, "README.md"), "# before\n", "utf8");

const events = [];
const manager = new McpManager({ emit: (e) => events.push(e) });

const checks = [];
const check = (label, ok, detail = "") => checks.push([label, ok, detail]);

const state = await manager.add({
  id: "filesystem",
  transport: "stdio",
  command: process.execPath,
  args: [new URL("./fixtures/filesystem-mcp.mjs", import.meta.url).pathname, workspace],
});

check("server reaches connected", state.state === "connected", state.state);
check("tools discovered", state.toolCount === 2, `toolCount=${state.toolCount}`);
check(
  "tool ids follow {source}:{server}:{name}",
  manager.registry.list().every((t) => t.id.startsWith("mcp:filesystem:")),
);

const readTool = manager.registry.get("mcp:filesystem:read_file");
const writeTool = manager.registry.get("mcp:filesystem:write_file");
check("readOnlyHint maps to READ", readTool.permissions.join() === "READ", readTool.permissions.join());
check("destructiveHint maps to WRITE", writeTool.permissions.join() === "WRITE", writeTool.permissions.join());

const written = await manager.callTool("mcp:filesystem:write_file", {
  path: "README.md",
  content: "# after\n",
});
check("write_file returned content", Array.isArray(written));
check("the file actually changed", (await readFile(join(workspace, "README.md"), "utf8")) === "# after\n");

let escaped = false;
try {
  await manager.callTool("mcp:filesystem:read_file", { path: "../../etc/passwd" });
} catch {
  escaped = true;
}
check("path escape is rejected", escaped);

// Hot reload: the fixture exposes a third tool when EXTRA_TOOL=1, so the restarted process
// discovers one more tool than the original did.
const before = manager.registry.list({ server: "filesystem" }).length;
process.env.EXTRA_TOOL = "1";

const reload = await manager.reload("filesystem");
const after = manager.registry.list({ server: "filesystem" }).length;

check("hot reload added the new tool", after === before + 1, `${before} -> ${after}`);
check("reload reports the diff", reload.addedTools.includes("mcp:filesystem:append_file"), reload.addedTools.join());
check("reload finished within 3s", reload.durationMs < 3000, `${reload.durationMs}ms`);
check(
  "mcp_status events were emitted",
  events.some((e) => e.state === "reloading") && events.some((e) => e.state === "connected"),
);

await manager.closeAll();

let failed = 0;
console.log("--- checks ---");
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed += 1;
}
console.log(`\nMCP check ${failed === 0 ? "PASSED" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
