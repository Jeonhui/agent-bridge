import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { AgentEvent, AgentEventType } from "@agentbridge/core";

export type ClientFrame =
  | { t: "subscribe"; sessionIds?: string[]; events?: AgentEventType[]; sinceSeq?: number }
  | { t: "unsubscribe"; sessionIds?: string[] }
  | { t: "ping"; ts: number };

export type ServerFrame =
  | { t: "ready"; runtimeVersion: string; serverTime: string }
  | { t: "event"; event: AgentEvent }
  | { t: "subscribed"; sessionIds: string[] }
  | { t: "pong"; ts: number }
  | { t: "error"; error: { code: string; message: string; retryable: boolean } };

interface Subscriber {
  socket: WebSocket;
  /** Undefined means every session (spec 17.3). */
  sessionIds: Set<string> | undefined;
  events: Set<AgentEventType> | undefined;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;

export interface WebSocketHubOptions {
  /** Retained events after `sinceSeq`, used to close the gap a dropped connection opened. */
  replay?: (sessionId: string, sinceSeq: number) => AgentEvent[];
  /** Whether the requested `sinceSeq` fell outside retention, which is AB-5003. */
  hasGap?: (sessionId: string, sinceSeq: number) => boolean;
  /** Sessions a subscriber may replay when it subscribes to all of them. */
  knownSessions?: () => string[];
}

/** WebSocket fan-out for the runtime (spec 17). */
export class WebSocketHub {
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #subscribers = new Set<Subscriber>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #replay: ((sessionId: string, sinceSeq: number) => AgentEvent[]) | undefined;
  readonly #hasGap: ((sessionId: string, sinceSeq: number) => boolean) | undefined;
  readonly #knownSessions: (() => string[]) | undefined;

  constructor(options: WebSocketHubOptions = {}) {
    this.#replay = options.replay;
    this.#hasGap = options.hasGap;
    this.#knownSessions = options.knownSessions;
    this.#heartbeat = setInterval(() => this.#sweep(), HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  accept(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#register(ws));
  }

  broadcast(event: AgentEvent): void {
    for (const subscriber of this.#subscribers) {
      if (subscriber.sessionIds && !subscriber.sessionIds.has(event.sessionId)) continue;
      if (subscriber.events && !subscriber.events.has(event.type)) continue;
      this.#send(subscriber.socket, { t: "event", event });
    }
  }

  closeAll(): void {
    clearInterval(this.#heartbeat);
    for (const subscriber of this.#subscribers) subscriber.socket.close();
    this.#subscribers.clear();
    this.#wss.close();
  }

  #register(socket: WebSocket): void {
    const subscriber: Subscriber = {
      socket,
      sessionIds: undefined,
      events: undefined,
      alive: true,
    };
    this.#subscribers.add(subscriber);

    socket.on("pong", () => {
      subscriber.alive = true;
    });

    socket.on("message", (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        this.#send(socket, {
          t: "error",
          error: { code: "AB-5004", message: "frame is not valid JSON", retryable: false },
        });
        return;
      }
      this.#onFrame(subscriber, frame);
    });

    socket.on("close", () => this.#subscribers.delete(subscriber));
    socket.on("error", () => this.#subscribers.delete(subscriber));

    this.#send(socket, {
      t: "ready",
      runtimeVersion: "0.0.0",
      serverTime: new Date().toISOString(),
    });
  }

  #onFrame(subscriber: Subscriber, frame: ClientFrame): void {
    switch (frame.t) {
      case "subscribe": {
        subscriber.sessionIds = frame.sessionIds ? new Set(frame.sessionIds) : undefined;
        subscriber.events = frame.events ? new Set(frame.events) : undefined;
        this.#send(subscriber.socket, { t: "subscribed", sessionIds: frame.sessionIds ?? [] });

        if (frame.sinceSeq !== undefined) this.#replayTo(subscriber, frame.sinceSeq);
        return;
      }
      case "unsubscribe": {
        if (!frame.sessionIds || !subscriber.sessionIds) {
          subscriber.sessionIds = new Set();
          return;
        }
        for (const id of frame.sessionIds) subscriber.sessionIds.delete(id);
        return;
      }
      case "ping": {
        this.#send(subscriber.socket, { t: "pong", ts: frame.ts });
        return;
      }
    }
  }

  /**
   * Replays what the subscriber missed (spec 17.3).
   *
   * Without this a reconnecting client silently loses every event that arrived while it was
   * away, even though it told the server exactly where it left off.
   */
  #replayTo(subscriber: Subscriber, sinceSeq: number): void {
    if (!this.#replay) return;

    const sessions = subscriber.sessionIds
      ? [...subscriber.sessionIds]
      : (this.#knownSessions?.() ?? []);

    for (const sessionId of sessions) {
      if (this.#hasGap?.(sessionId, sinceSeq)) {
        this.#send(subscriber.socket, {
          t: "error",
          error: {
            code: "AB-5003",
            message: `events before seq ${sinceSeq} are outside retention for session ${sessionId}`,
            retryable: false,
          },
        });
      }

      for (const event of this.#replay(sessionId, sinceSeq)) {
        if (subscriber.events && !subscriber.events.has(event.type)) continue;
        this.#send(subscriber.socket, { t: "event", event });
      }
    }
  }

  /** Drops connections that stopped answering pings (spec 17.4). */
  #sweep(): void {
    for (const subscriber of this.#subscribers) {
      if (!subscriber.alive) {
        subscriber.socket.terminate();
        this.#subscribers.delete(subscriber);
        continue;
      }
      subscriber.alive = false;
      subscriber.socket.ping();
    }
  }

  #send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }
}
