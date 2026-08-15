import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { AgentBridge, type AgentEventPayload } from "../../core/index.js";

import { RuntimeServer } from "../server.js";

function echoProvider() {
  return {
    id: "echo",
    name: "Echo",
    detect: async () => ({ available: true }),
    start: async (o: { sessionId: string }) => ({ sessionId: o.sessionId, providerId: "echo" }),
    send: async (
      _handle: unknown,
      message: string,
      { emit }: { emit: (payload: AgentEventPayload) => void },
    ) => {
      emit({ type: "message", role: "assistant", content: `echo:${message}`, delta: false, done: true });
    },
    interrupt: async () => {},
    stop: async () => {},
  };
}

/**
 * A client that buffers frames from the moment the socket exists.
 *
 * Attaching the message listener after the "open" event races the server's `ready` frame,
 * which the server sends immediately on upgrade.
 */
class TestClient {
  readonly socket: WebSocket;
  readonly #buffer: Record<string, unknown>[] = [];
  #waiter: (() => void) | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw: WebSocket.RawData) => {
      this.#buffer.push(JSON.parse(String(raw)) as Record<string, unknown>);
      this.#waiter?.();
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new TestClient(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  async take(count: number, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs;

    while (this.#buffer.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`expected ${count} frames, got ${this.#buffer.length}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    return this.#buffer.splice(0, count);
  }

  close(): void {
    this.socket.close();
  }
}

describe("WebSocket protocol (spec 17)", () => {
  const agent = new AgentBridge();
  const server = new RuntimeServer({ agent, port: 0 });
  let wsUrl: string;
  let token: string;

  before(async () => {
    agent.registerProvider(echoProvider() as never);
    await agent.start();
    const address = await server.start();
    wsUrl = `ws://${address.host}:${address.port}/events`;
    token = address.token;
  });

  after(async () => {
    await server.stop();
    await agent.stop();
  });

  it("refuses a connection without a valid token", async () => {
    await assert.rejects(() => TestClient.connect(`${wsUrl}?token=wrong`));
  });

  it("sends a ready frame on connect", async () => {
    const client = await TestClient.connect(`${wsUrl}?token=${token}`);
    const [ready] = await client.take(1);
    assert.equal(ready?.["t"], "ready");
    client.close();
  });

  it("answers an application ping with a pong carrying the same timestamp", async () => {
    const client = await TestClient.connect(`${wsUrl}?token=${token}`);
    await client.take(1);

    client.send({ t: "ping", ts: 1234 });
    assert.deepEqual((await client.take(1))[0], { t: "pong", ts: 1234 });
    client.close();
  });

  it("reports a malformed frame instead of dropping the connection", async () => {
    const client = await TestClient.connect(`${wsUrl}?token=${token}`);
    await client.take(1);

    client.send("not json");
    const [error] = await client.take(1);
    assert.equal(error?.["t"], "error");
    assert.equal(client.socket.readyState, client.socket.OPEN, "the connection stays open");
    client.close();
  });

  it("streams session events to a subscriber", async () => {
    const client = await TestClient.connect(`${wsUrl}?token=${token}`);
    await client.take(1);

    client.send({ t: "subscribe" });
    assert.equal((await client.take(1))[0]?.["t"], "subscribed");

    const session = await agent.sessions.create({ provider: "echo" });
    await session.send("hi");

    const frames = await client.take(3);
    const events = frames.map((f) => f["event"] as { type: string; content?: string });
    assert.ok(events.some((e) => e.type === "message" && e.content === "echo:hi"));
    client.close();
  });

  it("replays what a reconnecting subscriber missed (spec 17.3)", async () => {
    const session = await agent.sessions.create({ provider: "echo" });

    // A client is connected, then drops.
    const first = await TestClient.connect(`${wsUrl}?token=${token}`);
    await first.take(1);
    first.send({ t: "subscribe", sessionIds: [session.id], events: ["message"] });
    await first.take(1);

    await session.send("before the drop");
    const missed = (await first.take(1))[0]?.["event"] as { seq: number };
    first.close();

    // While it is away, more happens.
    await session.send("while away");

    // It comes back and says where it left off.
    const second = await TestClient.connect(`${wsUrl}?token=${token}`);
    await second.take(1);
    second.send({ t: "subscribe", sessionIds: [session.id], events: ["message"], sinceSeq: missed.seq });
    await second.take(1);

    const replayed = (await second.take(1))[0]?.["event"] as { content: string; seq: number };
    assert.equal(replayed.content, "echo:while away", "the missed event is delivered on reconnect");
    assert.ok(replayed.seq > missed.seq);
    second.close();
  });

  it("reports AB-5003 when the requested seq is outside retention", async () => {
    const small = new AgentBridge({ eventRetentionPerSession: 1 });
    small.registerProvider(echoProvider() as never);
    await small.start();
    const smallServer = new RuntimeServer({ agent: small, port: 0 });
    const address = await smallServer.start();

    const session = await small.sessions.create({ provider: "echo" });
    await session.send("one");
    await session.send("two");

    const client = await TestClient.connect(
      `ws://${address.host}:${address.port}/events?token=${address.token}`,
    );
    await client.take(1);
    client.send({ t: "subscribe", sessionIds: [session.id], sinceSeq: 0 });
    await client.take(1);

    const frames = await client.take(1);
    assert.equal(frames[0]?.["t"], "error");
    assert.equal((frames[0]?.["error"] as { code: string }).code, "AB-5003");

    client.close();
    await smallServer.stop();
    await small.stop();
  });

  it("filters by session id and event type", async () => {
    const a = await agent.sessions.create({ provider: "echo" });
    const b = await agent.sessions.create({ provider: "echo" });

    const client = await TestClient.connect(`${wsUrl}?token=${token}`);
    await client.take(1);
    client.send({ t: "subscribe", sessionIds: [b.id], events: ["message"] });
    await client.take(1);

    await a.send("ignored");
    await b.send("wanted");

    const [frame] = await client.take(1);
    const event = frame?.["event"] as { sessionId: string; content: string };
    assert.equal(event.sessionId, b.id, "events from the other session are filtered out");
    assert.equal(event.content, "echo:wanted");
    client.close();
  });
});
