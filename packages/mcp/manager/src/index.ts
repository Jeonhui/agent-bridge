import { watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  AgentBridgeError,
  resolveSecrets,
  type AgentEventPayload,
  type SecretResolver,
} from "@jeonhui/agentbridge-core";
import {
  McpClient,
  maskMcpConfig,
  validateMcpConfig,
  type McpServerConfig,
  type McpServerInfo,
} from "@jeonhui/agentbridge-mcp-client";
import { ToolRegistry, type AgentTool } from "@jeonhui/agentbridge-mcp-registry";

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "reloading"
  | "disconnected"
  | "error";

export interface McpServerState {
  id: string;
  config: McpServerConfig;
  state: McpConnectionState;
  toolCount: number;
  tools: string[];
  serverInfo?: McpServerInfo;
  connectedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean };
  boundSessions: string[];
}

export interface McpReloadResult {
  serverId: string;
  addedTools: string[];
  removedTools: string[];
  changedTools: string[];
  durationMs: number;
  affectedSessions: string[];
}

/** Minimal persistence surface, so the manager does not depend on a storage implementation. */
export interface McpConfigStore {
  list(): Promise<McpServerConfig[]>;
  put(value: McpServerConfig): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface McpLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface McpManagerOptions {
  registry?: ToolRegistry;
  /** Persists registrations so they come back after a restart. */
  storage?: McpConfigStore;
  logger?: McpLogger;
  /** Resolves `secret://` references in server env and headers (spec 26.3). */
  secrets?: SecretResolver;
  /** Receives mcp_status events. The core stamps the envelope. */
  emit?: (payload: AgentEventPayload) => void;
  /** Sessions bound to a server, used to report reload impact. */
  boundSessions?: (serverId: string) => string[];
}

interface Entry {
  /** As registered, with `secret://` references intact. This is what gets persisted. */
  config: McpServerConfig;
  /** With references resolved. Never persisted, never returned from the API. */
  runtimeConfig: McpServerConfig;
  client: McpClient | undefined;
  state: McpConnectionState;
  serverInfo: McpServerInfo | undefined;
  connectedAt: string | undefined;
  lastError: { code: string; message: string; retryable: boolean } | undefined;
  watcher: FSWatcher | undefined;
  debounce: ReturnType<typeof setTimeout> | undefined;
  reloading: Promise<McpReloadResult> | undefined;
}

/**
 * Registers, connects, and hot reloads MCP servers, keeping the Tool Registry in step
 * (spec 10.4, 21, 22). A failure on one server never affects another.
 */
export class McpManager {
  readonly registry: ToolRegistry;
  readonly #entries = new Map<string, Entry>();
  readonly #emit: ((payload: AgentEventPayload) => void) | undefined;
  #boundSessions: (serverId: string) => string[];
  readonly #storage: McpConfigStore | undefined;
  readonly #logger: McpLogger | undefined;
  readonly #secrets: SecretResolver | undefined;

  constructor(options: McpManagerOptions = {}) {
    this.registry = options.registry ?? new ToolRegistry();
    this.#emit = options.emit;
    this.#boundSessions = options.boundSessions ?? (() => []);
    this.#storage = options.storage;
    this.#logger = options.logger;
    this.#secrets = options.secrets;
  }

  /**
   * Reconnects servers registered by a previous process.
   *
   * One server failing to come back must not stop the others, so each is attempted independently
   * and a failure leaves that server in `error` rather than aborting the restore.
   */
  async restore(): Promise<McpServerState[]> {
    if (!this.#storage) return [];

    const restored: McpServerState[] = [];
    for (const config of await this.#storage.list()) {
      if (this.#entries.has(config.id)) continue;

      try {
        restored.push(await this.add(config, { persist: false }));
      } catch (error) {
        this.#logger?.error("mcp.restore_failed", { serverId: config.id, reason: String(error) });
        if (this.#entries.has(config.id)) restored.push(this.get(config.id));
      }
    }

    if (restored.length > 0) this.#logger?.info("mcp.restored", { count: restored.length });
    return restored;
  }

  /**
   * Supplies the session lookup used to guard removal.
   *
   * AgentBridge calls this from attachMcp, so the guard works for every integrator rather than
   * only for those who remembered to pass `boundSessions` to the constructor.
   */
  setBoundSessionsLookup(lookup: (serverId: string) => string[]): void {
    this.#boundSessions = lookup;
  }

  async add(config: McpServerConfig, options: { persist?: boolean } = {}): Promise<McpServerState> {
    validateMcpConfig(config);

    if (this.#entries.has(config.id)) {
      throw new AgentBridgeError("AB-2002", { details: { id: config.id } });
    }

    if (options.persist !== false) await this.#store(config);

    this.#entries.set(config.id, {
      config,
      runtimeConfig: await this.#resolveConfig(config),
      client: undefined,
      state: "disconnected",
      serverInfo: undefined,
      connectedAt: undefined,
      lastError: undefined,
      watcher: undefined,
      debounce: undefined,
      reloading: undefined,
    });

    if (config.enabled === false) return this.get(config.id);
    if (config.autoConnect === false) return this.get(config.id);

    return this.connect(config.id);
  }

  async connect(serverId: string): Promise<McpServerState> {
    const entry = this.#require(serverId);
    if (entry.client?.connected) return this.get(serverId);

    this.#setState(entry, "connecting");

    const attempts = entry.config.retry?.maxAttempts ?? 3;
    const backoffMs = entry.config.retry?.backoffMs ?? 1_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const client = new McpClient(entry.runtimeConfig);
        entry.serverInfo = await client.connect();
        entry.client = client;

        await this.#discover(entry);

        entry.connectedAt = new Date().toISOString();
        entry.lastError = undefined;
        this.#setState(entry, "connected");
        this.#startWatching(entry);
        this.#logger?.info("mcp.connected", {
          serverId,
          transport: entry.config.transport,
          toolCount: this.registry.list({ server: serverId }).length,
        });
        return this.get(serverId);
      } catch (error) {
        lastError = error;
        await entry.client?.close().catch(() => undefined);
        entry.client = undefined;
        if (attempt < attempts) {
          await delay(backoffMs * attempt);
        }
      }
    }

    // Exhausted retries: park the server in error and leave every other server untouched.
    entry.lastError = toErrorInfo(lastError, "AB-2101");
    this.#setState(entry, "error");
    throw lastError instanceof AgentBridgeError
      ? lastError
      : new AgentBridgeError("AB-2101", { details: { id: serverId }, cause: lastError });
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.#require(serverId);
    this.#stopWatching(entry);
    await entry.client?.close().catch(() => undefined);
    entry.client = undefined;
    this.registry.removeServer(serverId);
    this.#setState(entry, "disconnected");
  }

  async remove(serverId: string, options: { force?: boolean } = {}): Promise<void> {
    const entry = this.#require(serverId);
    const bound = this.#boundSessions(serverId);

    if (bound.length > 0 && !options.force) {
      throw new AgentBridgeError("AB-2004", {
        message: `MCP server ${serverId} is still bound to ${bound.length} session(s)`,
        details: { serverId, sessions: bound },
      });
    }

    await this.disconnect(serverId);
    this.#entries.delete(entry.config.id);
    await this.#storage?.delete(serverId).catch(() => undefined);
    this.#logger?.info("mcp.removed", { serverId });
  }

  /** Expands `secret://` in env and headers so only the connection sees real values. */
  async #resolveConfig(config: McpServerConfig): Promise<McpServerConfig> {
    if (config.transport === "stdio") {
      const env = await resolveSecrets(config.env, this.#secrets);
      return env ? { ...config, env } : config;
    }

    const headers = await resolveSecrets(config.headers, this.#secrets);
    return headers ? { ...config, headers } : config;
  }

  async #store(config: McpServerConfig): Promise<void> {
    try {
      await this.#storage?.put(config);
    } catch (error) {
      // Losing the registration record must not prevent the server from connecting now.
      this.#logger?.error("mcp.persist_failed", { serverId: config.id, reason: String(error) });
    }
  }

  /**
   * Tears the connection down, restarts it, and diffs the registry (spec 22.3).
   * Concurrent reloads for one server collapse into a single run.
   */
  async reload(serverId: string): Promise<McpReloadResult> {
    const entry = this.#require(serverId);
    if (entry.reloading) return entry.reloading;

    const run = this.#reload(entry).finally(() => {
      entry.reloading = undefined;
    });
    entry.reloading = run;
    return run;
  }

  get(serverId: string): McpServerState {
    const entry = this.#require(serverId);
    const tools = this.registry.list({ server: serverId });

    return {
      id: entry.config.id,
      config: maskMcpConfig(entry.config),
      state: entry.state,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name),
      boundSessions: this.#boundSessions(entry.config.id),
      ...(entry.serverInfo ? { serverInfo: entry.serverInfo } : {}),
      ...(entry.connectedAt ? { connectedAt: entry.connectedAt } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    };
  }

  list(): McpServerState[] {
    return [...this.#entries.keys()].map((id) => this.get(id));
  }

  has(serverId: string): boolean {
    return this.#entries.has(serverId);
  }

  /** Config the provider needs in order to inject this server into an agent session. */
  resolveForSession(serverIds: string[]): McpServerConfig[] {
    return serverIds.map((id) => {
      const entry = this.#require(id);
      if (entry.state !== "connected") {
        throw new AgentBridgeError("AB-2004", {
          message: `MCP server ${id} is ${entry.state}`,
          details: { serverId: id, state: entry.state },
        });
      }
      return entry.runtimeConfig;
    });
  }

  /** Tools across every server, satisfying the core's McpBinding contract. */
  listTools(filter: { server?: string } = {}): AgentTool[] {
    return this.registry.list(filter);
  }

  getTool(toolId: string): AgentTool {
    return this.registry.get(toolId);
  }

  async callTool(toolId: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    const tool: AgentTool = this.registry.get(toolId);
    const serverId = tool.source.server;
    if (tool.source.type !== "mcp" || !serverId) {
      throw new AgentBridgeError("AB-2201", {
        message: `${toolId} is not an MCP tool`,
        details: { toolId },
      });
    }

    const entry = this.#require(serverId);
    if (!entry.client?.connected) {
      throw new AgentBridgeError("AB-2104", { details: { serverId } });
    }

    const prefix = entry.config.toolPrefix ?? "";
    const remoteName = prefix && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
    return entry.client.callTool(remoteName, args, timeoutMs ?? entry.config.timeoutMs);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.disconnect(id).catch(() => undefined)));
  }

  async #reload(entry: Entry): Promise<McpReloadResult> {
    const started = Date.now();
    const serverId = entry.config.id;
    this.#setState(entry, "reloading");

    await entry.client?.close().catch(() => undefined);
    entry.client = undefined;

    try {
      const client = new McpClient(entry.runtimeConfig);
      entry.serverInfo = await client.connect();
      entry.client = client;

      const diff = await this.#discover(entry);
      entry.connectedAt = new Date().toISOString();
      entry.lastError = undefined;
      this.#setState(entry, "connected");

      const result = {
        serverId,
        addedTools: diff.added,
        removedTools: diff.removed,
        changedTools: diff.changed,
        durationMs: Date.now() - started,
        affectedSessions: this.#boundSessions(serverId),
      };
      this.#logger?.info("mcp.reloaded", {
        serverId,
        added: diff.added.length,
        removed: diff.removed.length,
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      // The old connection is already gone, so the server parks in error and retries next trigger.
      entry.lastError = toErrorInfo(error, "AB-2102");
      this.#setState(entry, "error");
      this.#logger?.error("mcp.error", { serverId, code: entry.lastError.code });
      throw error instanceof AgentBridgeError
        ? error
        : new AgentBridgeError("AB-2102", { details: { serverId }, cause: error });
    }
  }

  async #discover(entry: Entry) {
    const tools = await entry.client!.listTools();
    return this.registry.replaceServerTools(entry.config.id, tools, entry.config.toolPrefix);
  }

  #startWatching(entry: Entry): void {
    if (entry.config.transport !== "stdio") return;
    const watchConfig = entry.config.watch;
    if (!watchConfig?.enabled) return;

    const paths = watchConfig.paths ?? defaultWatchPaths(entry.config);
    const debounceMs = watchConfig.debounceMs ?? 300;

    for (const path of paths) {
      try {
        const watcher = watch(path, { persistent: false }, () => {
          if (entry.debounce) clearTimeout(entry.debounce);
          entry.debounce = setTimeout(() => {
            void this.reload(entry.config.id).catch(() => undefined);
          }, debounceMs);
          entry.debounce.unref?.();
        });
        entry.watcher = watcher;
        break;
      } catch {
        // An unwatchable path is not fatal; explicit reload still works.
      }
    }
  }

  #stopWatching(entry: Entry): void {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = undefined;
    entry.watcher?.close();
    entry.watcher = undefined;
  }

  #setState(entry: Entry, state: McpConnectionState): void {
    entry.state = state;
    this.#emit?.({
      type: "mcp_status",
      serverId: entry.config.id,
      state,
      toolCount: this.registry.list({ server: entry.config.id }).length,
      ...(entry.lastError ? { error: entry.lastError } : {}),
    });
  }

  #require(serverId: string): Entry {
    const entry = this.#entries.get(serverId);
    if (!entry) throw new AgentBridgeError("AB-2003", { details: { serverId } });
    return entry;
  }
}

function defaultWatchPaths(config: McpServerConfig & { transport: "stdio" }): string[] {
  const candidates: string[] = [];
  for (const arg of config.args ?? []) {
    if (arg.startsWith("-")) continue;
    const path = isAbsolute(arg) ? arg : resolve(config.cwd ?? process.cwd(), arg);
    candidates.push(path, dirname(path));
  }
  if (config.cwd) candidates.push(config.cwd);
  return candidates;
}

function toErrorInfo(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string; retryable: boolean } {
  if (error instanceof AgentBridgeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: fallbackCode, message: String(error), retryable: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export type { McpServerConfig, AgentTool };
export { ToolRegistry } from "@jeonhui/agentbridge-mcp-registry";
