import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpConfigOverrides } from "../CodexProvider.js";
import { parseCodexLine, readErrorMessage } from "../parse.js";

/** Envelopes captured from codex 0.132.0 `exec --json`. */
const THREAD_STARTED = { type: "thread.started", thread_id: "01a0044e-bf93-7c93-8fbb-ee86acb5d548" };
const TURN_STARTED = { type: "turn.started" };
const TURN_COMPLETED = { type: "turn.completed", usage: { input_tokens: 10 } };
const TURN_FAILED = {
  type: "turn.failed",
  error: {
    message:
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}',
  },
};
const ERROR_LINE = {
  type: "error",
  message:
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}',
};

describe("readErrorMessage", () => {
  it("unwraps the message codex nests as a JSON string", () => {
    assert.match(readErrorMessage(TURN_FAILED.error), /model is not supported/);
  });

  it("falls back to the raw string when it is not JSON", () => {
    assert.equal(readErrorMessage("plain failure"), "plain failure");
  });

  it("handles a missing error without throwing", () => {
    assert.equal(readErrorMessage(undefined), "codex reported an error");
  });
});

describe("parseCodexLine (codex 0.132.0 exec --json)", () => {
  it("takes the thread id from thread.started for resume", () => {
    const parsed = parseCodexLine(THREAD_STARTED);
    assert.equal(parsed.nativeSessionId, "01a0044e-bf93-7c93-8fbb-ee86acb5d548");
    assert.deepEqual(parsed.events, []);
    assert.equal(parsed.done, false);
  });

  it("treats turn.started as a boundary with no payload", () => {
    assert.deepEqual(parseCodexLine(TURN_STARTED), { events: [], done: false });
  });

  it("marks the turn done on turn.completed", () => {
    const parsed = parseCodexLine(TURN_COMPLETED);
    assert.equal(parsed.done, true);
    assert.equal(parsed.isError, false);
  });

  it("reports turn.failed as a done turn carrying an error", () => {
    const parsed = parseCodexLine(TURN_FAILED);
    assert.equal(parsed.done, true);
    assert.equal(parsed.isError, true);
    const event = parsed.events[0];
    assert.equal(event?.type, "error");
    assert.match(event?.type === "error" ? event.error.message : "", /not supported/);
  });

  it("surfaces a standalone error without ending the turn", () => {
    const parsed = parseCodexLine(ERROR_LINE);
    assert.equal(parsed.done, false);
    assert.equal(parsed.events[0]?.type, "error");
  });

  it("turns a completed message item into a message event", () => {
    const parsed = parseCodexLine({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "ok" },
    });
    assert.deepEqual(parsed.events, [
      { type: "message", role: "assistant", content: "ok", delta: false, done: true },
    ]);
  });

  it("does not surface reasoning as an assistant message", () => {
    const parsed = parseCodexLine({
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "thinking out loud" },
    });
    assert.deepEqual(parsed.events, []);
  });

  it("maps an mcp_tool_call item onto a tool_call event", () => {
    const parsed = parseCodexLine({
      type: "item.completed",
      item: { id: "i3", type: "mcp_tool_call", server: "filesystem", tool: "write_file", arguments: { path: "a" } },
    });
    assert.deepEqual(parsed.events, [
      {
        type: "tool_call",
        callId: "i3",
        tool: "filesystem.write_file",
        toolId: "mcp:filesystem:write_file",
        arguments: { path: "a" },
        source: { type: "mcp", server: "filesystem" },
      },
    ]);
  });

  it("maps a command execution onto a builtin tool_call", () => {
    const parsed = parseCodexLine({
      type: "item.completed",
      item: { id: "i4", type: "command_execution", command: "ls -la" },
    });
    assert.equal(parsed.events[0]?.type, "tool_call");
    assert.deepEqual(
      parsed.events[0]?.type === "tool_call" ? parsed.events[0].arguments : undefined,
      { command: "ls -la" },
    );
  });

  it("ignores item lifecycle chatter and unknown envelopes", () => {
    for (const line of [
      { type: "item.started", item: { id: "i5" } },
      { type: "item.updated", item: { id: "i5" } },
      { type: "some.future.event" },
    ]) {
      assert.deepEqual(parseCodexLine(line), { events: [], done: false });
    }
  });

  it("ignores an item kind it has never seen rather than dropping the turn", () => {
    const parsed = parseCodexLine({
      type: "item.completed",
      item: { id: "i6", type: "web_search", query: "anything" },
    });
    assert.deepEqual(parsed.events, []);
  });
});

describe("mcpConfigOverrides (spec 12.3.3)", () => {
  it("emits TOML overrides for a stdio server", () => {
    assert.deepEqual(
      mcpConfigOverrides([
        { id: "filesystem", transport: "stdio", command: "node", args: ["fs.js"], env: { TOKEN: "x" } },
      ]),
      [
        'mcp_servers.filesystem.command="node"',
        'mcp_servers.filesystem.args=["fs.js"]',
        'mcp_servers.filesystem.env={"TOKEN":"x"}',
      ],
    );
  });

  it("emits a url for an http server", () => {
    assert.deepEqual(
      mcpConfigOverrides([{ id: "remote", transport: "streamable-http", url: "https://example.com/mcp" }]),
      ['mcp_servers.remote.url="https://example.com/mcp"'],
    );
  });

  it("emits nothing for an empty list", () => {
    assert.deepEqual(mcpConfigOverrides([]), []);
  });
});
