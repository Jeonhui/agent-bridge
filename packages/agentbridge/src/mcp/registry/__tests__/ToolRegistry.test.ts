import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "../../../core/index.js";

import { ToolRegistry, inferPermissions, toolId } from "../index.js";

describe("toolId (spec 24.2)", () => {
  it("is globally unique per source and server", () => {
    assert.equal(toolId({ type: "mcp", server: "filesystem" }, "read"), "mcp:filesystem:read");
    assert.equal(toolId({ type: "builtin" }, "session_info"), "builtin::session_info");
  });
});

describe("inferPermissions (spec 25.2)", () => {
  it("prefers MCP annotations over anything else", () => {
    assert.deepEqual(inferPermissions({ name: "delete_everything", annotations: { readOnlyHint: true } }), ["READ"]);
    assert.deepEqual(inferPermissions({ name: "list_things", annotations: { destructiveHint: true } }), ["WRITE"]);
  });

  it("prefers an explicit override over the heuristics", () => {
    assert.deepEqual(inferPermissions({ name: "read_file" }, { read_file: ["SYSTEM"] }), ["SYSTEM"]);
  });

  it("falls back to name heuristics", () => {
    assert.deepEqual(inferPermissions({ name: "read_file" }), ["READ"]);
    assert.deepEqual(inferPermissions({ name: "write_file" }), ["WRITE"]);
    assert.deepEqual(inferPermissions({ name: "run_command" }), ["EXECUTE"]);
    assert.deepEqual(inferPermissions({ name: "http_fetch" }), ["NETWORK"]);
  });

  it("defaults to WRITE when nothing matches, rather than assuming harmless", () => {
    assert.deepEqual(inferPermissions({ name: "frobnicate" }), ["WRITE"]);
  });
});

describe("ToolRegistry", () => {
  const tools = [
    { name: "read_file", description: "read", annotations: { readOnlyHint: true } },
    { name: "write_file", description: "write", annotations: { destructiveHint: true } },
  ];

  it("indexes discovered tools and reports them as added", () => {
    const registry = new ToolRegistry();
    const diff = registry.replaceServerTools("fs", tools);

    assert.deepEqual(diff.added, ["mcp:fs:read_file", "mcp:fs:write_file"]);
    assert.deepEqual(diff.removed, []);
    assert.equal(registry.list().length, 2);
  });

  it("diffs added, removed, and changed tools across a rediscovery", () => {
    const registry = new ToolRegistry();
    registry.replaceServerTools("fs", tools);

    const diff = registry.replaceServerTools("fs", [
      { name: "read_file", description: "read a file now" },
      { name: "append_file", description: "append" },
    ]);

    assert.deepEqual(diff.added, ["mcp:fs:append_file"]);
    assert.deepEqual(diff.removed, ["mcp:fs:write_file"]);
    assert.deepEqual(diff.changed, ["mcp:fs:read_file"]);
  });

  it("reports no change when a rediscovery returns identical tools", () => {
    const registry = new ToolRegistry();
    registry.replaceServerTools("fs", tools);
    const diff = registry.replaceServerTools("fs", tools);

    assert.deepEqual([diff.added, diff.removed, diff.changed], [[], [], []]);
  });

  it("applies a tool prefix to avoid collisions between servers", () => {
    const registry = new ToolRegistry();
    registry.replaceServerTools("a", [{ name: "read" }], "a_");
    registry.replaceServerTools("b", [{ name: "read" }], "b_");

    assert.deepEqual(
      registry.list().map((t) => t.id),
      ["mcp:a:a_read", "mcp:b:b_read"],
    );
  });

  it("rejects a server returning the same tool name twice with AB-2205", () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.replaceServerTools("fs", [{ name: "read" }, { name: "read" }]),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2205",
    );
  });

  it("scopes a session to its bound servers plus built-ins", () => {
    const registry = new ToolRegistry();
    registry.replaceServerTools("fs", [{ name: "read" }]);
    registry.replaceServerTools("github", [{ name: "create_issue" }]);
    registry.registerBuiltin({ name: "session_info", annotations: { readOnlyHint: true } });

    assert.deepEqual(
      registry.listForSession(["fs"]).map((t) => t.id),
      ["mcp:fs:read", "builtin::session_info"],
    );
  });

  it("removing a server drops only its tools", () => {
    const registry = new ToolRegistry();
    registry.replaceServerTools("fs", tools);
    registry.replaceServerTools("github", [{ name: "create_issue" }]);

    assert.deepEqual(registry.removeServer("fs"), ["mcp:fs:read_file", "mcp:fs:write_file"]);
    assert.equal(registry.list().length, 1);
  });

  it("an unknown tool id is AB-2201", () => {
    assert.throws(
      () => new ToolRegistry().get("mcp:fs:nope"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2201",
    );
  });
});
