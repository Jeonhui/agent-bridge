import { AgentBridgeError, type AgentEvent, type AgentEventOf, type AgentEventType, type Unsubscribe } from "../../core/index.js";

import type {
  AgentBridgeClient,
  AgentSession,
  ClientSession,
  CreateSessionOptions,
  ProviderSummary,
  SendResult,
  SessionStatus,
  ToolCallResult,
  ToolDescriptor,
} from "../types.js";

export interface HttpClientOptions {
  /** e.g. http://127.0.0.1:8760 */
  baseUrl: string;
  token: string;
  /** Supplies the WebSocket implementation. Node has none built in; browsers do. */
  webSocket?: WebSocketFactory;
  /** Reconnect backoff ceiling. Defaults to 30000ms (spec 17.4). */
  maxBackoffMs?: number;
  fetch?: typeof fetch;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", handler: (event: never) => void): void;
}

interface Subscription {
  type: AgentEventType;
  sessionId: string | undefined;
  handler: (event: AgentEvent) => void;
  active: boolean;
}

/**
 * Talks to the local runtime over REST and WebSocket (spec 16, 17).
 *
 * Exposes the same interface as the embedded backend, so a host can move between them by
 * changing configuration. Events are recovered on reconnect using the last seq seen per session.
 */
export class HttpClient implements AgentBridgeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #webSocket: WebSocketFactory | undefined;
  readonly #maxBackoffMs: number;
  readonly #subscriptions = new Set<Subscription>();
  readonly #lastSeq = new Map<string, number>();
  #socket: WebSocketLike | undefined;
  #closed = false;
  #backoffMs = 1_000;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#webSocket = options.webSocket;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  async connect(): Promise<void> {
    this.#closed = false;
    await this.#request("GET", "/health");
    if (this.#webSocket) this.#openSocket();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = undefined;
  }

  readonly providers = {
    list: async (): Promise<ProviderSummary[]> =>
      (await this.#request<{ items: ProviderSummary[] }>("GET", "/providers")).items,
  };

  readonly sessions = {
    create: async (options: CreateSessionOptions): Promise<ClientSession> => {
      const session = await this.#request<AgentSession>("POST", "/sessions", options);
      return this.#session(session.id);
    },
    get: (sessionId: string): ClientSession => this.#session(sessionId),
    list: async (filter: { provider?: string; status?: SessionStatus } = {}): Promise<AgentSession[]> => {
      const query = new URLSearchParams();
      if (filter.provider) query.set("provider", filter.provider);
      if (filter.status) query.set("status", filter.status);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return (await this.#request<{ items: AgentSession[] }>("GET", `/sessions${suffix}`)).items;
    },
    resume: async (sessionId: string): Promise<ClientSession> => {
      await this.#request("POST", `/sessions/${sessionId}/resume`);
      return this.#session(sessionId);
    },
  };

  readonly mcp = {
    add: (config: unknown): Promise<unknown> => this.#request("POST", "/mcp", config),
    remove: async (serverId: string, options: { force?: boolean } = {}): Promise<void> => {
      const suffix = options.force ? "?force=true" : "";
      await this.#request("DELETE", `/mcp/${serverId}${suffix}`);
    },
    reload: (serverId: string): Promise<unknown> =>
      this.#request("POST", `/mcp/${serverId}/reload`),
    list: async (): Promise<unknown[]> =>
      (await this.#request<{ items: unknown[] }>("GET", "/mcp")).items,
  };

  readonly tools = {
    list: async (filter: { sessionId?: string; server?: string } = {}): Promise<ToolDescriptor[]> => {
      const query = new URLSearchParams();
      if (filter.sessionId) query.set("sessionId", filter.sessionId);
      if (filter.server) query.set("server", filter.server);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return (await this.#request<{ items: ToolDescriptor[] }>("GET", `/tools${suffix}`)).items;
    },
    call: async (
      toolId: string,
      args: unknown,
      options: { sessionId?: string; timeoutMs?: number } = {},
    ): Promise<ToolCallResult> =>
      this.#request<ToolCallResult>("POST", `/tools/${encodeURIComponent(toolId)}/call`, {
        arguments: args,
        ...options,
      }),
  };

  readonly permissions = {
    approve: async (requestId: string, options: { remember?: string } = {}): Promise<void> => {
      await this.#request("POST", `/permissions/${requestId}/approve`, options);
    },
    deny: async (requestId: string, options: { reason?: string } = {}): Promise<void> => {
      await this.#request("POST", `/permissions/${requestId}/deny`, options);
    },
    pending: async (sessionId?: string): Promise<unknown[]> => {
      const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      return (await this.#request<{ items: unknown[] }>("GET", `/permissions/pending${suffix}`)).items;
    },
  };

  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe {
    return this.#subscribe(type, undefined, handler as (event: AgentEvent) => void);
  }

  #session(sessionId: string): ClientSession {
    return {
      id: sessionId,
      info: () => this.#request<AgentSession>("GET", `/sessions/${sessionId}`),
      send: (message: string) =>
        this.#request<SendResult>("POST", `/sessions/${sessionId}/messages`, { message }),
      interrupt: async () => {
        await this.#request("POST", `/sessions/${sessionId}/interrupt`);
      },
      stop: async () => {
        await this.#request("DELETE", `/sessions/${sessionId}`);
      },
      updateMcp: (serverIds: string[]) =>
        this.#request<AgentSession>("PATCH", `/sessions/${sessionId}/mcp`, { servers: serverIds }),
      setPermissionMode: (mode) =>
        this.#request<AgentSession>("PATCH", `/sessions/${sessionId}/permission-mode`, { mode }),
      on: (type, handler) =>
        this.#subscribe(type, sessionId, handler as (event: AgentEvent) => void),
    };
  }

  #subscribe(
    type: AgentEventType,
    sessionId: string | undefined,
    handler: (event: AgentEvent) => void,
  ): Unsubscribe {
    const subscription: Subscription = { type, sessionId, handler, active: true };
    this.#subscriptions.add(subscription);

    return () => {
      subscription.active = false;
      this.#subscriptions.delete(subscription);
    };
  }

  #openSocket(): void {
    if (!this.#webSocket || this.#closed) return;

    const url = `${this.#baseUrl.replace(/^http/, "ws")}/events?token=${encodeURIComponent(this.#token)}`;
    const socket = this.#webSocket(url);
    this.#socket = socket;

    socket.addEventListener("open", (() => {
      this.#backoffMs = 1_000;
      // Recovering from the last seq per session closes the gap a dropped connection opened.
      const sinceSeq = Math.min(...[...this.#lastSeq.values()], Infinity);
      socket.send(
        JSON.stringify({
          t: "subscribe",
          ...(Number.isFinite(sinceSeq) ? { sinceSeq } : {}),
        }),
      );
    }) as never);

    socket.addEventListener("message", ((event: { data: unknown }) => {
      let frame: { t?: string; event?: AgentEvent };
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch {
        return;
      }
      if (frame.t !== "event" || !frame.event) return;

      const agentEvent = frame.event;
      this.#lastSeq.set(agentEvent.sessionId, agentEvent.seq);

      for (const subscription of [...this.#subscriptions]) {
        if (!subscription.active) continue;
        if (subscription.type !== agentEvent.type) continue;
        if (subscription.sessionId && subscription.sessionId !== agentEvent.sessionId) continue;
        subscription.handler(agentEvent);
      }
    }) as never);

    const reconnect = () => {
      if (this.#closed) return;
      const delay = this.#backoffMs;
      this.#backoffMs = Math.min(delay * 2, this.#maxBackoffMs);
      const timer = setTimeout(() => this.#openSocket(), delay);
      timer.unref?.();
    };

    socket.addEventListener("close", reconnect as never);
    socket.addEventListener("error", reconnect as never);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : undefined;

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new AgentBridgeError((error?.code ?? "AB-5004") as never, {
        ...(error?.message ? { message: error.message } : {}),
        details: { status: response.status, path },
      });
    }

    return payload as T;
  }
}
