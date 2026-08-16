import type { AgentBridge, AgentEventOf, AgentEventType, Unsubscribe } from "../../core/index.js";

import type {
  AgentBridgeClient,
  AgentDefinition,
  AgentSession,
  ClientSession,
  CreateSessionInput,
  ProviderSummary,
  SendResult,
  SessionStatus,
  ToolCallResult,
  ToolDescriptor,
} from "../types.js";

/** Wraps an in-process AgentBridge so host code can be written against the client interface. */
export class EmbeddedClient implements AgentBridgeClient {
  readonly #agent: AgentBridge;

  constructor(agent: AgentBridge) {
    this.#agent = agent;
  }

  async connect(): Promise<void> {
    await this.#agent.start();
  }

  async close(): Promise<void> {
    await this.#agent.stop();
  }

  readonly providers = {
    list: async (): Promise<ProviderSummary[]> => this.#agent.providers.list(),
  };

  readonly sessions = {
    create: async (options: CreateSessionInput): Promise<ClientSession> => {
      const session = await this.#agent.sessions.create(options);
      return this.#session(session.id);
    },
    get: (sessionId: string): ClientSession => this.#session(sessionId),
    list: async (filter?: { provider?: string; status?: SessionStatus }): Promise<AgentSession[]> =>
      this.#agent.sessions.list(filter),
    resume: async (sessionId: string): Promise<ClientSession> => {
      await this.#agent.sessions.resume(sessionId);
      return this.#session(sessionId);
    },
  };

  readonly agents = {
    define: async (definition: AgentDefinition): Promise<AgentDefinition> =>
      this.#agent.agents.define(definition),
    list: async (): Promise<AgentDefinition[]> => this.#agent.agents.list(),
    get: async (id: string): Promise<AgentDefinition> => this.#agent.agents.get(id),
    remove: async (id: string): Promise<void> => this.#agent.agents.remove(id),
  };

  readonly mcp = {
    add: (config: unknown): Promise<unknown> => this.#agent.mcp.add(config),
    remove: (serverId: string, options?: { force?: boolean }): Promise<void> =>
      this.#agent.mcp.remove(serverId, options),
    reload: (serverId: string): Promise<unknown> => this.#agent.mcp.reload(serverId),
    list: async (): Promise<unknown[]> => this.#agent.mcp.list(),
  };

  readonly tools = {
    list: async (filter?: { sessionId?: string; server?: string }): Promise<ToolDescriptor[]> =>
      this.#agent.tools.list(filter),
    call: async (
      toolId: string,
      args: unknown,
      options?: { sessionId?: string; timeoutMs?: number },
    ): Promise<ToolCallResult> => this.#agent.tools.call(toolId, args, options),
  };

  readonly permissions = {
    approve: async (requestId: string, options?: { remember?: string }): Promise<void> => {
      this.#agent.permissions.approve(requestId, options);
    },
    deny: async (requestId: string, options?: { reason?: string }): Promise<void> => {
      this.#agent.permissions.deny(requestId, options);
    },
    pending: async (sessionId?: string): Promise<unknown[]> => this.#agent.permissions.pending(sessionId),
  };

  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe {
    return this.#agent.on(type, handler);
  }

  #session(sessionId: string): ClientSession {
    const session = this.#agent.sessions.get(sessionId);
    return {
      id: sessionId,
      info: async () => session.info,
      send: async (message: string): Promise<SendResult> => session.send(message),
      interrupt: () => session.interrupt(),
      stop: () => session.stop(),
      updateMcp: (serverIds: string[]) => session.updateMcp(serverIds),
      setPermissionMode: (mode) => session.setPermissionMode(mode),
      setModel: (model: string) => session.setModel(model),
      tools: async () => session.tools(),
      on: (type, handler) => session.on(type, handler),
    };
  }
}
