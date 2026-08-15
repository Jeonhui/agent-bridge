#!/usr/bin/env node
// Does `ask` reach an agent's own tool calls? (spec 25.4)
//
// The agent, not the host, initiates the call. Without the permission prompt hook the CLI settles
// it internally and denies; with the hook the decision travels back here. Usage: pnpm scenario:ask

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { ClaudeProvider } from "../packages/agentbridge/dist/provider/claude/index.js";
import { McpManager } from "../packages/agentbridge/dist/mcp/manager/index.js";
import { PermissionManager } from "../packages/agentbridge/dist/permission/index.js";

const mode = process.argv[2] ?? "approve";   // approve | deny | auto
const workspace = await mkdtemp(join(tmpdir(), "agentbridge-ask-"));
const target = join(workspace, "notes.txt");
await writeFile(target, "before\n", "utf8");

const agent = new AgentBridge({ defaultPermissionMode: "ask" });
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager();
const permissions = new PermissionManager({
  emit: (payload) => agent.events.emit({
    id: `perm_${Date.now()}`, seq: 0, sessionId: "host",
    timestamp: new Date().toISOString(), ...payload,
  }),
  promptHook: {
    enabled: true,
    provider: "claude",
    resolveTool: (toolName) => {
      const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (!match) return undefined;
      try {
        const tool = mcp.registry.get(`mcp:${match[1]}:${match[2]}`);
        return { toolId: tool.id, permissions: tool.permissions };
      } catch {
        return undefined;
      }
    },
  },
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

if (mode === "auto") permissions.autoApprove(true);

const prompts = [];
agent.on("permission_request", (event) => {
  prompts.push(event);
  console.log(`[host] asked about ${event.tool} (${event.permissions.join(",")})`);
  if (mode === "deny") agent.permissions.deny(event.requestId, { reason: "the user declined" });
  else agent.permissions.approve(event.requestId);
});

const session = await agent.sessions.create({
  provider: "claude",
  model: "sonnet",
  workingDirectory: workspace,
  mcp: ["filesystem"],
  permissionMode: "ask",
});

const started = Date.now();
await session.send(
  "Use the write_file MCP tool to put 'approved write' in notes.txt, then reply done.",
);
const elapsedMs = Date.now() - started;
const content = await readFile(target, "utf8");

console.log(`\nmode=${mode} prompts=${prompts.length} file=${JSON.stringify(content)} (${elapsedMs}ms)`);

const checks =
  mode === "approve"
    ? [["the host was asked about the agent's own tool call", prompts.length > 0],
       ["approving let the write through", content.includes("approved write")]]
    : mode === "deny"
    ? [["the host was asked", prompts.length > 0],
       ["denying blocked the write", !content.includes("approved write")]]
    : [["auto-approve asked the host nothing", prompts.length === 0],
       ["the write still went through", content.includes("approved write")]];

let failed = 0;
console.log("--- checks ---");
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

await permissions.close();
await agent.stop();
console.log(`\nask hook (${mode}) ${failed === 0 ? "PASSED" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
