import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptsMessage,
  allowedActions,
  canTransition,
  nextStatus,
  type SessionAction,
} from "../session/stateMachine.js";
import type { SessionStatus } from "../session/types.js";

const ALL_STATUSES: SessionStatus[] = ["starting", "ready", "running", "waiting", "stopped", "error"];
const ALL_ACTIONS: SessionAction[] = [
  "started",
  "send",
  "turn_end",
  "await_input",
  "resolve_input",
  "interrupt",
  "resume",
  "stop",
  "fail",
];

describe("session state machine (spec 13.2)", () => {
  it("follows the transitions written in the spec", () => {
    assert.equal(nextStatus("starting", "started"), "ready");
    assert.equal(nextStatus("ready", "send"), "running");
    assert.equal(nextStatus("running", "turn_end"), "ready");
    assert.equal(nextStatus("running", "await_input"), "waiting");
    assert.equal(nextStatus("waiting", "resolve_input"), "running");
    assert.equal(nextStatus("stopped", "resume"), "starting");
  });

  it("rejects send on a terminated session (AB-3002)", () => {
    assert.equal(canTransition("stopped", "send"), false);
    assert.equal(canTransition("error", "send"), false);
    assert.equal(acceptsMessage("stopped"), false);
    assert.equal(acceptsMessage("error"), false);
  });

  it("interrupt returns to ready instead of killing the session", () => {
    assert.equal(nextStatus("running", "interrupt"), "ready");
    assert.equal(nextStatus("waiting", "interrupt"), "ready");
    assert.equal(canTransition("ready", "interrupt"), false, "not running means AB-3006");
  });

  it("no transition escapes the defined status set", () => {
    for (const status of ALL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        const next = nextStatus(status, action);
        if (next !== undefined) assert.ok(ALL_STATUSES.includes(next));
      }
    }
  });

  it("terminal states are only left through resume or stop", () => {
    assert.deepEqual(allowedActions("stopped"), ["resume"]);
    assert.deepEqual(allowedActions("error").sort(), ["resume", "stop"]);
  });
});
