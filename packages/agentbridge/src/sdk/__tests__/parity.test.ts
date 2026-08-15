import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { AgentBridge, type AgentEventPayload } from "../../core/index.js";
import { McpManager } from "../../mcp/manager/index.js";
import { RuntimeServer } from "../../runtime/index.js";
import WebSocket from "ws";

import { createClient } from "../index.js";
import type { AgentBridgeClient } from "../types.js";

function echoProvider() {
  return {
    id: "echo",
    name: "Echo",
    detect: async () => ({ available: true, version: "1.0.0" }),
    start: async (o: { sessionId: string }) => ({ sessionId: o.sessionId, providerId: "echo" }),
    send: async (
      _handle: unknown,
      message: string,
      { emit }: { emit: (payload: AgentEventPayload) => void },
    ) => {
      emit({ type: "message", role: "assistant", content: `echo:${message}`, delta: false, done: true });
    },
    interrupt: async () => {},
    stop: async () => {},
  };
}

/**
 * The same assertions run against both backends.
 *
 * Spec 10.8 makes identical signatures an invariant; running one suite twice is what actually
 * holds the two implementations together.
 */
function parity(name: string, setup: () => Promise<{ client: AgentBridgeClient; teardown: () => Promise<void> }>) {
  describe(`${name} backend (spec 10.8)`, () => {
    let client: AgentBridgeClient;
    let teardown: () => Promise<void>;

    before(async () => {
      ({ client, teardown } = await setup());
      await client.connect();
    });

    after(async () => {
      await client.close();
      await teardown();
    });

    it("lists providers", async () => {
      const providers = await client.providers.list();
      assert.equal(providers[0]?.id, "echo");
      assert.equal(providers[0]?.available, true);
    });

    it("creates a session that reports ready", async () => {
      const session = await client.sessions.create({ provider: "echo" });
      assert.equal((await session.info()).status, "ready");
    });

    it("sends a message and gets a turn id", async () => {
      const session = await client.sessions.create({ provider: "echo" });
      const result = await session.send("hi");
      assert.ok(result.turnId);
    });

    it("lists sessions", async () => {
      const before = (await client.sessions.list()).length;
      await client.sessions.create({ provider: "echo" });
      assert.equal((await client.sessions.list()).length, before + 1);
    });

    it("stops a session", async () => {
      const session = await client.sessions.create({ provider: "echo" });
      await session.stop();
      assert.equal((await session.info()).status, "stopped");
    });

    it("reports an unknown provider as AB-1001", async () => {
      await assert.rejects(
        () => client.sessions.create({ provider: "nope" }),
        (error: unknown) => (error as { code?: string }).code === "AB-1001",
      );
    });

    it("resumes a stopped session", async () => {
      const session = await client.sessions.create({ provider: "echo" });
      await session.stop();

      const resumed = await client.sessions.resume(session.id);
      assert.equal((await resumed.info()).status, "ready");
      assert.ok((await resumed.send("after resume")).turnId);
    });

    it("changes the permission mode on a live session", async () => {
      const session = await client.sessions.create({ provider: "echo" });
      assert.equal((await session.setPermissionMode("allow")).permissionMode, "allow");
    });

    it("lists MCP servers", async () => {
      assert.deepEqual(await client.mcp.list(), []);
    });

    it("streams message events to a session subscriber", async () => {
      const session = await client.sessions.create({ provider: "echo" });

      const received: string[] = [];
      session.on("message", (event) => received.push(event.content));

      await session.send("hello");
      // The HTTP backend delivers over a socket, so give the frame a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.deepEqual(received, ["echo:hello"]);
    });
  });
}

parity("embedded", async () => {
  const agent = new AgentBridge();
  agent.registerProvider(echoProvider() as never);
  agent.attachMcp(new McpManager());
  return {
    client: createClient({ transport: "embedded", agent }),
    teardown: async () => {},
  };
});

parity("http", async () => {
  const agent = new AgentBridge();
  agent.registerProvider(echoProvider() as never);
  agent.attachMcp(new McpManager());
  await agent.start();

  const server = new RuntimeServer({ agent, port: 0 });
  const address = await server.start();

  return {
    client: createClient({
      transport: "http",
      baseUrl: `http://${address.host}:${address.port}`,
      token: address.token,
      webSocket: (url) => new WebSocket(url) as never,
    }),
    teardown: async () => {
      await server.stop();
      await agent.stop();
    },
  };
});
