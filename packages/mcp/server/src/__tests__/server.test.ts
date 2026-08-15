import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridge, type AgentEventPayload } from "@jeonhui/agentbridge-core";

import { AgentBridgeMcpServer } from "../index.js";

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

async function harness() {
  const agent = new AgentBridge();
  agent.registerProvider(echoProvider() as never);
  await agent.start();
  return { agent, server: new AgentBridgeMcpServer({ agent }) };
}

function payload(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("AgentBridgeMcpServer (spec 23)", () => {
  it("exposes the MVP tool surface", async () => {
    const { server } = await harness();
    assert.deepEqual(server.listToolNames(), [
      "agentbridge_providers_list",
      "agentbridge_sessions_list",
      "agentbridge_sessions_create",
      "agentbridge_sessions_send",
      "agentbridge_sessions_stop",
      "agentbridge_mcp_list",
      "agentbridge_tools_call",
    ]);
  });

  it("lists providers through a tool call", async () => {
    const { server } = await harness();
    const result = await server.call("agentbridge_providers_list");

    assert.notEqual(result.isError, true);
    assert.equal((payload(result) as Array<{ id: string }>)[0]?.id, "echo");
  });

  it("creates a session, sends a message, and returns the reply", async () => {
    const { server } = await harness();

    const created = payload(await server.call("agentbridge_sessions_create", { provider: "echo" })) as {
      sessionId: string;
      status: string;
    };
    assert.equal(created.status, "ready");

    const sent = payload(
      await server.call("agentbridge_sessions_send", {
        sessionId: created.sessionId,
        message: "hi",
      }),
    ) as { messages: string[] };

    assert.deepEqual(sent.messages, ["echo:hi"]);
  });

  it("stops a session", async () => {
    const { agent, server } = await harness();
    const created = payload(await server.call("agentbridge_sessions_create", { provider: "echo" })) as {
      sessionId: string;
    };

    await server.call("agentbridge_sessions_stop", { sessionId: created.sessionId });
    assert.equal(agent.sessions.get(created.sessionId).info.status, "stopped");
  });

  it("reports an unknown tool as an error result rather than throwing", async () => {
    const { server } = await harness();
    const result = await server.call("agentbridge_nope");

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /AB-2201/);
  });

  it("turns a failing operation into an error result", async () => {
    const { server } = await harness();
    const result = await server.call("agentbridge_sessions_stop", { sessionId: "missing" });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /AB-3004/);
  });

  it("refuses a call that reached the depth limit", async () => {
    const { server } = await harness();
    const result = await server.call("agentbridge_providers_list", { _agentBridgeDepth: 2 });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /depth 2 reached the limit/);
  });

  it("allows a call below the depth limit", async () => {
    const { server } = await harness();
    const result = await server.call("agentbridge_providers_list", { _agentBridgeDepth: 1 });

    assert.notEqual(result.isError, true);
  });

  it("times out a send that never finishes instead of hanging the caller", async () => {
    const agent = new AgentBridge();
    agent.registerProvider({
      id: "stuck",
      name: "Stuck",
      detect: async () => ({ available: true }),
      start: async (o: { sessionId: string }) => ({ sessionId: o.sessionId, providerId: "stuck" }),
      send: () => new Promise<void>(() => {}),
      interrupt: async () => {},
      stop: async () => {},
    } as never);
    await agent.start();

    const server = new AgentBridgeMcpServer({ agent, sendTimeoutMs: 30 });
    const created = payload(await server.call("agentbridge_sessions_create", { provider: "stuck" })) as {
      sessionId: string;
    };

    const result = await server.call("agentbridge_sessions_send", {
      sessionId: created.sessionId,
      message: "hi",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /AB-2204/);
  });
});
