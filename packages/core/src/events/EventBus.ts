import type { AgentEvent, AgentEventOf, AgentEventType, Unsubscribe } from "./types.js";

type AnyHandler = (event: AgentEvent) => void;

export interface EventBusOptions {
  /** Retention limit per session. Oldest events are dropped first (spec 15.3, 17.4). */
  retentionPerSession?: number;
  /** Reports exceptions thrown by subscribers. They are never propagated to other subscribers. */
  onHandlerError?: (error: unknown, event: AgentEvent) => void;
}

const ALL_SESSIONS = Symbol("all-sessions");

/**
 * One subscription. Identity lives on this object rather than on the handler function,
 * so the same function may be subscribed several times with different scopes.
 */
interface Subscription {
  handler: AnyHandler;
  scope: string | typeof ALL_SESSIONS;
  active: boolean;
}

/**
 * Event bus that guarantees ordering within a session.
 * Ordering across sessions is not guaranteed (spec 15.3).
 */
export class EventBus {
  readonly #retention: number;
  readonly #onHandlerError: ((error: unknown, event: AgentEvent) => void) | undefined;
  readonly #subscriptions = new Map<AgentEventType | "*", Set<Subscription>>();
  readonly #buffer = new Map<string, AgentEvent[]>();
  readonly #pending: AgentEvent[] = [];
  #dispatching = false;

  constructor(options: EventBusOptions = {}) {
    this.#retention = options.retentionPerSession ?? 1000;
    this.#onHandlerError = options.onHandlerError;
  }

  /** Global subscription. Receives events from every session. */
  on<E extends AgentEventType>(type: E, handler: (event: AgentEventOf<E>) => void): Unsubscribe;
  on(type: "*", handler: (event: AgentEvent) => void): Unsubscribe;
  on(type: AgentEventType | "*", handler: (event: never) => void): Unsubscribe {
    return this.#subscribe(type, handler as AnyHandler, ALL_SESSIONS);
  }

  /** Session-scoped subscription. Receives events from that session only. */
  onSession<E extends AgentEventType>(
    sessionId: string,
    type: E,
    handler: (event: AgentEventOf<E>) => void,
  ): Unsubscribe;
  onSession(sessionId: string, type: "*", handler: (event: AgentEvent) => void): Unsubscribe;
  onSession(
    sessionId: string,
    type: AgentEventType | "*",
    handler: (event: never) => void,
  ): Unsubscribe {
    return this.#subscribe(type, handler as AnyHandler, sessionId);
  }

  /**
   * Emits an event. A nested emit from inside a handler is queued and drained after the
   * current event finishes, so subscribers always observe a session's events in `seq` order.
   */
  emit(event: AgentEvent): void {
    this.#retain(event);
    this.#pending.push(event);
    if (this.#dispatching) return;

    this.#dispatching = true;
    try {
      while (this.#pending.length > 0) {
        this.#dispatch(this.#pending.shift()!);
      }
    } finally {
      this.#dispatching = false;
      this.#pending.length = 0;
    }
  }

  /** Reconnect recovery: returns retained events after `sinceSeq` (spec 17.3). */
  replay(sessionId: string, sinceSeq = 0): AgentEvent[] {
    return (this.#buffer.get(sessionId) ?? []).filter((e) => e.seq > sinceSeq);
  }

  /** Whether the range after `sinceSeq` was lost to the retention limit. True means AB-5003. */
  hasGap(sessionId: string, sinceSeq: number): boolean {
    const buffered = this.#buffer.get(sessionId);
    if (!buffered || buffered.length === 0) return sinceSeq > 0;
    return buffered[0]!.seq > sinceSeq + 1;
  }

  clearSession(sessionId: string): void {
    this.#buffer.delete(sessionId);
  }

  #dispatch(event: AgentEvent): void {
    for (const key of [event.type, "*"] as const) {
      const subscriptions = this.#subscriptions.get(key);
      if (!subscriptions) continue;

      // Snapshot so subscribing or unsubscribing during dispatch stays safe.
      for (const subscription of [...subscriptions]) {
        if (!subscription.active) continue;
        if (subscription.scope !== ALL_SESSIONS && subscription.scope !== event.sessionId) continue;

        try {
          subscription.handler(event);
        } catch (error) {
          this.#onHandlerError?.(error, event);
        }
      }
    }
  }

  #subscribe(
    type: AgentEventType | "*",
    handler: AnyHandler,
    scope: string | typeof ALL_SESSIONS,
  ): Unsubscribe {
    let subscriptions = this.#subscriptions.get(type);
    if (!subscriptions) {
      subscriptions = new Set();
      this.#subscriptions.set(type, subscriptions);
    }

    const subscription: Subscription = { handler, scope, active: true };
    subscriptions.add(subscription);

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      subscriptions.delete(subscription);
    };
  }

  #retain(event: AgentEvent): void {
    let buffered = this.#buffer.get(event.sessionId);
    if (!buffered) {
      buffered = [];
      this.#buffer.set(event.sessionId, buffered);
    }
    buffered.push(event);
    if (buffered.length > this.#retention) {
      buffered.splice(0, buffered.length - this.#retention);
    }
  }
}
