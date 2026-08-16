import { randomUUID } from "node:crypto";

import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import { EventBus } from "../events/EventBus.js";
import { resolveSecrets } from "../secrets/SecretResolver.js";
import type { SecretResolver } from "../secrets/SecretResolver.js";
import type { Repository } from "../storage/Storage.js";
import { SequenceCounter } from "../events/sequence.js";
import type { AgentEvent, AgentEventPayload } from "../events/types.js";
import { nextStatus, type SessionAction } from "./stateMachine.js";
import type { AgentSession, CreateSessionOptions, SessionStatus } from "./types.js";

/**
 * Minimal provider surface the session layer depends on.
 * Declared structurally so core never imports a provider package (spec 8.4).
 */
export interface SessionProvider {
  readonly id: string;
  start(options: {
    sessionId: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    model?: string;
    systemPrompt?: string;
    resumeToken?: string;
    mcpServers?: unknown[];
    preauthorizedMcpServers?: string[];
    permissionPrompt?: { server: unknown; toolName: string };
  }): Promise<{ sessionId: string; providerId: string; nativeSessionId?: string }>;
  send(
    handle: { sessionId: string; providerId: string; nativeSessionId?: string },
    message: string,
    options: { emit: (payload: AgentEventPayload) => void; signal?: AbortSignal },
  ): Promise<void>;
  interrupt(handle: { sessionId: string; providerId: string }): Promise<void>;
  stop(handle: { sessionId: string; providerId: string }): Promise<void>;
}

export interface SessionProviderLookup {
  get(id: string): SessionProvider;
}

/**
 * How a session is written to storage.
 *
 * Dates become ISO strings so a JSON document survives a round trip, and `nativeSessionId` is
 * kept because it is what lets a restored session continue its conversation (spec 28.2).
 */
export interface PersistedSession {
  id: string;
  provider: string;
  title?: string;
  workingDirectory?: string;
  status: SessionStatus;
  mcpServers: string[];
  model?: string;
  env?: Record<string, string>;
  permissionMode: AgentSession["permissionMode"];
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionManagerOptions {
  providers: SessionProviderLookup;
  events: EventBus;
  /** Persists session metadata. Without it, sessions live only as long as the process. */
  storage?: Repository<PersistedSession>;
  logger?: SessionLogger;
  defaultWorkingDirectory?: string;
  defaultPermissionMode?: AgentSession["permissionMode"];
  /** Turns session MCP ids into the provider-facing configuration (spec 21.4). */
  resolveMcp?: (serverIds: string[]) => unknown[];
  /** Resolves secret:// references in session environment variables (spec 26.3). */
  secrets?: SecretResolver;
  /** Supplies the permission prompt tool for sessions in `ask` mode (spec 25.4). */
  permissionPrompt?: (
    sessionId: string,
  ) => Promise<{ server: unknown; toolName: string } | undefined>;
}

/** Minimal logging surface, declared structurally so core stays dependency-free. */
export interface SessionLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface SessionRecord {
  info: AgentSession;
  handle: { sessionId: string; providerId: string; nativeSessionId?: string };
  /**
   * The exact object handed to provider.start(). Adapters read per-turn values (model) from it
   * at send time, so mutating it here changes the next turn without touching the adapter.
   */
  startOptions: { model?: string; [key: string]: unknown };
  seq: SequenceCounter;
  queueing: boolean;
  turn: { id: string; controller: AbortController; done: Promise<void> } | undefined;
}

export interface SendResult {
  turnId: string;
  queued: boolean;
}

/** Owns session lifecycle, state transitions, and turn serialization (spec 10.3). */
export class SessionManager {
  readonly #providers: SessionProviderLookup;
  readonly #events: EventBus;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #defaultWorkingDirectory: string | undefined;
  readonly #defaultPermissionMode: AgentSession["permissionMode"];
  readonly #resolveMcp: (serverIds: string[]) => unknown[];
  readonly #storage: Repository<PersistedSession> | undefined;
  readonly #logger: SessionLogger | undefined;
  readonly #secrets: SecretResolver | undefined;
  readonly #permissionPrompt:
    | ((sessionId: string) => Promise<{ server: unknown; toolName: string } | undefined>)
    | undefined;

  constructor(options: SessionManagerOptions) {
    this.#providers = options.providers;
    this.#events = options.events;
    this.#defaultWorkingDirectory = options.defaultWorkingDirectory;
    this.#defaultPermissionMode = options.defaultPermissionMode ?? "ask";
    this.#resolveMcp = options.resolveMcp ?? (() => []);
    this.#storage = options.storage;
    this.#logger = options.logger;
    this.#secrets = options.secrets;
    this.#permissionPrompt = options.permissionPrompt;
  }

  /**
   * Reloads sessions written by a previous process (spec 28.2).
   *
   * Every restored session comes back `stopped`, because its agent process is gone. What survives
   * is the metadata and the provider's own session id, so `resume()` can pick the conversation up.
   */
  async restore(): Promise<AgentSession[]> {
    if (!this.#storage) return [];

    const restored: AgentSession[] = [];
    for (const persisted of await this.#storage.list()) {
      if (this.#sessions.has(persisted.id)) continue;

      const info: AgentSession = {
        id: persisted.id,
        provider: persisted.provider,
        status: "stopped",
        mcpServers: persisted.mcpServers,
        permissionMode: persisted.permissionMode,
        createdAt: new Date(persisted.createdAt),
        updatedAt: new Date(persisted.updatedAt),
        ...(persisted.title ? { title: persisted.title } : {}),
        ...(persisted.workingDirectory ? { workingDirectory: persisted.workingDirectory } : {}),
        ...(persisted.model ? { model: persisted.model } : {}),
        ...(persisted.env ? { env: persisted.env } : {}),
        ...(persisted.nativeSessionId ? { nativeSessionId: persisted.nativeSessionId } : {}),
      };

      this.#sessions.set(persisted.id, {
        info,
        handle: {
          sessionId: persisted.id,
          providerId: persisted.provider,
          ...(persisted.nativeSessionId ? { nativeSessionId: persisted.nativeSessionId } : {}),
        },
        startOptions: { sessionId: persisted.id },   // rebuilt properly on resume()
        seq: new SequenceCounter(),
        queueing: true,
        turn: undefined,
      });

      restored.push({ ...info });
    }

    if (restored.length > 0) {
      this.#logger?.info("sessions.restored", { count: restored.length });
    }
    return restored;
  }

  async create(options: CreateSessionOptions): Promise<AgentSession> {
    if (!options.provider) {
      throw new AgentBridgeError("AB-3001", { message: "provider is required" });
    }

    const provider = this.#providers.get(options.provider);
    const now = new Date();
    const id = randomUUID();
    const workingDirectory = options.workingDirectory ?? this.#defaultWorkingDirectory;

    const info: AgentSession = {
      id,
      provider: provider.id,
      status: "starting",
      mcpServers: options.mcp ?? [],
      permissionMode: options.permissionMode ?? this.#defaultPermissionMode,
      createdAt: now,
      updatedAt: now,
      ...(options.title ? { title: options.title } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.env ? { env: options.env } : {}),
    };

    const record: SessionRecord = {
      info,
      handle: { sessionId: id, providerId: provider.id },
      startOptions: { sessionId: id },
      seq: new SequenceCounter(),
      queueing: options.queueing ?? true,
      turn: undefined,
    };
    this.#sessions.set(id, record);

    const mcpServers = this.#resolveMcp(info.mcpServers);

    // Under "allow", AgentBridge has already made the decision, so the agent CLI must not
    // re-prompt: its own prompt resolves to a denial in non-interactive mode (spec 25.3).
    const preauthorized = info.permissionMode === "allow" ? info.mcpServers : [];

    // Under "ask", the decision has to reach the host, which needs the prompt hook (spec 25.4).
    const permissionPrompt =
      info.permissionMode === "ask" ? await this.#permissionPrompt?.(id) : undefined;

    try {
      // References resolve here, so the stored session keeps `secret://` and only the child
      // process ever sees the real value (spec 26.3).
      const env = await resolveSecrets(options.env, this.#secrets);

      record.startOptions = {
        sessionId: id,
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(preauthorized.length > 0 ? { preauthorizedMcpServers: preauthorized } : {}),
        ...(permissionPrompt ? { permissionPrompt } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(env ? { env } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      };
      const handle = await provider.start(record.startOptions as never);
      record.handle = handle;
      if (handle.nativeSessionId) record.info.nativeSessionId = handle.nativeSessionId;
      this.#transition(record, "started");
    } catch (error) {
      this.#transition(record, "fail", error);
      throw error;
    }

    this.#logger?.info("session.created", {
      sessionId: id,
      provider: provider.id,
      mcpServers: info.mcpServers,
    });
    await this.#persist(record);
    return { ...record.info };
  }

  get(sessionId: string): AgentSession {
    return { ...this.#require(sessionId).info };
  }

  list(filter: { provider?: string; status?: SessionStatus | SessionStatus[] } = {}): AgentSession[] {
    const statuses = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;

    return [...this.#sessions.values()]
      .filter((r) => (filter.provider ? r.info.provider === filter.provider : true))
      .filter((r) => (statuses ? statuses.has(r.info.status) : true))
      .map((r) => ({ ...r.info }));
  }

  /**
   * Sends a message and resolves when the turn completes.
   * A send during a running turn waits for it unless queueing is disabled (spec 13.2).
   */
  async send(sessionId: string, message: string): Promise<SendResult> {
    const record = this.#require(sessionId);

    if (record.info.status === "stopped" || record.info.status === "error") {
      throw new AgentBridgeError("AB-3002", { details: { sessionId, status: record.info.status } });
    }

    const inFlight = record.turn;
    if (inFlight) {
      if (!record.queueing) {
        throw new AgentBridgeError("AB-3003", { details: { sessionId } });
      }
      await inFlight.done.catch(() => undefined);
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    const done = this.#runTurn(record, turnId, message, controller);
    record.turn = { id: turnId, controller, done };

    try {
      await done;
    } finally {
      record.turn = undefined;
    }

    return { turnId, queued: inFlight !== undefined };
  }

  async interrupt(sessionId: string): Promise<void> {
    const record = this.#require(sessionId);
    const turn = record.turn;
    if (!turn) {
      throw new AgentBridgeError("AB-3006", { details: { sessionId } });
    }

    turn.controller.abort();
    await this.#providers.get(record.info.provider).interrupt(record.handle).catch(() => undefined);
    await turn.done.catch(() => undefined);
  }

  /** Rebinds a live session's MCP servers (spec 13.3). Applies to the next turn. */
  async updateMcp(sessionId: string, serverIds: string[]): Promise<AgentSession> {
    const record = this.#require(sessionId);
    if (record.info.status === "stopped" || record.info.status === "error") {
      throw new AgentBridgeError("AB-3002", { details: { sessionId, status: record.info.status } });
    }

    // Resolving first means an unusable server is rejected before the session is mutated.
    this.#resolveMcp(serverIds);
    record.info.mcpServers = [...serverIds];
    record.info.updatedAt = new Date();
    await this.#persist(record);
    return { ...record.info };
  }

  /**
   * Switches the model for the next turn (spec 13.3).
   *
   * Works mid-conversation without losing context: adapters run one CLI process per turn and read
   * the model from the retained start options at send time, while continuity comes from the CLI's
   * own session id. The adapter contract requires reading per-turn values at send time, not
   * caching them at start.
   */
  async setModel(sessionId: string, model: string): Promise<AgentSession> {
    const record = this.#require(sessionId);
    if (!model || typeof model !== "string") {
      throw new AgentBridgeError("AB-3001", { message: "a model name is required" });
    }

    record.info.model = model;
    record.startOptions["model"] = model;
    record.info.updatedAt = new Date();
    await this.#persist(record);
    return { ...record.info };
  }

  async setPermissionMode(
    sessionId: string,
    mode: AgentSession["permissionMode"],
  ): Promise<AgentSession> {
    const record = this.#require(sessionId);
    if (!["ask", "allow", "deny"].includes(mode)) {
      throw new AgentBridgeError("AB-3001", { message: `unknown permission mode: ${mode}` });
    }

    record.info.permissionMode = mode;
    record.info.updatedAt = new Date();
    await this.#persist(record);
    return { ...record.info };
  }

  /**
   * Restarts a stopped or failed session, reusing the provider's own session id so the
   * conversation continues where it left off (spec 13.3).
   */
  async resume(sessionId: string): Promise<AgentSession> {
    const record = this.#require(sessionId);

    if (record.info.status !== "stopped" && record.info.status !== "error") {
      return { ...record.info };
    }

    const provider = this.#providers.get(record.info.provider);
    const mcpServers = this.#resolveMcp(record.info.mcpServers);
    const preauthorized = record.info.permissionMode === "allow" ? record.info.mcpServers : [];
    const env = await resolveSecrets(record.info.env, this.#secrets);

    this.#transition(record, "resume");

    try {
      record.startOptions = {
        sessionId: record.info.id,
        ...(record.info.workingDirectory ? { workingDirectory: record.info.workingDirectory } : {}),
        ...(env ? { env } : {}),
        ...(record.info.model ? { model: record.info.model } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(preauthorized.length > 0 ? { preauthorizedMcpServers: preauthorized } : {}),
        ...(record.handle.nativeSessionId ? { resumeToken: record.handle.nativeSessionId } : {}),
      };
      const handle = await provider.start(record.startOptions as never);

      record.handle = handle;
      if (handle.nativeSessionId) record.info.nativeSessionId = handle.nativeSessionId;
      delete record.info.lastError;
      this.#transition(record, "started");
      await this.#persist(record);
      return { ...record.info };
    } catch (error) {
      this.#transition(record, "fail", error);
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const record = this.#require(sessionId);

    // Stopping twice is not an error, but it must not re-enter the provider or log again.
    if (record.info.status === "stopped") return;

    record.turn?.controller.abort();
    await record.turn?.done.catch(() => undefined);
    await this.#providers.get(record.info.provider).stop(record.handle);
    this.#transition(record, "stop");

    this.#logger?.info("session.stopped", {
      sessionId,
      durationMs: Date.now() - record.info.createdAt.getTime(),
    });
    await this.#persist(record);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((id) => this.stop(id).catch(() => undefined)),
    );
  }

  async #runTurn(
    record: SessionRecord,
    turnId: string,
    message: string,
    controller: AbortController,
  ): Promise<void> {
    this.#transition(record, "send");

    const emit = (payload: AgentEventPayload): void => {
      this.#emit(record, payload, turnId);
    };

    try {
      await this.#providers
        .get(record.info.provider)
        .send(record.handle, message, { emit, signal: controller.signal });
      this.#transition(record, controller.signal.aborted ? "interrupt" : "turn_end");
    } catch (error) {
      const info =
        error instanceof AgentBridgeError
          ? error.toJSON()
          : { code: "AB-1006", message: String(error), retryable: true };

      this.#emit(record, { type: "error", error: info, fatal: true }, turnId);
      record.info.lastError = info;
      this.#transition(record, "fail");
      this.#logger?.error("session.error", { sessionId: record.info.id, code: info.code });
      void this.#persist(record);
      throw error;
    }
  }

  #emit(record: SessionRecord, payload: AgentEventPayload, turnId?: string): void {
    const event = {
      id: randomUUID(),
      seq: record.seq.next(),
      sessionId: record.info.id,
      timestamp: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
      ...payload,
    } as AgentEvent;

    this.#events.emit(event);
  }

  #transition(record: SessionRecord, action: SessionAction, cause?: unknown): void {
    const previous = record.info.status;
    const next = nextStatus(previous, action);
    if (next === undefined || next === previous) return;

    record.info.status = next;
    record.info.updatedAt = new Date();

    this.#emit(record, {
      type: "status",
      status: next,
      previous,
      ...(cause !== undefined ? { reason: String(cause) } : {}),
    });
  }

  /** A storage failure must not take a live session down with it. */
  async #persist(record: SessionRecord): Promise<void> {
    if (!this.#storage) return;

    try {
      const { info } = record;
      await this.#storage.put({
        id: info.id,
        provider: info.provider,
        status: info.status,
        mcpServers: info.mcpServers,
        permissionMode: info.permissionMode,
        createdAt: info.createdAt.toISOString(),
        updatedAt: info.updatedAt.toISOString(),
        ...(info.title ? { title: info.title } : {}),
        ...(info.workingDirectory ? { workingDirectory: info.workingDirectory } : {}),
        ...(info.model ? { model: info.model } : {}),
        ...(info.env ? { env: info.env } : {}),
        ...(record.handle.nativeSessionId
          ? { nativeSessionId: record.handle.nativeSessionId }
          : {}),
      });
    } catch (error) {
      this.#logger?.error("session.persist_failed", {
        sessionId: record.info.id,
        reason: String(error),
      });
    }
  }

  #require(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new AgentBridgeError("AB-3004", { details: { sessionId } });
    return record;
  }
}
