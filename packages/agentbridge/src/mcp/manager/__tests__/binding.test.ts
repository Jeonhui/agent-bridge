import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpBinding } from "../../../core/index.js";

import { McpManager } from "../index.js";

describe("McpManager satisfies the core's McpBinding contract", () => {
  it("type-checks as an McpBinding", () => {
    // A compile-time assertion: if McpManager stops satisfying the binding, the build fails
    // instead of a host application discovering it at runtime.
    const binding: McpBinding = new McpManager();
    assert.equal(typeof binding.listTools, "function");
    assert.equal(typeof binding.getTool, "function");
    assert.equal(typeof binding.callTool, "function");
    assert.equal(typeof binding.resolveForSession, "function");
  });

  it("exposes an empty tool list before any server connects", () => {
    assert.deepEqual(new McpManager().listTools(), []);
  });
});
