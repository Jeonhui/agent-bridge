import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "@agentbridge/core";

import { maskMcpConfig, validateMcpConfig, type McpServerConfig } from "../index.js";

const stdio: McpServerConfig = { id: "fs", transport: "stdio", command: "node", args: ["fs.js"] };

describe("validateMcpConfig (spec 21.1)", () => {
  it("accepts a well-formed stdio config", () => {
    assert.doesNotThrow(() => validateMcpConfig(stdio));
  });

  it("rejects an id that breaks the naming rule", () => {
    for (const id of ["Filesystem", "-fs", "fs server", ""]) {
      assert.throws(
        () => validateMcpConfig({ ...stdio, id }),
        (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2001",
        `expected ${JSON.stringify(id)} to be rejected`,
      );
    }
  });

  it("requires a command for stdio", () => {
    assert.throws(
      () => validateMcpConfig({ id: "fs", transport: "stdio", command: "" }),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2001",
    );
  });

  it("requires a valid url for http transports", () => {
    assert.throws(
      () => validateMcpConfig({ id: "remote", transport: "sse", url: "not a url" }),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-2001",
    );
    assert.doesNotThrow(() =>
      validateMcpConfig({ id: "remote", transport: "streamable-http", url: "https://example.com/mcp" }),
    );
  });
});

describe("maskMcpConfig (spec 26.3)", () => {
  it("masks stdio env values but keeps the keys", () => {
    const masked = maskMcpConfig({ ...stdio, env: { TOKEN: "secret-value" } });
    assert.deepEqual(masked.transport === "stdio" ? masked.env : undefined, { TOKEN: "***" });
  });

  it("masks http headers", () => {
    const masked = maskMcpConfig({
      id: "remote",
      transport: "sse",
      url: "https://example.com",
      headers: { Authorization: "Bearer abc" },
    });
    assert.deepEqual(masked.transport !== "stdio" ? masked.headers : undefined, { Authorization: "***" });
  });

  it("leaves a config without secrets untouched", () => {
    assert.deepEqual(maskMcpConfig(stdio), stdio);
  });
});
