import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import { EventBus } from "../events/EventBus.js";
import type { AgentEvent, AgentEventPayload } from "../events/types.js";
import { SessionManager, type SessionProvider } from "../session/SessionManager.js";

interface FakeOptions {
  onSend?: (
    message: string,
    emit: (payload: AgentEventPayload) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

function fakeProvider(options: FakeOptions = {}): SessionProvider & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    id: "fake",
    stopped,
    start: async (o) => ({ sessionId: o.sessionId, providerId: "fake" }),
    send: async (_handle, message, { emit, signal }) => {
      if (options.onSend) return options.onSend(message, emit, signal);
      emit({ type: "message", role: "assistant", content: `echo:${message}`, delta: false, done: true });
    },
    interrupt: async () => {},
    stop: async (handle) => {
      stopped.push(handle.sessionId);
    },
  };
}

function harness(provider: SessionProvider) {
  const events = new EventBus();
  const received: AgentEvent[] = [];
  events.on("*", (e) => received.push(e));
  const manager = new SessionManager({ providers: { get: () => provider }, events });
  return { manager, received };
}

describe("SessionManager (spec 10.3 / 13.2)", () => {
  it("creates a session that reaches ready and emits the status transition", async () => {
    const { manager, received } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });

    assert.equal(session.status, "ready");
    assert.deepEqual(
      received.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status : "")),
      ["ready"],
    );
  });

  it("stamps a monotonic envelope onto adapter payloads", async () => {
    const { manager, received } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });
    await manager.send(session.id, "hi");

    assert.deepEqual(
      received.map((e) => e.seq),
      received.map((_, i) => i + 1),
    );
    for (const event of received) {
      assert.equal(event.sessionId, session.id);
      assert.ok(event.id);
      assert.ok(Date.parse(event.timestamp) > 0);
    }
  });

  it("tags turn events with a turnId and returns it", async () => {
    const { manager, received } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });
    const result = await manager.send(session.id, "hi");

    const message = received.find((e) => e.type === "message");
    assert.equal(message?.turnId, result.turnId);
  });

  it("returns to ready after a turn so the next send works", async () => {
    const { manager } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });

    await manager.send(session.id, "one");
    assert.equal(manager.get(session.id).status, "ready");
    await manager.send(session.id, "two");
    assert.equal(manager.get(session.id).status, "ready");
  });

  it("serializes overlapping sends instead of interleaving them", async () => {
    const order: string[] = [];
    const provider = fakeProvider({
      onSend: async (message, emit) => {
        order.push(`start:${message}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        emit({ type: "message", role: "assistant", content: message, delta: false, done: true });
        order.push(`end:${message}`);
      },
    });
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    const [first, second] = await Promise.all([
      manager.send(session.id, "a"),
      manager.send(session.id, "b"),
    ]);

    assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
    assert.equal(first?.queued, false);
    assert.equal(second?.queued, true);
  });

  it("keeps three queued senders serialized, not just two", async () => {
    // Two waiters behind one turn used to be released together by a single await; the third
    // sender is what exposes it, so this test pins the while-loop behavior.
    let inTurn = 0;
    let maxInTurn = 0;
    const provider = fakeProvider({
      onSend: async () => {
        inTurn += 1;
        maxInTurn = Math.max(maxInTurn, inTurn);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inTurn -= 1;
      },
    });
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await Promise.all([
      manager.send(session.id, "a"),
      manager.send(session.id, "b"),
      manager.send(session.id, "c"),
      manager.send(session.id, "d"),
    ]);

    assert.equal(maxInTurn, 1, "turns on one session must never overlap");
  });

  it("rejects a concurrent send with AB-3003 when queueing is off", async () => {
    const provider = fakeProvider({
      onSend: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake", queueing: false });

    const inFlight = manager.send(session.id, "a");
    await assert.rejects(
      () => manager.send(session.id, "b"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3003",
    );
    await inFlight;
  });

  it("moves to error and reports AB-3002 on a later send when a turn fails", async () => {
    const provider = fakeProvider({
      onSend: async () => {
        throw new AgentBridgeError("AB-1006", { message: "claude died" });
      },
    });
    const { manager, received } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await assert.rejects(() => manager.send(session.id, "hi"));
    assert.equal(manager.get(session.id).status, "error");
    assert.equal(manager.get(session.id).lastError?.code, "AB-1006");

    const errorEvent = received.find((e) => e.type === "error");
    assert.equal(errorEvent?.type === "error" ? errorEvent.fatal : undefined, true);

    await assert.rejects(
      () => manager.send(session.id, "again"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3002",
    );
  });

  it("interrupt aborts the turn and returns the session to ready", async () => {
    const provider = fakeProvider({
      onSend: (_message, _emit, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    const turn = manager.send(session.id, "long");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.interrupt(session.id);
    await turn;

    assert.equal(manager.get(session.id).status, "ready");
  });

  it("interrupt with no running turn is AB-3006", async () => {
    const { manager } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });

    await assert.rejects(
      () => manager.interrupt(session.id),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3006",
    );
  });

  it("stop tears the provider down and blocks further sends", async () => {
    const provider = fakeProvider();
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await manager.stop(session.id);
    assert.equal(manager.get(session.id).status, "stopped");
    assert.deepEqual(provider.stopped, [session.id]);

    await assert.rejects(
      () => manager.send(session.id, "hi"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3002",
    );
  });

  it("unknown session ids are AB-3004", () => {
    const { manager } = harness(fakeProvider());
    assert.throws(
      () => manager.get("nope"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3004",
    );
  });

  it("lists sessions with provider and status filters", async () => {
    const { manager } = harness(fakeProvider());
    const a = await manager.create({ provider: "fake" });
    await manager.create({ provider: "fake" });
    await manager.stop(a.id);

    assert.equal(manager.list().length, 2);
    assert.equal(manager.list({ status: "ready" }).length, 1);
    assert.equal(manager.list({ status: ["ready", "stopped"] }).length, 2);
    assert.equal(manager.list({ provider: "other" }).length, 0);
  });
});

describe("SessionManager lifecycle extensions (spec 13.3)", () => {
  it("resume restarts a stopped session and reuses the provider session id", async () => {
    const starts: Array<{ resumeToken?: string }> = [];
    const provider: SessionProvider = {
      ...fakeProvider(),
      start: async (options) => {
        starts.push({ ...(options.resumeToken ? { resumeToken: options.resumeToken } : {}) });
        return { sessionId: options.sessionId, providerId: "fake", nativeSessionId: "native-1" };
      },
    };
    const { manager } = harness(provider);

    const session = await manager.create({ provider: "fake" });
    await manager.stop(session.id);
    assert.equal(manager.get(session.id).status, "stopped");

    const resumed = await manager.resume(session.id);
    assert.equal(resumed.status, "ready");
    assert.deepEqual(starts, [{}, { resumeToken: "native-1" }]);

    await manager.send(session.id, "after resume");
    assert.equal(manager.get(session.id).status, "ready");
  });

  it("resume clears the previous error", async () => {
    let fail = true;
    const provider: SessionProvider = {
      ...fakeProvider(),
      send: async (_handle, _message, { emit }) => {
        if (fail) throw new AgentBridgeError("AB-1006", { message: "boom" });
        emit({ type: "message", role: "assistant", content: "ok", delta: false, done: true });
      },
    };
    const { manager } = harness(provider);

    const session = await manager.create({ provider: "fake" });
    await assert.rejects(() => manager.send(session.id, "hi"));
    assert.equal(manager.get(session.id).lastError?.code, "AB-1006");

    fail = false;
    await manager.resume(session.id);
    assert.equal(manager.get(session.id).lastError, undefined);
    await manager.send(session.id, "hi");
  });

  it("resume on a live session is a no-op", async () => {
    const { manager } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });

    assert.equal((await manager.resume(session.id)).status, "ready");
  });

  it("updateMcp rebinds a live session", async () => {
    const events = new EventBus();
    const manager = new SessionManager({
      providers: { get: () => fakeProvider() },
      events,
      resolveMcp: (ids) => ids.map((id) => ({ id })),
    });

    const session = await manager.create({ provider: "fake", mcp: ["a"] });
    const updated = await manager.updateMcp(session.id, ["a", "b"]);

    assert.deepEqual(updated.mcpServers, ["a", "b"]);
    assert.deepEqual(manager.get(session.id).mcpServers, ["a", "b"]);
  });

  it("updateMcp rejects a server the manager cannot resolve, leaving the session untouched", async () => {
    const events = new EventBus();
    const manager = new SessionManager({
      providers: { get: () => fakeProvider() },
      events,
      resolveMcp: (ids) => {
        if (ids.includes("broken")) throw new AgentBridgeError("AB-2004", { message: "not connected" });
        return ids.map((id) => ({ id }));
      },
    });

    const session = await manager.create({ provider: "fake", mcp: ["a"] });
    await assert.rejects(
      () => manager.updateMcp(session.id, ["broken"]),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2004",
    );
    assert.deepEqual(manager.get(session.id).mcpServers, ["a"]);
  });

  it("updateMcp refuses a stopped session", async () => {
    const { manager } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });
    await manager.stop(session.id);

    await assert.rejects(
      () => manager.updateMcp(session.id, []),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3002",
    );
  });

  it("setPermissionMode changes the mode and rejects an unknown one", async () => {
    const { manager } = harness(fakeProvider());
    const session = await manager.create({ provider: "fake" });

    assert.equal((await manager.setPermissionMode(session.id, "allow")).permissionMode, "allow");
    await assert.rejects(
      () => manager.setPermissionMode(session.id, "maybe" as never),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3001",
    );
  });
});

describe("SessionManager stop is idempotent", () => {
  it("stopping twice calls the provider once", async () => {
    const provider = fakeProvider();
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await manager.stop(session.id);
    await manager.stop(session.id);

    assert.deepEqual(provider.stopped, [session.id]);
    assert.equal(manager.get(session.id).status, "stopped");
  });

  it("stopAll leaves every session stopped exactly once", async () => {
    const provider = fakeProvider();
    const { manager } = harness(provider);
    const a = await manager.create({ provider: "fake" });
    const b = await manager.create({ provider: "fake" });

    await manager.stop(a.id);
    await manager.stopAll();

    assert.deepEqual(provider.stopped.sort(), [a.id, b.id].sort());
  });
});

describe("SessionManager.setModel (spec 13.3)", () => {
  /** Records the model visible to the adapter at each send, read from the retained options. */
  function modelProbe() {
    const seen: Array<string | undefined> = [];
    let retained: { model?: string } | undefined;
    const provider: SessionProvider = {
      id: "fake",
      start: async (options) => {
        retained = options as { model?: string };
        return { sessionId: (options as { sessionId: string }).sessionId, providerId: "fake" };
      },
      send: async (_h, _m, { emit }) => {
        seen.push(retained?.model);
        emit({ type: "message", role: "assistant", content: "ok", delta: false, done: true });
      },
      interrupt: async () => {},
      stop: async () => {},
    };
    return { provider, seen };
  }

  it("changes the model the adapter sees on the next turn", async () => {
    const { provider, seen } = modelProbe();
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake", model: "sonnet" });

    await manager.send(session.id, "one");
    await manager.setModel(session.id, "haiku");
    await manager.send(session.id, "two");

    assert.deepEqual(seen, ["sonnet", "haiku"]);
    assert.equal(manager.get(session.id).model, "haiku");
  });

  it("applies to a session created without a model", async () => {
    const { provider, seen } = modelProbe();
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await manager.send(session.id, "one");
    await manager.setModel(session.id, "opus");
    await manager.send(session.id, "two");

    assert.deepEqual(seen, [undefined, "opus"]);
  });

  it("rejects an empty model name", async () => {
    const { provider } = modelProbe();
    const { manager } = harness(provider);
    const session = await manager.create({ provider: "fake" });

    await assert.rejects(
      () => manager.setModel(session.id, ""),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3001",
    );
  });

  it("survives a restart: the persisted session carries the switched model", async () => {
    const { provider } = modelProbe();
    const events = new EventBus();
    const stored = new Map<string, { id: string; model?: string }>();
    const manager = new SessionManager({
      providers: { get: () => provider },
      events,
      storage: {
        get: async (id: string) => stored.get(id) as never,
        list: async () => [...stored.values()] as never,
        put: async (v: { id: string; model?: string }) => void stored.set(v.id, v),
        delete: async (id: string) => void stored.delete(id),
      } as never,
    });

    const session = await manager.create({ provider: "fake", model: "sonnet" });
    await manager.setModel(session.id, "haiku");
    assert.equal(stored.get(session.id)?.model, "haiku");
  });
});
