import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fixture } from "../../../testing/repoRoot.js";
import { AgentBridgeError, MapSecretResolver } from "../../../core/index.js";

import { McpManager } from "../index.js";
import type { McpServerConfig } from "../../client/index.js";

const FIXTURE = fixture("filesystem-mcp.mjs");

function config(env: Record<string, string>): McpServerConfig {
  return {
    id: "secretful",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE, "/tmp"],
    env,
  };
}

describe("secret resolution in MCP registration (spec 26.3)", () => {
  it("keeps the reference in storage while the connection gets the real value", async () => {
    const stored: McpServerConfig[] = [];
    const manager = new McpManager({
      secrets: new MapSecretResolver({ "secret://svc/token": "real-token" }),
      storage: {
        list: async () => [],
        put: async (value) => {
          stored.push(value);
        },
        delete: async () => {},
      },
    });

    await manager.add(config({ TOKEN: "secret://svc/token" }));

    // Persisted with the reference, so a state file never carries the secret.
    const persisted = stored[0];
    assert.equal(persisted?.transport === "stdio" ? persisted.env?.["TOKEN"] : "", "secret://svc/token");

    // The provider-facing config carries the resolved value.
    const [resolved] = manager.resolveForSession(["secretful"]);
    assert.equal(
      (resolved as { env?: Record<string, string> }).env?.["TOKEN"],
      "real-token",
    );

    await manager.closeAll();
  });

  it("masks the value in the API view, whichever form it holds", async () => {
    const manager = new McpManager({
      secrets: new MapSecretResolver({ "secret://svc/token": "real-token" }),
    });
    await manager.add(config({ TOKEN: "secret://svc/token" }));

    const state = manager.get("secretful");
    assert.equal(
      state.config.transport === "stdio" ? state.config.env?.["TOKEN"] : "",
      "***",
      "the API view never shows a value",
    );

    await manager.closeAll();
  });

  it("refuses registration when a reference cannot be resolved", async () => {
    const manager = new McpManager({ secrets: new MapSecretResolver({}) });

    await assert.rejects(
      () => manager.add(config({ TOKEN: "secret://svc/missing" })),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-6004",
    );
    assert.equal(manager.has("secretful"), false, "a half-registered server must not linger");
  });

  it("refuses a reference when no resolver is configured", async () => {
    const manager = new McpManager();

    await assert.rejects(
      () => manager.add(config({ TOKEN: "secret://svc/token" })),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-6004",
    );
  });

  it("leaves a server without references untouched", async () => {
    const manager = new McpManager();
    const state = await manager.add(config({ PLAIN: "value" }));

    assert.equal(state.state, "connected");
    await manager.closeAll();
  });
});
