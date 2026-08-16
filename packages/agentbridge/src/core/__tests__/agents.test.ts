import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridge } from "../agent/AgentBridge.js";
import type { AgentEventPayload } from "../events/types.js";

interface StartCapture {
  sessionId: string;
  model?: string;
  systemPrompt?: string;
  toolExecutor?: {
    call(toolId: string, args: unknown): Promise<{ ok: boolean; content?: unknown; error?: unknown }>;
  };
}

/** Echoes every message and records what each session was started with. */
function echoProvider() {
  const starts: StartCapture[] = [];
  const messages = new Map<string, string[]>();
  return {
    starts,
    messages,
    id: "echo",
    name: "Echo",
    detect: async () => ({ available: true, version: "1.0.0" }),
    start: async (options: StartCapture) => {
      starts.push(options);
      messages.set(options.sessionId, []);
      return { sessionId: options.sessionId, providerId: "echo" };
    },
    send: async (
      handle: { sessionId: string },
      message: string,
      { emit }: { emit: (payload: AgentEventPayload) => void },
    ) => {
      messages.get(handle.sessionId)?.push(message);
      emit({ type: "message", role: "assistant", content: `echo:${message}`, delta: false, done: true });
    },
    interrupt: async () => {},
    stop: async () => {},
  };
}

/** On every turn, calls its own agent tool through the executor — the recursion probe. */
function chainProvider() {
  const outcomes: Array<{ ok: boolean; error?: { code?: string } }> = [];
  return {
    outcomes,
    id: "chainer",
    name: "Chainer",
    detect: async () => ({ available: true, version: "1.0.0" }),
    start: async (options: StartCapture) => ({ sessionId: options.sessionId, providerId: "chainer", options }),
    send: async (
      handle: { options: StartCapture },
      message: string,
      { emit }: { emit: (payload: AgentEventPayload) => void },
    ) => {
      const outcome = await handle.options.toolExecutor!.call("agent:chain:ask", { message });
      outcomes.push(outcome as never);
      emit({ type: "message", role: "assistant", content: JSON.stringify(outcome), delta: false, done: true });
    },
    interrupt: async () => {},
    stop: async () => {},
  };
}

async function bridge(provider = echoProvider()) {
  const agent = new AgentBridge();
  agent.registerProvider(provider as never);
  await agent.start();
  return { agent, provider };
}

describe("agent definitions (spec 12.6)", () => {
  it("defines, lists, gets, and removes", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "reviewer", name: "Code Reviewer", description: "Reviews diffs.", provider: "echo" });
    assert.equal(agent.agents.list().length, 1);
    assert.equal(agent.agents.get("reviewer").name, "Code Reviewer");
    agent.agents.remove("reviewer");
    assert.equal(agent.agents.list().length, 0);
  });

  it("rejects malformed definitions with AB-1008", async () => {
    const { agent } = await bridge();
    assert.throws(
      () => agent.agents.define({ id: "Bad Id!", name: "x", description: "y", provider: "echo" }),
      (error: any) => error.code === "AB-1008",
    );
    assert.throws(
      () => agent.agents.define({ id: "ok", name: "", description: "y", provider: "echo" }),
      (error: any) => error.code === "AB-1008",
    );
    assert.throws(() => agent.agents.get("ghost"), (error: any) => error.code === "AB-1008");
  });

  it("expands a definition at sessions.create, with per-call overrides winning", async () => {
    const { agent, provider } = await bridge();
    agent.agents.define({
      id: "reviewer",
      name: "Code Reviewer",
      description: "Reviews diffs.",
      role: "You are a strict reviewer.",
      provider: "echo",
      model: "sonnet",
    });

    const fromDefinition = await agent.sessions.create({ agent: "reviewer" });
    assert.equal(fromDefinition.info.title, "Code Reviewer");
    assert.equal(fromDefinition.info.model, "sonnet");
    assert.equal(provider.starts[0]?.systemPrompt, "You are a strict reviewer.");

    const overridden = await agent.sessions.create({ agent: "reviewer", model: "haiku" });
    assert.equal(overridden.info.model, "haiku");

    await assert.rejects(agent.sessions.create({ agent: "ghost" }), (error: any) => error.code === "AB-1008");
  });
});

describe("agents as tools (spec 12.6)", () => {
  it("lists callable definitions as EXECUTE tools, even with no MCP attached", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "reviewer", name: "Code Reviewer", description: "Reviews diffs.", provider: "echo" });
    agent.agents.define({ id: "silent", name: "Silent", description: "Not callable.", provider: "echo", callable: false });

    const tools = agent.tools.list();
    assert.deepEqual(tools.map((tool) => tool.id), ["agent:reviewer:ask"]);
    assert.deepEqual(tools[0]?.permissions, ["EXECUTE"]);
    assert.equal(agent.tools.get("agent:reviewer:ask").name, "ask_reviewer");
  });

  it("offers agent tools to a provider's tool executor even with no MCP attached", async () => {
    const { agent, provider } = await bridge();
    agent.agents.define({ id: "helper", name: "Helper", description: "Echoes.", provider: "echo" });

    await agent.sessions.create({ provider: "echo" });
    const executor = provider.starts.at(-1)?.toolExecutor as { list(): Array<{ id: string }> } | undefined;
    assert.ok(executor, "the session must receive a tool executor");
    assert.deepEqual(
      executor.list().map((tool) => tool.id),
      ["agent:helper:ask"],
      "the sub-agent must be advertised, not just callable",
    );
  });

  it("tools.call resolves ok:false for an unknown tool instead of throwing", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "helper", name: "Helper", description: "Echoes.", provider: "echo" });
    const result = await agent.tools.call("mcp:ghost:tool", {});
    assert.equal(result.ok, false);
    assert.ok(result.error, "the documented contract: resolve with ok:false, never throw");
  });

  it("still reports AB-2003 when neither MCP nor agents exist", async () => {
    const { agent } = await bridge();
    assert.throws(() => agent.tools.list(), (error: any) => error.code === "AB-2003");
  });

  it("runs a oneshot call: reply comes back, the session does not linger", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "reviewer", name: "Code Reviewer", description: "Reviews diffs.", provider: "echo" });

    const result = await agent.tools.call("agent:reviewer:ask", { message: "review this" });
    assert.equal(result.ok, true);
    const content = result.content as { agent: string; sessionId: string; reply: string };
    assert.equal(content.agent, "reviewer");
    assert.equal(content.reply, "echo:review this");
    assert.equal(agent.sessions.get(content.sessionId).info.status, "stopped");
  });

  it("rejects a call without a message as AB-2203", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "reviewer", name: "Code Reviewer", description: "Reviews diffs.", provider: "echo" });
    const result = await agent.tools.call("agent:reviewer:ask", {});
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "AB-2203");
  });

  it("persistent memory reuses one session so the conversation accumulates", async () => {
    const { agent, provider } = await bridge();
    agent.agents.define({
      id: "scribe", name: "Scribe", description: "Remembers.", provider: "echo", memory: "persistent",
    });

    const first = (await agent.tools.call("agent:scribe:ask", { message: "one" })).content as { sessionId: string };
    const second = (await agent.tools.call("agent:scribe:ask", { message: "two" })).content as { sessionId: string };
    assert.equal(first.sessionId, second.sessionId);
    assert.deepEqual(provider.messages.get(first.sessionId), ["one", "two"]);
    assert.notEqual(agent.sessions.get(first.sessionId).info.status, "stopped");
  });

  it("permission policy applies to agent calls before any session is created", async () => {
    const { agent } = await bridge();
    agent.agents.define({ id: "reviewer", name: "Code Reviewer", description: "Reviews diffs.", provider: "echo" });
    agent.attachPermissions({
      authorize: async () => ({ effect: "deny", reason: "agents are off limits here" }),
      approve: () => {}, deny: () => {}, pending: () => [], setRule: () => {}, listRules: () => [],
      cancelSession: () => {},
    });

    const before = agent.sessions.list().length;
    const result = await agent.tools.call("agent:reviewer:ask", { message: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "AB-4001");
    assert.equal(agent.sessions.list().length, before, "a denied call must not have created a session");
  });

  it("cuts an agent-calls-agent chain at maxAgentCallDepth with AB-1009", async () => {
    const provider = chainProvider();
    const agent = new AgentBridge();
    agent.registerProvider(provider as never);
    await agent.start();
    agent.agents.define({ id: "chain", name: "Chain", description: "Calls itself.", provider: "chainer" });

    // Host (depth 0) -> chain (1) -> chain (2) -> the third hop must be refused.
    const result = await agent.tools.call("agent:chain:ask", { message: "go" });
    assert.equal(result.ok, true, "the outer call itself succeeds; the refusal happens inside");
    const codes = provider.outcomes.map((o) => (o.ok ? "ok" : (o.error as { code?: string })?.code));
    assert.ok(codes.includes("AB-1009"), `expected AB-1009 somewhere in the chain, saw ${codes}`);
    assert.ok(provider.outcomes.length <= 3, "the chain must terminate");
  });
});
