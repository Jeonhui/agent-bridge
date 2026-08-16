import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AgentBridge } from "../agent/AgentBridge.js";
import { FileStorage } from "../storage/FileStorage.js";
import type { AgentEventPayload } from "../events/types.js";

function echoProvider(nativeSessionId = "native-1") {
  return {
    id: "echo",
    name: "Echo",
    detect: async () => ({ available: true, version: "1.0.0" }),
    start: async (o: { sessionId: string; resumeToken?: string }) => ({
      sessionId: o.sessionId,
      providerId: "echo",
      nativeSessionId: o.resumeToken ?? nativeSessionId,
    }),
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

function silent() {
  return { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {} };
}

async function bridge(dataDir: string): Promise<AgentBridge> {
  const agent = new AgentBridge({
    storage: new FileStorage({ dataDir }),
    logger: silent() as never,
  });
  agent.registerProvider(echoProvider() as never);
  return agent;
}

describe("session persistence across a restart (spec 28.2)", () => {
  it("restores session metadata written by a previous process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentbridge-persist-"));

    const first = await bridge(dataDir);
    await first.start();
    const created = await first.sessions.create({
      provider: "echo",
      title: "work in progress",
      workingDirectory: "/workspace",
      model: "fast",
      mcp: [],
    });
    await first.stop();

    // A brand new instance, as if the daemon had been restarted.
    const second = await bridge(dataDir);
    await second.start();

    const restored = second.sessions.list();
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.id, created.id);
    assert.equal(restored[0]?.title, "work in progress");
    assert.equal(restored[0]?.workingDirectory, "/workspace");
    assert.equal(restored[0]?.model, "fast");
    await second.stop();
  });

  it("keeps cumulative usage across a restart - it is a running total, not turn state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentbridge-persist-"));

    const usageProvider = {
      ...echoProvider(),
      id: "metered",
      send: async (
        _handle: unknown,
        message: string,
        { emit }: { emit: (payload: AgentEventPayload) => void },
      ) => {
        emit({ type: "usage", model: "metered-v1", inputTokens: 5, outputTokens: 2 });
        emit({ type: "message", role: "assistant", content: `echo:${message}`, delta: false, done: true });
      },
    };

    const first = new AgentBridge({ storage: new FileStorage({ dataDir }), logger: silent() as never });
    first.registerProvider(usageProvider as never);
    await first.start();
    const session = await first.sessions.create({ provider: "metered", mcp: [] });
    await session.send("one");
    await session.send("two");
    assert.deepEqual(session.info.usage, { inputTokens: 10, outputTokens: 4, turns: 2 });
    await first.stop();

    const second = new AgentBridge({ storage: new FileStorage({ dataDir }), logger: silent() as never });
    second.registerProvider(usageProvider as never);
    await second.start();
    const restored = second.sessions.list()[0];
    assert.deepEqual(restored?.usage, { inputTokens: 10, outputTokens: 4, turns: 2 });
    assert.equal(restored?.model, "metered-v1");
  });

  it("restores a session as stopped, because its agent process is gone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentbridge-persist-"));

    const first = await bridge(dataDir);
    await first.start();
    const session = await first.sessions.create({ provider: "echo" });
    assert.equal(session.info.status, "ready");
    await first.stop();

    const second = await bridge(dataDir);
    await second.start();

    assert.equal(second.sessions.get(session.id).info.status, "stopped");
    await second.stop();
  });

  it("resumes a restored session using the provider session id it kept", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentbridge-persist-"));

    const first = await bridge(dataDir);
    await first.start();
    const session = await first.sessions.create({ provider: "echo" });
    await session.send("before restart");
    await first.stop();

    const resumeTokens: Array<string | undefined> = [];
    const second = new AgentBridge({
      storage: new FileStorage({ dataDir }),
      logger: silent() as never,
    });
    second.registerProvider({
      ...echoProvider(),
      start: async (o: { sessionId: string; resumeToken?: string }) => {
        resumeTokens.push(o.resumeToken);
        return { sessionId: o.sessionId, providerId: "echo", nativeSessionId: "native-1" };
      },
    } as never);
    await second.start();

    const resumed = await second.sessions.resume(session.id);
    assert.equal(resumed.info.status, "ready");
    assert.deepEqual(resumeTokens, ["native-1"], "the provider session id survived the restart");

    await resumed.send("after restart");
    await second.stop();
  });

  it("keeps the default in-memory backend from leaking between instances", async () => {
    const first = new AgentBridge();
    first.registerProvider(echoProvider() as never);
    await first.start();
    await first.sessions.create({ provider: "echo" });
    await first.stop();

    const second = new AgentBridge();
    second.registerProvider(echoProvider() as never);
    await second.start();

    assert.deepEqual(second.sessions.list(), [], "memory storage is per instance");
    await second.stop();
  });

  it("a storage failure does not take the session down", async () => {
    const failing = {
      sessions: {
        get: async () => undefined,
        list: async () => [],
        put: async () => {
          throw new Error("disk on fire");
        },
        delete: async () => {},
      },
      mcpServers: { get: async () => undefined, list: async () => [], put: async () => {}, delete: async () => {} },
      permissionRules: { get: async () => undefined, list: async () => [], put: async () => {}, delete: async () => {} },
      appendApproval: async () => {},
      listApprovals: async () => [],
    };

    const agent = new AgentBridge({ storage: failing as never, logger: silent() as never });
    agent.registerProvider(echoProvider() as never);
    await agent.start();

    const session = await agent.sessions.create({ provider: "echo" });
    assert.equal(session.info.status, "ready");
    await session.send("still works");
    await agent.stop();
  });
});
