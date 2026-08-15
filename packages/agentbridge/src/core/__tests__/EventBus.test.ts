import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventBus } from "../events/EventBus.js";
import { SequenceCounter } from "../events/sequence.js";
import type { AgentEvent } from "../events/types.js";

function messageEvent(sessionId: string, seq: number, content = "hi"): AgentEvent {
  return {
    id: `evt_${sessionId}_${seq}`,
    seq,
    sessionId,
    timestamp: new Date(0).toISOString(),
    type: "message",
    role: "assistant",
    content,
    delta: false,
    done: true,
  };
}

describe("SequenceCounter (spec 15.3)", () => {
  it("starts at 1 and increases monotonically", () => {
    const seq = new SequenceCounter();
    assert.equal(seq.next(), 1);
    assert.equal(seq.next(), 2);
    assert.equal(seq.last, 2);
  });

  it("continues across resume", () => {
    assert.equal(new SequenceCounter(42).next(), 43);
  });
});

describe("EventBus (spec 15.3)", () => {
  it("delivers to subscribers by event type", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];
    bus.on("message", (e) => received.push(e));

    bus.emit(messageEvent("s1", 1));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.sessionId, "s1");
  });

  it("session-scoped subscribers never see other sessions", () => {
    const bus = new EventBus();
    const mine: AgentEvent[] = [];
    bus.onSession("s1", "message", (e) => mine.push(e));

    bus.emit(messageEvent("s1", 1));
    bus.emit(messageEvent("s2", 1));

    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.sessionId, "s1");
  });

  it("a throwing handler does not affect other subscribers", () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onHandlerError: (error) => errors.push(error) });
    const survived: AgentEvent[] = [];

    bus.on("message", () => {
      throw new Error("subscriber exploded");
    });
    bus.on("message", (e) => survived.push(e));

    bus.emit(messageEvent("s1", 1));

    assert.equal(survived.length, 1);
    assert.equal(errors.length, 1);
  });

  it("unsubscribe takes effect immediately and is safe to call twice", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];
    const off = bus.on("message", (e) => received.push(e));

    bus.emit(messageEvent("s1", 1));
    off();
    off();
    bus.emit(messageEvent("s1", 2));

    assert.equal(received.length, 1);
  });

  it("preserves ordering within a session", () => {
    const bus = new EventBus();
    const seqs: number[] = [];
    bus.onSession("s1", "message", (e) => seqs.push(e.seq));

    for (const seq of [1, 2, 3, 4]) bus.emit(messageEvent("s1", seq));
    assert.deepEqual(seqs, [1, 2, 3, 4]);
  });

  it("replays events after sinceSeq", () => {
    const bus = new EventBus();
    for (const seq of [1, 2, 3]) bus.emit(messageEvent("s1", seq));

    assert.deepEqual(
      bus.replay("s1", 1).map((e) => e.seq),
      [2, 3],
    );
  });

  it("drops the oldest events past retention and reports the gap (AB-5003)", () => {
    const bus = new EventBus({ retentionPerSession: 2 });
    for (const seq of [1, 2, 3]) bus.emit(messageEvent("s1", seq));

    assert.deepEqual(
      bus.replay("s1", 0).map((e) => e.seq),
      [2, 3],
    );
    assert.equal(bus.hasGap("s1", 0), true, "seq 1 was dropped, so there is a gap");
    assert.equal(bus.hasGap("s1", 1), false, "seq 2 follows contiguously, so no gap");
  });

  it("retains nothing after the session is cleared", () => {
    const bus = new EventBus();
    bus.emit(messageEvent("s1", 1));
    bus.clearSession("s1");
    assert.deepEqual(bus.replay("s1", 0), []);
  });
});

describe("EventBus regressions", () => {
  it("keeps subscriptions independent when the same function is reused", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const handler = (e: AgentEvent) => seen.push(e.sessionId);

    bus.onSession("s1", "message", handler);
    bus.onSession("s2", "message", handler);

    bus.emit(messageEvent("s1", 1));
    bus.emit(messageEvent("s2", 1));

    assert.deepEqual(seen, ["s1", "s2"]);
  });

  it("a session-scoped subscription does not shadow a global one on the same function", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const handler = (e: AgentEvent) => seen.push(`${e.type}:${e.sessionId}`);

    bus.on("message", handler);
    bus.onSession("s1", "tool_call", handler);

    bus.emit(messageEvent("s2", 1));
    assert.deepEqual(seen, ["message:s2"]);
  });

  it("unsubscribing one subscription leaves the other alive", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const handler = (e: AgentEvent) => seen.push(e.seq);

    const offGlobal = bus.on("message", handler);
    bus.onSession("s1", "message", handler);
    offGlobal();

    bus.emit(messageEvent("s1", 1));
    assert.deepEqual(seen, [1]);
  });

  it("a nested emit is drained in order instead of interleaving", () => {
    const bus = new EventBus();
    const order: string[] = [];
    let nested = false;

    bus.on("message", (e) => {
      order.push(`in:${e.seq}`);
      if (!nested) {
        nested = true;
        bus.emit(messageEvent("s1", 99));
      }
      order.push(`out:${e.seq}`);
    });

    bus.emit(messageEvent("s1", 1));
    assert.deepEqual(order, ["in:1", "out:1", "in:99", "out:99"]);
  });
});
