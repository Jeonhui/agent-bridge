import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import { EventBus } from "../events/EventBus.js";
import { Logger } from "../logging/Logger.js";
import { MemoryStorage } from "../storage/MemoryStorage.js";
import type { Identified, Storage } from "../storage/Storage.js";
import type { AgentEventOf, AgentEventType, Unsubscribe } from "../events/types.js";
import { SessionManager, type SessionProvider, type SendResult } from "../session/SessionManager.js";
import type { AgentSession, CreateSessionOptions, SessionStatus } from "../session/types.js";
import { resolveConfig, type AgentBridgeConfig, type ResolvedConfig } from "./config.js";

export interface ProviderRegistration extends SessionProvider {
  readonly name: string;
  detect(): Promise<{ available: boolean; version?: string; reason?: string }>;
}

/**
 * The MCP surface the core consumes. Declared structurally so core never imports the MCP
 * packages, keeping the dependency direction of spec 8.4 intact.
 */
export interface McpBinding {
  resolveForSession(serverIds: string[]): unknown[];
  listTools(filter?: { server?: string }): ToolDescriptor[];
  getTool(toolId: string): ToolDescriptor;
  callTool(toolId: string, args: unknown, timeoutMs?: number): Promise<unknown>;
  add(config: unknown): Promise<unknown>;
  remove(serverId: string, options?: { force?: boolean }): Promise<void>;
  connect(serverId: string): Promise<unknown>;
  disconnect(serverId: string): Promise<void>;
  reload(serverId: string): Promise<unknown>;
  list(): unknown[];
  get(serverId: string): unknown;
  /** Receives the lookup used to guard removal of a server a session still binds. */
  setBoundSessionsLookup?(lookup: (serverId: string) => string[]): void;
  /** Reloads servers registered by a previous process. */
  restore?(): Promise<unknown[]>;
  closeAll?(): Promise<void>;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  source: { type: string; server?: string };
  permissions: string[];
}

/**
 * The permission surface the core consumes, declared structurally for the same reason as
 * McpBinding: the core stays free of package dependencies (spec 8.4).
 */
export interface PermissionBinding {
  authorize(input: {
    toolId: string;
    tool: string;
    callId: string;
    sessionId: string;
    provider: string;
    permissions: string[];
    mode: string;
    arguments?: unknown;
    signal?: AbortSignal;
  }): Promise<{ effect: string; reason?: string; matchedRuleId?: string }>;
  approve(requestId: string, options?: { remember?: string; decidedBy?: string }): void;
  deny(requestId: string, options?: { reason?: string; decidedBy?: string }): void;
  pending(sessionId?: string): unknown[];
  setRule(rule: unknown): void;
  listRules(): unknown[];
  cancelSession(sessionId: string, reason?: string): void;
  /** Reloads rules written by a previous process. */
  restore?(): Promise<unknown[]>;
  /**
   * Describes the MCP tool an agent should consult before each tool call, starting whatever
   * machinery that needs. Returning undefined means the provider gets no hook and `ask` falls
   * back to the CLI's own prompt (spec 25.4).
   */
  promptTool?(sessionId: string): Promise<
    { server: Record<string, unknown>; toolName: string } | undefined
  >;
}

export interface ToolCallOptions {
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolCallResult {
  toolId: string;
  ok: boolean;
  content?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  durationMs: number;
}

/** Session facade handed to callers, so events can be scoped without passing ids around. */
export interface Session {
  readonly id: string;
  readonly info: AgentSession;
  send(message: string): Promise<SendResult>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  updateMcp(serverIds: string[]): Promise<AgentSession>;
  setPermissionMode(mode: AgentSession["permissionMode"]): Promise<AgentSession>;
  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe;
}

/**
 * Entry point for Embedded Mode (spec 9.1 / 14.1).
 *
 * Providers are registered by the caller, so the core never imports an adapter package
 * and the dependency direction of spec 8.4 holds.
 */
export class AgentBridge {
  readonly #config: ResolvedConfig;
  readonly #events: EventBus;
  readonly #registry = new Map<string, ProviderRegistration>();
  readonly #sessionManager: SessionManager;
  readonly #storage: Storage<Identified, Identified, Identified>;
  readonly #logger: Logger;
  #mcp: McpBinding | undefined;
  #permissions: PermissionBinding | undefined;
  #started = false;

  constructor(config: AgentBridgeConfig = {}) {
    this.#config = resolveConfig(config);
    this.#events = new EventBus({ retentionPerSession: this.#config.eventRetentionPerSession });
    this.#logger = config.logger ?? new Logger({ level: this.#config.logLevel });
    this.#storage = config.storage ?? new MemoryStorage();

    this.#sessionManager = new SessionManager({
      providers: { get: (id) => this.#requireProvider(id) },
      events: this.#events,
      storage: this.#storage.sessions as never,
      logger: this.#logger,
      ...(config.secrets ? { secrets: config.secrets } : {}),
      defaultWorkingDirectory: this.#config.workingDirectory,
      defaultPermissionMode: this.#config.defaultPermissionMode,
      resolveMcp: (serverIds) => this.#mcp?.resolveForSession(serverIds) ?? [],
      permissionPrompt: (sessionId) =>
        this.#permissions?.promptTool?.(sessionId) ?? Promise.resolve(undefined),
    });
  }

  get logger(): Logger {
    return this.#logger;
  }

  get storage(): Storage<Identified, Identified, Identified> {
    return this.#storage;
  }

  /** Attaches an MCP manager. Sessions can only bind MCP servers once this is set. */
  attachMcp(mcp: McpBinding): void {
    this.#mcp = mcp;
    mcp.setBoundSessionsLookup?.((serverId) =>
      this.#sessionManager
        .list()
        .filter((session) => session.mcpServers.includes(serverId))
        .map((session) => session.id),
    );
  }

  /** Attaches a permission manager. Without one, tool calls run unchecked. */
  attachPermissions(permissions: PermissionBinding): void {
    this.#permissions = permissions;
  }

  get events(): EventBus {
    return this.#events;
  }

  get config(): ResolvedConfig {
    return this.#config;
  }

  registerProvider(provider: ProviderRegistration): void {
    if (this.#registry.has(provider.id)) {
      throw new AgentBridgeError("AB-1007", { details: { providerId: provider.id } });
    }
    this.#registry.set(provider.id, provider);
  }

  /**
   * Starts the runtime, restoring whatever a previous process left behind.
   *
   * MCP servers reconnect first, so a restored session that binds one finds it there.
   */
  async start(): Promise<void> {
    this.#started = true;

    const mcpServers = (await this.#mcp?.restore?.()) ?? [];
    const rules = (await this.#permissions?.restore?.()) ?? [];
    const sessions = await this.#sessionManager.restore();

    this.#logger.info("agent.started", {
      dataDir: this.#config.dataDir,
      restoredSessions: sessions.length,
      restoredMcpServers: mcpServers.length,
      restoredPermissionRules: rules.length,
    });
  }

  async stop(): Promise<void> {
    await this.#sessionManager.stopAll();
    await this.#mcp?.closeAll?.();
    this.#started = false;
  }

  readonly providers = {
    list: async (): Promise<
      Array<{ id: string; name: string; available: boolean; version?: string; reason?: string }>
    > =>
      Promise.all(
        [...this.#registry.values()].map(async (provider) => ({
          id: provider.id,
          name: provider.name,
          ...(await provider.detect()),
        })),
      ),
    ids: (): string[] => [...this.#registry.keys()],
    detect: async (
      id?: string,
    ): Promise<Array<{ id: string; name: string; available: boolean; version?: string; reason?: string }>> => {
      const providers = id ? [this.#requireProvider(id)] : [...this.#registry.values()];
      return Promise.all(
        providers.map(async (provider) => ({
          id: provider.id,
          name: provider.name,
          ...(await provider.detect()),
        })),
      );
    },
  };

  readonly sessions = {
    create: async (options: CreateSessionOptions): Promise<Session> => {
      this.#requireStarted();
      const info = await this.#sessionManager.create(options);
      return this.#facade(info.id);
    },
    get: (sessionId: string): Session => this.#facade(sessionId),
    list: (filter?: { provider?: string; status?: SessionStatus | SessionStatus[] }): AgentSession[] =>
      this.#sessionManager.list(filter),
    resume: async (sessionId: string): Promise<Session> => {
      this.#requireStarted();
      await this.#sessionManager.resume(sessionId);
      return this.#facade(sessionId);
    },
    updateMcp: (sessionId: string, serverIds: string[]): Promise<AgentSession> =>
      this.#sessionManager.updateMcp(sessionId, serverIds),
    setPermissionMode: (
      sessionId: string,
      mode: AgentSession["permissionMode"],
    ): Promise<AgentSession> => this.#sessionManager.setPermissionMode(sessionId, mode),
    stop: async (sessionId: string): Promise<void> => {
      await this.#sessionManager.stop(sessionId);
      this.#permissions?.cancelSession(sessionId, "the session was stopped");
    },
  };

  readonly tools = {
    list: (filter?: { sessionId?: string; server?: string }): ToolDescriptor[] => {
      const mcp = this.#requireMcp();
      if (!filter?.sessionId) return mcp.listTools(filter);

      const bound = new Set(this.#sessionManager.get(filter.sessionId).mcpServers);
      return mcp
        .listTools()
        .filter((tool) => tool.source.type !== "mcp" || bound.has(tool.source.server ?? ""));
    },

    get: (toolId: string): ToolDescriptor => this.#requireMcp().getTool(toolId),

    /**
     * Runs a tool after checking policy. A denied call resolves with ok:false rather than
     * throwing, so a host rendering a tool list does not need a try/catch per call.
     */
    call: async (toolId: string, args: unknown, options: ToolCallOptions = {}): Promise<ToolCallResult> => {
      const started = Date.now();
      const mcp = this.#requireMcp();
      const tool = mcp.getTool(toolId);

      if (this.#permissions) {
        const session = options.sessionId ? this.#sessionManager.get(options.sessionId) : undefined;
        const decision = await this.#permissions.authorize({
          toolId,
          tool: tool.name,
          callId: `call_${Date.now()}`,
          sessionId: options.sessionId ?? "",
          provider: session?.provider ?? "",
          // A direct host call has no session, so nothing session-scoped can be remembered.
          permissions: tool.permissions,
          mode: session?.permissionMode ?? this.#config.defaultPermissionMode,
          ...(args !== undefined ? { arguments: args } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });

        if (decision.effect !== "allow") {
          const error = new AgentBridgeError("AB-4001", {
            ...(decision.reason ? { message: decision.reason } : {}),
            details: { toolId },
          });
          return { toolId, ok: false, error: error.toJSON(), durationMs: Date.now() - started };
        }
      }

      try {
        const content = await mcp.callTool(toolId, args, options.timeoutMs);
        return { toolId, ok: true, content, durationMs: Date.now() - started };
      } catch (error) {
        const info =
          error instanceof AgentBridgeError
            ? error.toJSON()
            : { code: "AB-2202", message: String(error), retryable: true };
        return { toolId, ok: false, error: info, durationMs: Date.now() - started };
      }
    },
  };

  readonly mcp = {
    add: async (config: unknown): Promise<unknown> => this.#requireMcp().add(config),
    remove: async (serverId: string, options?: { force?: boolean }): Promise<void> =>
      this.#requireMcp().remove(serverId, options),
    connect: async (serverId: string): Promise<unknown> => this.#requireMcp().connect(serverId),
    disconnect: async (serverId: string): Promise<void> => this.#requireMcp().disconnect(serverId),
    reload: async (serverId: string): Promise<unknown> => this.#requireMcp().reload(serverId),
    list: (): unknown[] => this.#requireMcp().list(),
    get: (serverId: string): unknown => this.#requireMcp().get(serverId),
  };

  readonly permissions = {
    approve: (requestId: string, options?: { remember?: string; decidedBy?: string }): void =>
      this.#requirePermissions().approve(requestId, options),
    deny: (requestId: string, options?: { reason?: string; decidedBy?: string }): void =>
      this.#requirePermissions().deny(requestId, options),
    pending: (sessionId?: string): unknown[] => this.#requirePermissions().pending(sessionId),
    setPolicy: (rule: unknown): void => this.#requirePermissions().setRule(rule),
    listPolicies: (): unknown[] => this.#requirePermissions().listRules(),
  };

  /** Global event subscription across every session (spec 15.3). */
  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe {
    return this.#events.on(type, handler);
  }

  #facade(sessionId: string): Session {
    const manager = this.#sessionManager;
    const events = this.#events;

    return {
      id: sessionId,
      get info() {
        return manager.get(sessionId);
      },
      send: (message: string) => manager.send(sessionId, message),
      interrupt: () => manager.interrupt(sessionId),
      stop: () => manager.stop(sessionId),
      updateMcp: (serverIds: string[]) => manager.updateMcp(sessionId, serverIds),
      setPermissionMode: (mode) => manager.setPermissionMode(sessionId, mode),
      on: (type, handler) => events.onSession(sessionId, type, handler),
    };
  }

  #requireMcp(): McpBinding {
    if (!this.#mcp) {
      throw new AgentBridgeError("AB-2003", { message: "no MCP manager is attached" });
    }
    return this.#mcp;
  }

  #requirePermissions(): PermissionBinding {
    if (!this.#permissions) {
      throw new AgentBridgeError("AB-4004", { message: "no permission manager is attached" });
    }
    return this.#permissions;
  }

  #requireProvider(id: string): ProviderRegistration {
    const provider = this.#registry.get(id);
    if (!provider) throw new AgentBridgeError("AB-1001", { details: { providerId: id } });
    return provider;
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw new AgentBridgeError("AB-5005", { message: "call start() before creating sessions" });
    }
  }
}
