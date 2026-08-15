import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import { ERROR_CODES, isErrorCode, type ErrorCode } from "../errors/codes.js";

describe("error codes (spec 18.2)", () => {
  it("defines the same number of codes as the spec table", () => {
    assert.equal(Object.keys(ERROR_CODES).length, 40);
  });

  it("every code matches AB-#### and carries a message", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.match(code, /^AB-\d{4}$/, `${code} has a malformed shape`);
      assert.ok(spec.message.length > 0, `${code} has no message`);
    }
  });

  it("domain ranges match the spec", () => {
    const prefixes = new Set(Object.keys(ERROR_CODES).map((c) => c.slice(3, 4)));
    assert.deepEqual([...prefixes].sort(), ["1", "2", "3", "4", "5", "6"]);
  });

  it("isErrorCode rejects undefined codes", () => {
    assert.equal(isErrorCode("AB-2101"), true);
    assert.equal(isErrorCode("AB-9999"), false);
  });
});

describe("AgentBridgeError (spec 18.3)", () => {
  it("takes retryable from the code table", () => {
    assert.equal(new AgentBridgeError("AB-2101").retryable, true);
    assert.equal(new AgentBridgeError("AB-4001").retryable, false);
  });

  it("toJSON does not leak cause", () => {
    const error = new AgentBridgeError("AB-1003", {
      details: { providerId: "claude" },
      cause: new Error("spawn ENOENT"),
    });

    const json = error.toJSON();
    assert.deepEqual(json, {
      code: "AB-1003",
      message: "Provider process failed to start",
      details: { providerId: "claude" },
      retryable: true,
    });
    assert.equal("cause" in json, false);
    assert.ok(error.cause instanceof Error, "cause itself is preserved");
  });

  it("allows overriding the default message", () => {
    const code: ErrorCode = "AB-3004";
    const error = new AgentBridgeError(code, { message: "session 01J8 not found" });
    assert.equal(error.message, "session 01J8 not found");
    assert.equal(error.code, code);
  });
});
