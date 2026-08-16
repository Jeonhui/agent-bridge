import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import { EventBus } from "../events/EventBus.js";
import { Logger } from "../logging/Logger.js";
import { MemoryStorage } from "../storage/MemoryStorage.js";
import type { Identified, Storage } from "../storage/Storage.js";
import type { AgentEventOf, AgentEventType, Unsubscribe } from "../events/types.js";
import { SessionManager, type SessionProvider, type SendResult } from "../session/SessionManager.js";
import type { AgentSession, CreateSessionOptions, SessionStatus } from "../session/types.js";
import { AgentDirectory, type AgentDefinition } from "./AgentDirectory.js";
import { resolveConfig, type AgentBridgeConfig, type ResolvedConfig } from "./config.js";

/**
 * `sessions.create` input: either the full options, or an agent definition's id with
 * per-session overrides on top (spec 12.6). With `agent`, everything else is optional.
 */
export type CreateSessionInput =
  | CreateSessionOptions
  | (Partial<CreateSessionOptions> & { agent: string });

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
  /** Switches the model for the next turn; conversation context survives (spec 13.3). */
  setModel(model: string): Promise<AgentSession>;
  /** The tools this session can see: its bound MCP servers plus built-ins (spec 14.3). */
  tools(): ToolDescriptor[];
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
  readonly #agentDirectory = new AgentDirectory();
  /** sessionId -> how many agent-calls-agent hops led here. Host-created sessions are depth 0. */
  readonly #agentDepth = new Map<string, number>();
  /** definitionId -> live sessionId, for definitions with memory: "persistent". */
  readonly #agentSessions = new Map<string, string>();
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
      tools: {
        list: (sessionId) => (this.#mcp ? this.tools.list({ sessionId }) : []),
        call: (sessionId, toolId, args) => this.tools.call(toolId, args, { sessionId }),
      },
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
    this.#agentDepth.clear();
    this.#agentSessions.clear();
    this.#started = false;
  }

  /**
   * Named agent definitions (spec 12.6): declare provider, model, role, and tool bindings once,
   * then create sessions by name — and let other agents call the definition as a tool.
   * Definitions live in code like provider registrations; they are not persisted.
   */
  readonly agents = {
    define: (definition: AgentDefinition): AgentDefinition => this.#agentDirectory.define(definition),
    list: (): AgentDefinition[] => this.#agentDirectory.list(),
    get: (id: string): AgentDefinition => this.#agentDirectory.get(id),
    remove: (id: string): void => this.#agentDirectory.remove(id),
  };

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
    create: async (options: CreateSessionInput): Promise<Session> => {
      this.#requireStarted();
      const resolved =
        "agent" in options && options.agent
          ? this.#optionsFromDefinition(this.#agentDirectory.get(options.agent), options)
          : (options as CreateSessionOptions);
      const info = await this.#sessionManager.create(resolved);
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
    setModel: (sessionId: string, model: string): Promise<AgentSession> =>
      this.#sessionManager.setModel(sessionId, model),
    setPermissionMode: (
      sessionId: string,
      mode: AgentSession["permissionMode"],
    ): Promise<AgentSession> => this.#sessionManager.setPermissionMode(sessionId, mode),
    stop: async (sessionId: string): Promise<void> => {
      await this.#sessionManager.stop(sessionId);
      this.#permissions?.cancelSession(sessionId, "the session was stopped");
      this.#agentDepth.delete(sessionId);
    },
  };

  readonly tools = {
    list: (filter?: { sessionId?: string; server?: string }): ToolDescriptor[] => {
      // A server filter is an MCP concept, so agent tools stay out of a server-scoped list.
      const agentTools = filter?.server ? [] : this.#agentTools();
      if (!this.#mcp) {
        if (this.#agentDirectory.size === 0) this.#requireMcp();
        return agentTools;
      }

      if (!filter?.sessionId) return [...this.#mcp.listTools(filter), ...agentTools];

      const bound = new Set(this.#sessionManager.get(filter.sessionId).mcpServers);
      const mcpTools = this.#mcp
        .listTools()
        .filter((tool) => tool.source.type !== "mcp" || bound.has(tool.source.server ?? ""));
      return [...mcpTools, ...agentTools];
    },

    get: (toolId: string): ToolDescriptor => {
      const definition = this.#agentToolTarget(toolId);
      return definition ? agentToolDescriptor(definition) : this.#requireMcp().getTool(toolId);
    },

    /**
     * Runs a tool after checking policy. A denied call resolves with ok:false rather than
     * throwing, so a host rendering a tool list does not need a try/catch per call.
     */
    call: async (toolId: string, args: unknown, options: ToolCallOptions = {}): Promise<ToolCallResult> => {
      const started = Date.now();
      const definition = this.#agentToolTarget(toolId);
      const tool = definition ? agentToolDescriptor(definition) : this.#requireMcp().getTool(toolId);

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
        const content = definition
          ? await this.#callAgent(definition, args, options.sessionId)
          : await this.#requireMcp().callTool(toolId, args, options.timeoutMs);
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
      setModel: (model: string) => manager.setModel(sessionId, model),
      tools: () => this.tools.list({ sessionId }),
      on: (type, handler) => events.onSession(sessionId, type, handler),
    };
  }

  #agentTools(): ToolDescriptor[] {
    return this.#agentDirectory
      .list()
      .filter((definition) => definition.callable !== false)
      .map(agentToolDescriptor);
  }

  #agentToolTarget(toolId: string): AgentDefinition | undefined {
    const match = /^agent:(.+):ask$/.exec(toolId);
    if (!match || !this.#agentDirectory.has(match[1]!)) return undefined;
    return this.#agentDirectory.get(match[1]!);
  }

  #optionsFromDefinition(
    definition: AgentDefinition,
    overrides: Partial<CreateSessionOptions> = {},
  ): CreateSessionOptions {
    const model = overrides.model ?? definition.model;
    const systemPrompt = overrides.systemPrompt ?? definition.role;
    const mcp = overrides.mcp ?? definition.mcp;
    const permissionMode = overrides.permissionMode ?? definition.permissionMode;
    const workingDirectory = overrides.workingDirectory ?? definition.workingDirectory;
    const env = overrides.env ?? definition.env;
    return {
      provider: overrides.provider ?? definition.provider,
      title: overrides.title ?? definition.name,
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(mcp ? { mcp } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(env ? { env } : {}),
      ...(overrides.queueing !== undefined ? { queueing: overrides.queueing } : {}),
    };
  }

  /**
   * Executes one agent-as-tool call (spec 12.6): run the definition's session, deliver the
   * message, and return the assistant's reply as the tool result. Depth is counted per session
   * chain so an agent can consult another agent without the chain recursing unboundedly.
   */
  async #callAgent(
    definition: AgentDefinition,
    args: unknown,
    callerSessionId: string | undefined,
  ): Promise<unknown> {
    const message =
      typeof args === "object" && args !== null && typeof (args as { message?: unknown }).message === "string"
        ? ((args as { message: string }).message)
        : "";
    if (!message) {
      throw new AgentBridgeError("AB-2203", {
        message: `the agent tool for "${definition.id}" requires a "message" string argument`,
        details: { agentId: definition.id },
      });
    }

    const depth = (callerSessionId ? this.#agentDepth.get(callerSessionId) ?? 0 : 0) + 1;
    if (depth > this.#config.maxAgentCallDepth) {
      throw new AgentBridgeError("AB-1009", {
        message: `agent call depth ${depth} exceeds the limit of ${this.#config.maxAgentCallDepth}`,
        details: { agentId: definition.id, depth, limit: this.#config.maxAgentCallDepth },
      });
    }

    const oneshot = (definition.memory ?? "oneshot") === "oneshot";
    const sessionId = await this.#agentSessionFor(definition, depth);

    // The reply is whatever the assistant says over the turn; deltas accumulate, a full
    // message replaces. Subscribing before send() means nothing can slip past.
    let reply = "";
    const unsubscribe = this.#events.onSession(sessionId, "message", (event) => {
      if (event.role !== "assistant") return;
      reply = event.delta ? reply + event.content : event.content;
    });

    try {
      await this.#sessionManager.send(sessionId, message);
      return { agent: definition.id, sessionId, reply };
    } finally {
      unsubscribe();
      if (oneshot) {
        await this.#sessionManager.stop(sessionId).catch(() => {});
        this.#agentDepth.delete(sessionId);
      }
    }
  }

  async #agentSessionFor(definition: AgentDefinition, depth: number): Promise<string> {
    if ((definition.memory ?? "oneshot") === "persistent") {
      const existing = this.#agentSessions.get(definition.id);
      if (existing) {
        try {
          const status = this.#sessionManager.get(existing).status;
          if (status !== "stopped" && status !== "error") {
            // The deepest caller wins, so a chain through a shared session still hits the cap.
            this.#agentDepth.set(existing, Math.max(depth, this.#agentDepth.get(existing) ?? 0));
            return existing;
          }
        } catch {
          // The session is gone; fall through and recreate it.
        }
      }
    }

    const info = await this.#sessionManager.create(this.#optionsFromDefinition(definition));
    this.#agentDepth.set(info.id, depth);
    if ((definition.memory ?? "oneshot") === "persistent") {
      this.#agentSessions.set(definition.id, info.id);
    }
    return info.id;
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
    if (!provider) {
      const registered = [...this.#registry.keys()];
      throw new AgentBridgeError("AB-1001", {
        message:
          registered.length === 0
            ? `Unknown provider "${id}" — no providers are registered. Call agent.registerProvider(new ClaudeProvider()) before creating a session.`
            : `Unknown provider "${id}". Registered providers: ${registered.join(", ")}.`,
        details: { providerId: id, registered },
      });
    }
    return provider;
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw new AgentBridgeError("AB-5005", { message: "call start() before creating sessions" });
    }
  }
}

/**
 * The tool face of an agent definition (spec 12.6). EXECUTE, because calling an agent runs
 * whatever that agent runs — its own tool calls are then policy-checked individually.
 */
function agentToolDescriptor(definition: AgentDefinition): ToolDescriptor & { inputSchema: unknown } {
  return {
    id: `agent:${definition.id}:ask`,
    name: `ask_${definition.id}`,
    description: `Ask the "${definition.name}" agent. ${definition.description}`,
    source: { type: "agent", server: definition.id },
    permissions: ["EXECUTE"],
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: `What to ask the "${definition.name}" agent.` },
      },
      required: ["message"],
    },
  };
}
