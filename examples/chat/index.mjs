#!/usr/bin/env node
// agent-chat: a terminal chat app built on AgentBridge.
//
// What it demonstrates, in the order a real host application meets it:
//   - a session with streaming replies rendered by the host, not by the agent CLI
//   - the agent using tools the host provided (a sandboxed filesystem, over MCP)
//   - ask mode: the agent stops before every write and this app asks YOU, y/n
//
// Run it:   node index.mjs [--model sonnet]     (needs the claude CLI installed and logged in)

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

const modelFlag = process.argv.indexOf("--model");
const session = await agent.sessions.create({
  provider: "claude",
  ...(modelFlag >= 0 && process.argv[modelFlag + 1] ? { model: process.argv[modelFlag + 1] } : {}),
  workingDirectory: sandbox,
  mcp: ["fs"],
  permissionMode: "ask",
});

// ── input: a line queue, because readline drops lines nobody is waiting for ──
// rl.question only catches a line if it is already pending when the line arrives. Paste two
// lines (or pipe input) and the second is silently discarded. The queue keeps every line and
// hands them out in order — to the chat loop and to approval prompts alike.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pendingLines = [];
const waiters = [];
let stdinClosed = false;
rl.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else pendingLines.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  while (waiters.length > 0) waiters.shift()(null);   // wake anyone waiting: no more input
});

/** Prompts and returns the next line, or null once stdin is gone. Never loses a line. */
function nextLine(prompt) {
  process.stdout.write(prompt);
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

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
    const answer = await nextLine(
      `\n${yellow("approve?")} agent wants ${bold(e.tool)} (${e.permissions.join(",")}) ` +
      `${dim(JSON.stringify(e.arguments).slice(0, 60))}  [y/N] `,
    );
    if (answer !== null && answer.trim().toLowerCase() === "y") {
      agent.permissions.approve(e.requestId, { remember: "session" });
    } else {
      agent.permissions.deny(e.requestId, { reason: answer === null ? "no user available to approve" : "declined at the prompt" });
    }
  })().catch(() => {
    try { agent.permissions.deny(e.requestId, { reason: "the approval prompt failed" }); } catch {}
  });
});

// ── the chat loop ────────────────────────────────────────────────────────────
console.log(bold("agent-chat") + dim(`  model: ${session.info.model ?? "(cli default)"}  sandbox: ${sandbox}`));
console.log(dim("commands: /tools  /model <name>  /quit — writes need your approval\n"));

for (;;) {
  const raw = await nextLine(`${bold("you")}    `);
  if (raw === null) break;               // stdin ended: leave like /quit
  const line = raw.trim();
  if (line === "" ) continue;
  if (line === "/quit") break;
  if (line === "/tools") {
    // What THIS session can see: its bound MCP servers plus built-ins.
    for (const id of session.info.mcpServers) {
      const server = agent.mcp.get(id);
      console.log(dim(`  mcp ${id}  ${server.state}  (${server.toolCount} tools)`));
    }
    for (const t of session.tools()) console.log(dim(`    ${t.id}  [${t.permissions.join(",")}]`));
    continue;
  }
  if (line.startsWith("/model")) {
    const name = line.slice(6).trim();
    if (!name) { console.log(dim(`  model: ${session.info.model ?? "(cli default)"}`)); continue; }
    // Mid-conversation switch: the next turn runs on the new model, the context survives.
    await session.setModel(name);
    console.log(dim(`  model → ${name} (conversation continues)`));
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
