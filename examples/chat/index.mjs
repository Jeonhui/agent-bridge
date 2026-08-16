#!/usr/bin/env node
// agent-chat: a terminal chat app built on AgentBridge.
//
// What it demonstrates, in the order a real host application meets it:
//   - a session with streaming replies rendered by the host, not by the agent CLI
//   - the agent using tools the host provided (a sandboxed filesystem, over MCP)
//   - ask mode: the agent stops before every write and this app asks YOU, y/n
//
// Run it:   node index.mjs        (needs the claude CLI installed and logged in)

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";

import { AgentBridge } from "@jeonhui/agentbridge";
import { ClaudeProvider } from "@jeonhui/agentbridge/claude";
import { McpManager } from "@jeonhui/agentbridge/mcp";
import { PermissionManager } from "@jeonhui/agentbridge/permission";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ── a sandbox the agent may touch ────────────────────────────────────────────
const sandbox = join(import.meta.dirname, "sandbox");
await mkdir(sandbox, { recursive: true });
await writeFile(join(sandbox, "notes.txt"), "The agent may read and, with your approval, write here.\n");

// ── wire the runtime ─────────────────────────────────────────────────────────
const agent = new AgentBridge({ defaultPermissionMode: "ask" });
agent.registerProvider(new ClaudeProvider());

const mcp = new McpManager();
const permissions = new PermissionManager({
  emit: (payload) => agent.events.emit({
    id: `perm_${Date.now()}`, seq: 0, sessionId: "chat",
    timestamp: new Date().toISOString(), ...payload,
  }),
  promptHook: {
    enabled: true,
    provider: "claude",
    // Map the CLI's tool naming back onto the registry so rules and labels line up.
    resolveTool: (name) => {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      if (!m) return undefined;
      try { const t = mcp.registry.get(`mcp:${m[1]}:${m[2]}`); return { toolId: t.id, permissions: t.permissions }; }
      catch { return undefined; }
    },
  },
});
agent.attachMcp(mcp);
agent.attachPermissions(permissions);
await agent.start();

await mcp.add({
  id: "fs",
  transport: "stdio",
  command: process.execPath,
  args: [join(import.meta.dirname, "fs-mcp.mjs"), sandbox],
});

const session = await agent.sessions.create({
  provider: "claude",
  workingDirectory: sandbox,
  mcp: ["fs"],
  permissionMode: "ask",
});

// ── render events; the host owns the UI ──────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
let stdinClosed = false;
rl.on("close", () => { stdinClosed = true; });

session.on("message", (e) => console.log(`\n${bold("agent")}  ${e.content}`));
session.on("tool_call", (e) => console.log(dim(`  ⚙ ${e.tool} ${JSON.stringify(e.arguments).slice(0, 80)}`)));

// The approval prompt: the agent is blocked mid-turn until this question is answered.
//
// Two things every host should copy from this handler:
//   - it always answers, even when the UI is gone (a closed stdin becomes a deny) — an
//     unanswered request would leave the agent waiting until the timeout denies it;
//   - it never lets a rejection escape. Event handlers run outside any try/catch of yours,
//     so an async throw here would crash the host, not the library.
agent.on("permission_request", (e) => {
  void (async () => {
    if (stdinClosed) {
      agent.permissions.deny(e.requestId, { reason: "no user available to approve" });
      return;
    }
    const answer = await rl.question(
      `\n${yellow("approve?")} agent wants ${bold(e.tool)} (${e.permissions.join(",")}) ` +
      `${dim(JSON.stringify(e.arguments).slice(0, 60))}  [y/N] `,
    );
    if (answer.trim().toLowerCase() === "y") agent.permissions.approve(e.requestId, { remember: "session" });
    else agent.permissions.deny(e.requestId, { reason: "declined at the prompt" });
  })().catch(() => {
    try { agent.permissions.deny(e.requestId, { reason: "the approval prompt failed" }); } catch {}
  });
});

// ── the chat loop ────────────────────────────────────────────────────────────
console.log(bold("agent-chat") + dim(`  sandbox: ${sandbox}`));
console.log(dim("commands: /tools  /quit — writes need your approval\n"));

for (;;) {
  if (stdinClosed) break;
  let line;
  try { line = (await rl.question(`${bold("you")}    `)).trim(); }
  catch { break; }                       // stdin ended mid-question: leave like /quit
  if (line === "" ) continue;
  if (line === "/quit") break;
  if (line === "/tools") {
    for (const t of agent.tools.list()) console.log(dim(`  ${t.id}  [${t.permissions.join(",")}]`));
    continue;
  }
  try {
    await session.send(line);
  } catch (error) {
    console.error(yellow(`turn failed: ${error.message}`));
  }
  console.log();
}

if (!stdinClosed) rl.close();
await permissions.close();
await agent.stop();
