#!/usr/bin/env node
// Starts the local runtime with Claude and an MCP filesystem server attached.
// Prints the address and token, then serves until interrupted. Usage: pnpm serve

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridge } from "../packages/agentbridge/dist/core/index.js";
import { ClaudeProvider } from "../packages/agentbridge/dist/provider/claude/index.js";
import { McpManager } from "../packages/agentbridge/dist/mcp/manager/index.js";
import { PermissionManager } from "../packages/agentbridge/dist/permission/index.js";
import { RuntimeServer } from "../packages/agentbridge/dist/runtime/index.js";

const workspace = process.env.AGENTBRIDGE_WORKSPACE ?? (await mkdtemp(join(tmpdir(), "agentbridge-serve-")));
await writeFile(join(workspace, "notes.txt"), "before\n", "utf8");

const agent = new AgentBridge({ defaultPermissionMode: "allow" });
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager();
const permissions = new PermissionManager({
  emit: (payload) => agent.events.emit({
    id: `perm_${Date.now()}`,
    seq: 0,
    sessionId: "runtime",
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

const server = new RuntimeServer({ agent, port: Number(process.env.PORT ?? 0) });
const address = await server.start();

console.log(JSON.stringify({ ...address, workspace }));

const shutdown = async () => {
  await server.stop();
  await agent.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
