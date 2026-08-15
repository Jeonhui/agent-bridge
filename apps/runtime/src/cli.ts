#!/usr/bin/env node
import {
  AgentBridge,
  ChainSecretResolver,
  EnvSecretResolver,
  FileStorage,
  KeychainSecretResolver,
  Logger,
  type LogLevel,
} from "@jeonhui/agentbridge";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpManager } from "@jeonhui/agentbridge/mcp";
import { PermissionManager } from "@jeonhui/agentbridge/permission";
import { ClaudeProvider } from "@jeonhui/agentbridge/claude";
import { CodexProvider } from "@jeonhui/agentbridge/codex";
import { listAgents } from "@jeonhui/agentbridge/provider";
import { RuntimeServer, credentialsPath, writeCredentials } from "@jeonhui/agentbridge/runtime";

const USAGE = `agentbridge - local AI agent runtime

Usage:
  agentbridge serve [--port <n>] [--host <addr>] [--log-level <level>] [--data-dir <path>]
  agentbridge agents [--json]
  agentbridge --help

serve   Start the local runtime. Prints its address and token, and writes them to
        ~/.agentbridge/runtime.json with owner-only permissions.
agents  Report which agent CLIs are installed on this machine.
`;

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function serve(): Promise<void> {
  const logger = new Logger({ level: (flag("log-level") ?? "info") as LogLevel });

  const dataDir = flag("data-dir") ?? join(homedir(), ".agentbridge");

  // The OS credential store first, the environment second - the latter is what CI usually has.
  const secrets = new ChainSecretResolver(new KeychainSecretResolver(), new EnvSecretResolver());

  const agent = new AgentBridge({
    secrets,
    logLevel: (flag("log-level") ?? "info") as LogLevel,
    logger,
    // A daemon outlives the processes that talk to it, so its state belongs on disk.
    storage: new FileStorage({
      dataDir,
      onCorrupt: (path, quarantinedTo) =>
        logger.error("storage.quarantined", { path, quarantinedTo }),
    }),
  });
  agent.registerProvider(new ClaudeProvider());
  agent.registerProvider(new CodexProvider());

  const mcp = new McpManager({
    emit: (payload) => forward(agent, "mcp", payload),
    logger,
    storage: {
      list: async () => (await agent.storage.mcpServers.list()) as never,
      put: (config) => agent.storage.mcpServers.put(config as never),
      delete: (id) => agent.storage.mcpServers.delete(id),
    },
    secrets,
  });

  const permissions = new PermissionManager({
    emit: (payload) => forward(agent, "permissions", payload),
    logger,
    storage: {
      rules: {
        list: async () => (await agent.storage.permissionRules.list()) as never,
        put: (rule) => agent.storage.permissionRules.put(rule as never),
        delete: (id) => agent.storage.permissionRules.delete(id),
      },
      appendApproval: (record) => agent.storage.appendApproval(record as never),
    },
  });

  agent.attachMcp(mcp);
  agent.attachPermissions(permissions);
  await agent.start();

  const server = new RuntimeServer({
    agent,
    ...(flag("port") ? { port: Number(flag("port")) } : {}),
    ...(flag("host") ? { host: flag("host")! } : {}),
  });
  const address = await server.start();

  const path = credentialsPath();
  await writeCredentials(path, {
    token: address.token,
    port: address.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  logger.info("runtime.listening", {
    host: address.host,
    port: address.port,
    // Named so redaction does not mask it: the path is useful in logs, the file contents are not.
    runtimeFile: path,
    dataDir,
  });
  console.log(JSON.stringify({ host: address.host, port: address.port, token: address.token }));

  // Log every lifecycle event, which is what makes a headless daemon debuggable (spec 27.1).
  agent.on("status", (event) =>
    logger.info("session.status", {
      sessionId: event.sessionId,
      from: event.previous,
      to: event.status,
    }),
  );
  agent.on("tool_call", (event) =>
    logger.info("tool.called", { sessionId: event.sessionId, toolId: event.toolId, callId: event.callId }),
  );
  agent.on("error", (event) =>
    logger.error("session.error", { sessionId: event.sessionId, code: event.error.code }),
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("agent.stopping", { signal });
    await server.stop();
    await agent.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Managers emit envelope-free payloads; the runtime stamps one so they reach subscribers. */
function forward(agent: AgentBridge, source: string, payload: Record<string, unknown>): void {
  agent.events.emit({
    id: `${source}_${Date.now()}_${Math.round(performance.now())}`,
    seq: 0,
    sessionId: source,
    timestamp: new Date().toISOString(),
    ...payload,
  } as never);
}

async function agents(): Promise<void> {
  const detected = await listAgents();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(detected, null, 2));
    return;
  }

  for (const agent of detected) {
    const status = agent.available ? `installed ${agent.version ?? ""}`.trim() : "missing";
    console.log(`${agent.id.padEnd(8)} ${status.padEnd(20)} ${agent.executablePath ?? agent.reason ?? ""}`);
  }
}

const command = process.argv[2];

if (command === "serve") await serve();
else if (command === "agents") await agents();
else {
  console.log(USAGE);
  process.exit(command === "--help" || command === undefined ? 0 : 1);
}
