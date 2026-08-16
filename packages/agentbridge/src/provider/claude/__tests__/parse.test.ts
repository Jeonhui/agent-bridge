import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseClaudeLine } from "../parse.js";

/**
 * Line shapes captured from claude 2.1.220 running
 * `claude -p "..." --output-format stream-json --verbose`.
 */
const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/workspace/project",
  session_id: "274d1f1a-a0f0-4442-9edd-c980219e0b96",
  tools: ["Bash", "Read"],
  mcp_servers: [],
  model: "claude-sonnet-5",
};

const HOOK_NOISE = {
  type: "system",
  subtype: "hook_started",
  hook_name: "SessionStart:startup",
  session_id: "274d1f1a-a0f0-4442-9edd-c980219e0b96",
};

const ASSISTANT_TEXT = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5",
    id: "msg_011Ce46AjeHxQLrgKrhdj6dk",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: null,
  },
  session_id: "274d1f1a-a0f0-4442-9edd-c980219e0b96",
};

const ASSISTANT_TOOL_USE = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Reading the file." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/tmp/a.txt" } },
    ],
  },
  session_id: "274d1f1a",
};

const USER_TOOL_RESULT = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "file body" }],
  },
  session_id: "274d1f1a",
};

const USER_TOOL_ERROR = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "ENOENT", is_error: true }],
  },
  session_id: "274d1f1a",
};

const RATE_LIMIT = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed" },
  session_id: "274d1f1a",
};

const RESULT_SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "274d1f1a-a0f0-4442-9edd-c980219e0b96",
  duration_ms: 2001,
  num_turns: 1,
  stop_reason: "end_turn",
  total_cost_usd: 0.1129788,
};

const RESULT_ERROR = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "the model refused",
  session_id: "274d1f1a",
};

describe("parseClaudeLine (claude 2.1.220 stream-json)", () => {
  it("takes the native session id from init and emits nothing else", () => {
    const parsed = parseClaudeLine(INIT);
    assert.equal(parsed.nativeSessionId, "274d1f1a-a0f0-4442-9edd-c980219e0b96");
    assert.deepEqual(parsed.events, []);
    assert.equal(parsed.done, false);
  });

  it("ignores hook lifecycle noise", () => {
    assert.deepEqual(parseClaudeLine(HOOK_NOISE).events, []);
  });

  it("ignores rate limit telemetry", () => {
    assert.deepEqual(parseClaudeLine(RATE_LIMIT).events, []);
  });

  it("turns assistant text into a message event", () => {
    const [event, ...rest] = parseClaudeLine(ASSISTANT_TEXT).events;
    assert.equal(rest.length, 0);
    assert.deepEqual(event, {
      type: "message",
      role: "assistant",
      content: "ok",
      delta: false,
      done: true,
    });
  });

  it("turns a tool_use block into a tool_call event alongside the text", () => {
    const events = parseClaudeLine(ASSISTANT_TOOL_USE).events;
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "message");
    assert.deepEqual(events[1], {
      type: "tool_call",
      callId: "toolu_01",
      tool: "Read",
      toolId: "builtin::Read",
      arguments: { file_path: "/tmp/a.txt" },
      source: { type: "builtin" },
    });
  });

  it("turns a tool_result block into a tool_result event", () => {
    const [event] = parseClaudeLine(USER_TOOL_RESULT).events;
    assert.equal(event?.type, "tool_result");
    assert.deepEqual(event, {
      type: "tool_result",
      callId: "toolu_01",
      tool: "toolu_01",
      ok: true,
      content: "file body",
      durationMs: 0,
    });
  });

  it("maps a failed tool_result onto tool_error with AB-2202", () => {
    const [event] = parseClaudeLine(USER_TOOL_ERROR).events;
    assert.equal(event?.type, "tool_error");
    assert.equal(event.type === "tool_error" ? event.error.code : undefined, "AB-2202");
  });

  it("marks the turn done on a successful result line", () => {
    const parsed = parseClaudeLine(RESULT_SUCCESS);
    assert.equal(parsed.done, true);
    assert.equal(parsed.isError, false);
    assert.deepEqual(parsed.events, []);
  });

  it("emits a non-fatal error event on a failed result line", () => {
    const parsed = parseClaudeLine(RESULT_ERROR);
    assert.equal(parsed.done, true);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.events[0]?.type, "error");
  });

  it("turns result usage into a usage event naming the serving model", () => {
    const parsed = parseClaudeLine({
      ...RESULT_SUCCESS,
      usage: { input_tokens: 7, output_tokens: 12, cache_read_input_tokens: 100 },
      modelUsage: { "claude-sonnet-4-5-20250929": { inputTokens: 7, outputTokens: 12 } },
    });
    assert.equal(parsed.done, true);
    assert.deepEqual(parsed.events, [
      {
        type: "usage",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 7,
        outputTokens: 12,
        totalTokens: 19,
      },
    ]);
  });

  it("stays silent when the result line carries no usable usage", () => {
    const parsed = parseClaudeLine({ ...RESULT_SUCCESS, usage: { cache_creation: {} } });
    assert.deepEqual(parsed.events, []);
  });

  it("ignores line types it has never seen instead of failing", () => {
    const parsed = parseClaudeLine({ type: "some_future_telemetry", session_id: "s" });
    assert.deepEqual(parsed.events, []);
    assert.equal(parsed.done, false);
  });
});
