import type {
  AgentDefinition,
  AgentEvent,
  AgentEventOf,
  AgentEventType,
  AgentSession,
  CreateSessionInput,
  CreateSessionOptions,
  SessionStatus,
  ToolCallResult,
  ToolDescriptor,
  Unsubscribe,
} from "../core/index.js";

export type {
  AgentDefinition,
  AgentEvent,
  AgentEventOf,
  AgentEventType,
  AgentSession,
  CreateSessionInput,
  CreateSessionOptions,
  SessionStatus,
  ToolCallResult,
  ToolDescriptor,
  Unsubscribe,
};

export interface ProviderSummary {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  /** The model used when a session does not pick one. */
  defaultModel?: string;
  reason?: string;
}

export interface SendResult {
  turnId: string;
  queued: boolean;
}

/** A session handle. Identical whether the backend is embedded or the local runtime. */
export interface ClientSession {
  readonly id: string;
  info(): Promise<AgentSession>;
  send(message: string): Promise<SendResult>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  updateMcp(serverIds: string[]): Promise<AgentSession>;
  setPermissionMode(mode: AgentSession["permissionMode"]): Promise<AgentSession>;
  setModel(model: string): Promise<AgentSession>;
  tools(): Promise<ToolDescriptor[]>;
  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe;
}

/**
 * The client surface (spec 10.8).
 *
 * Both backends implement exactly this, so switching between Embedded Mode and Local Runtime Mode
 * is a transport setting rather than a rewrite.
 */
export interface AgentBridgeClient {
  connect(): Promise<void>;
  close(): Promise<void>;

  providers: {
    list(): Promise<ProviderSummary[]>;
  };

  sessions: {
    create(options: CreateSessionInput): Promise<ClientSession>;
    get(sessionId: string): ClientSession;
    list(filter?: { provider?: string; status?: SessionStatus }): Promise<AgentSession[]>;
    resume(sessionId: string): Promise<ClientSession>;
  };

  agents: {
    define(definition: AgentDefinition): Promise<AgentDefinition>;
    list(): Promise<AgentDefinition[]>;
    get(id: string): Promise<AgentDefinition>;
    remove(id: string): Promise<void>;
  };

  mcp: {
    add(config: unknown): Promise<unknown>;
    remove(serverId: string, options?: { force?: boolean }): Promise<void>;
    reload(serverId: string): Promise<unknown>;
    list(): Promise<unknown[]>;
  };

  tools: {
    list(filter?: { sessionId?: string; server?: string }): Promise<ToolDescriptor[]>;
    call(toolId: string, args: unknown, options?: { sessionId?: string; timeoutMs?: number }): Promise<ToolCallResult>;
  };

  permissions: {
    approve(requestId: string, options?: { remember?: string }): Promise<void>;
    deny(requestId: string, options?: { reason?: string }): Promise<void>;
    pending(sessionId?: string): Promise<unknown[]>;
  };

  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe;
}
