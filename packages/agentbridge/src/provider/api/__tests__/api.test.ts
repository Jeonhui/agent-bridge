import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { AgentBridge } from "../../../core/index.js";
import type { AgentEventPayload } from "../../../core/events/types.js";
import { McpManager } from "../../../mcp/manager/index.js";
import { PermissionManager } from "../../../permission/index.js";
import type { SessionToolExecutor } from "../../core/AgentProvider.js";
import { GeminiApiProvider } from "../geminiApi.js";
import { OpenAICompatProvider } from "../openaiCompat.js";

/**
 * A scripted HTTP endpoint: each request pops the next responder, and every request body is
 * kept so tests can assert what actually went over the wire. Wire-accurate fakes are how this
 * repo verifies adapters whose real backend needs credentials the CI machine does not have.
 */
async function fakeEndpoint(
  responders: Array<(body: any) => unknown>,
): Promise<{ url: string; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      (body as any)._path = req.url;
      (body as any)._headers = req.headers;
      bodies.push(body);
      const responder = responders.shift();
      if (!responder) {
        res.writeHead(500).end(JSON.stringify({ error: "no scripted response left" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(responder(body)));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function collector(): { events: AgentEventPayload[]; emit: (payload: AgentEventPayload) => void } {
  const events: AgentEventPayload[] = [];
  return { events, emit: (payload) => events.push(payload) };
}

function stubExecutor(
  tools: Array<{ id: string; name: string; description: string; inputSchema: unknown; permissions: string[] }>,
  call: SessionToolExecutor["call"],
): SessionToolExecutor {
  return { list: () => tools, call };
}

describe("OpenAICompatProvider (spec 12.5)", () => {
  it("answers a text turn and replays committed history on the next one", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ choices: [{ message: { content: "hello there" } }] }),
      () => ({ choices: [{ message: { content: "still here" } }] }),
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, defaultModel: "test-model" });
      const handle = await provider.start({ sessionId: "s1", systemPrompt: "be terse" });

      const first = collector();
      await provider.send(handle, "hi", { emit: first.emit });
      assert.deepEqual(first.events, [
        { type: "message", role: "assistant", content: "hello there", delta: false, done: true },
      ]);

      const second = collector();
      await provider.send(handle, "again", { emit: second.emit });

      // The second request must carry the whole committed conversation, in order.
      assert.deepEqual(
        endpoint.bodies[1].messages.map((m: any) => [m.role, m.content]),
        [
          ["system", "be terse"],
          ["user", "hi"],
          ["assistant", "hello there"],
          ["user", "again"],
        ],
      );
      assert.equal(endpoint.bodies[0].model, "test-model");
      assert.equal(provider.historyOf("s1").length, 5);
    } finally {
      await endpoint.close();
    }
  });

  it("maps colliding tool ids through the per-request table", async () => {
    // Both ids sanitize to the same wire name; the table must keep them apart and map the
    // model's pick back to the right registry id. A reversible encoding cannot do this.
    const tools = [
      { id: "mcp:fs:write_file", name: "write_file", description: "a", inputSchema: { type: "object" }, permissions: ["write"] },
      { id: "mcp:fs.write_file", name: "write_file", description: "b", inputSchema: { type: "object" }, permissions: ["write"] },
    ];
    const endpoint = await fakeEndpoint([
      (body) => {
        const names = body.tools.map((t: any) => t.function.name);
        assert.equal(new Set(names).size, 2, "wire names must be distinct");
        return {
          choices: [{ message: { tool_calls: [
            { id: "call_a", function: { name: names[1], arguments: "{\"path\":\"x\"}" } },
          ] } }],
        };
      },
      () => ({ choices: [{ message: { content: "done" } }] }),
    ]);
    try {
      const called: string[] = [];
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url });
      const handle = await provider.start({
        sessionId: "s1",
        toolExecutor: stubExecutor(tools, async (toolId) => {
          called.push(toolId);
          return { ok: true, content: "written" };
        }),
      });
      const { events, emit } = collector();
      await provider.send(handle, "write it", { emit });

      assert.deepEqual(called, ["mcp:fs.write_file"], "the colliding second id must win the round trip");
      const types = events.map((e) => e.type);
      assert.deepEqual(types, ["tool_call", "tool_result", "message"]);
      // The follow-up request carries the tool result under the model's own call id.
      const toolMsg = endpoint.bodies[1].messages.find((m: any) => m.role === "tool");
      assert.equal(toolMsg.tool_call_id, "call_a");
    } finally {
      await endpoint.close();
    }
  });

  it("feeds a rejected executor promise back to the model instead of dying", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ choices: [{ message: { tool_calls: [
        { id: "c1", function: { name: "nope", arguments: "{}" } },
      ] } }] }),
      () => ({ choices: [{ message: { content: "understood" } }] }),
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url });
      const handle = await provider.start({
        sessionId: "s1",
        toolExecutor: stubExecutor([], async () => {
          throw new Error("unknown tool: nope");
        }),
      });
      const { events, emit } = collector();
      await provider.send(handle, "call something fictional", { emit });

      assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_error", "message"]);
      const toolMsg = endpoint.bodies[1].messages.find((m: any) => m.role === "tool");
      assert.match(toolMsg.content, /unknown tool: nope/);
    } finally {
      await endpoint.close();
    }
  });

  it("leaves history untouched when the turn is aborted mid-flight", async () => {
    const server = createServer(() => {
      /* never responds; the abort is the only way out */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const provider = new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${port}` });
      const handle = await provider.start({ sessionId: "s1" });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50).unref();

      const { emit } = collector();
      await assert.rejects(provider.send(handle, "hang", { emit, signal: controller.signal }));
      // The working-copy rule: a failed turn must not leave a dangling user message to replay.
      assert.deepEqual(provider.historyOf("s1"), []);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe("GeminiApiProvider (spec 12.5)", () => {
  it("speaks generateContent: system instruction, key header, text answer", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ candidates: [{ content: { parts: [{ text: "hi from gemini" }] } }] }),
    ]);
    try {
      const provider = new GeminiApiProvider({ apiKey: "k-test", baseUrl: endpoint.url });
      const handle = await provider.start({ sessionId: "g1", systemPrompt: "be terse", model: "gemini-2.0-flash" });
      const { events, emit } = collector();
      await provider.send(handle, "hello", { emit });

      assert.equal(events[0]?.type, "message");
      assert.equal((events[0] as any).content, "hi from gemini");
      const body = endpoint.bodies[0];
      assert.equal(body._path, "/models/gemini-2.0-flash:generateContent");
      assert.equal(body._headers["x-goog-api-key"], "k-test");
      assert.deepEqual(body.systemInstruction, { parts: [{ text: "be terse" }] });
      assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
    } finally {
      await endpoint.close();
    }
  });

  it("answers a functionCall with a functionResponse and finishes the turn", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ candidates: [{ content: { parts: [
        { functionCall: { name: "mcp_fs_write_file", args: { path: "x", content: "y" } } },
      ] } }] }),
      (body) => {
        const parts = body.contents.at(-1).parts;
        assert.ok(parts[0].functionResponse, "the tool result must come back as functionResponse");
        // Gemini keys the response by the function NAME the model called, not by a call id.
        assert.equal(parts[0].functionResponse.name, "mcp_fs_write_file");
        return { candidates: [{ content: { parts: [{ text: "done" }] } }] };
      },
    ]);
    try {
      const called: string[] = [];
      const provider = new GeminiApiProvider({ apiKey: "k-test", baseUrl: endpoint.url });
      const handle = await provider.start({
        sessionId: "g1",
        toolExecutor: stubExecutor(
          [{ id: "mcp:fs:write_file", name: "write_file", description: "w", inputSchema: { type: "object" }, permissions: ["write"] }],
          async (toolId, args) => {
            called.push(toolId);
            assert.deepEqual(args, { path: "x", content: "y" });
            return { ok: true, content: "wrote x" };
          },
        ),
      });
      const { events, emit } = collector();
      await provider.send(handle, "write it", { emit });

      assert.deepEqual(called, ["mcp:fs:write_file"]);
      assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "message"]);
    } finally {
      await endpoint.close();
    }
  });

  it("reports a missing key at detect time, not mid-conversation", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const detection = await new GeminiApiProvider().detect();
      assert.equal(detection.available, false);
      assert.match(detection.reason ?? "", /GEMINI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });
});

/**
 * The money test: an API provider inside a full AgentBridge, calling a real MCP server through
 * the core's tool executor. The point of spec 12.5 is that ask-mode approval and policy denial
 * apply to API providers natively — no permission-prompt hook, no CLI — so both paths are proven
 * against a live filesystem MCP server and a scripted model.
 */
describe("API provider inside AgentBridge (spec 12.5 end to end)", () => {
  const fixture = new URL("../../../../../../scripts/fixtures/filesystem-mcp.mjs", import.meta.url).pathname;

  async function bridge(endpointUrl: string) {
    const agent = new AgentBridge({ defaultPermissionMode: "ask" });
    agent.registerProvider(new OpenAICompatProvider({ baseUrl: endpointUrl, defaultModel: "scripted" }));
    const mcp = new McpManager();
    const permissions = new PermissionManager({
      emit: (payload) =>
        agent.events.emit({
          id: `perm_${Math.random().toString(36).slice(2)}`,
          seq: 0,
          sessionId: "host",
          timestamp: new Date().toISOString(),
          ...payload,
        } as never),
    });
    agent.attachMcp(mcp);
    agent.attachPermissions(permissions);
    await agent.start();
    const workspace = await mkdtemp(join(tmpdir(), "agentbridge-api-e2e-"));
    await writeFile(join(workspace, "notes.txt"), "before\n", "utf8");
    await mcp.add({
      id: "filesystem",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, workspace],
    });
    return { agent, mcp, workspace };
  }

  it("ask-mode approval lets the model's write through", async () => {
    const endpoint = await fakeEndpoint([
      (body) => {
        // The session's MCP tools must be offered to the model.
        const names = body.tools.map((t: any) => t.function.name);
        assert.ok(names.some((n: string) => n.includes("write_file")), `write_file missing from ${names}`);
        return { choices: [{ message: { tool_calls: [{
          id: "call_1",
          function: {
            name: names.find((n: string) => n.includes("write_file")),
            arguments: JSON.stringify({ path: "notes.txt", content: "approved write" }),
          },
        }] } }] };
      },
      () => ({ choices: [{ message: { content: "done" } }] }),
    ]);
    const { agent, workspace } = await bridge(endpoint.url);
    try {
      const prompts: any[] = [];
      agent.on("permission_request", (event: any) => {
        prompts.push(event);
        agent.permissions.approve(event.requestId);
      });
      const events: string[] = [];
      agent.on("tool_result", () => events.push("tool_result"));

      const session = await agent.sessions.create({
        provider: "openai-compat",
        mcp: ["filesystem"],
        permissionMode: "ask",
      });
      await session.send("write 'approved write' into notes.txt");

      assert.equal(prompts.length, 1, "exactly one approval must have been asked");
      assert.equal(prompts[0].tool, "write_file");
      assert.deepEqual(events, ["tool_result"]);
      assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "approved write");
    } finally {
      await agent.stop();
      await endpoint.close();
    }
  });

  it("ask-mode denial reaches the model as an AB-4001 tool result, and the file survives", async () => {
    const endpoint = await fakeEndpoint([
      (body) => ({ choices: [{ message: { tool_calls: [{
        id: "call_1",
        function: {
          name: body.tools.map((t: any) => t.function.name).find((n: string) => n.includes("write_file")),
          arguments: JSON.stringify({ path: "notes.txt", content: "should not land" }),
        },
      }] } }] }),
      (body) => {
        const toolMsg = body.messages.find((m: any) => m.role === "tool");
        assert.match(toolMsg.content, /AB-4001/, "the denial code must reach the model");
        return { choices: [{ message: { content: "acknowledged the refusal" } }] };
      },
    ]);
    const { agent, workspace } = await bridge(endpoint.url);
    try {
      agent.on("permission_request", (event: any) =>
        agent.permissions.deny(event.requestId, { reason: "the user declined" }),
      );
      const errors: any[] = [];
      agent.on("tool_error", (event: any) => errors.push(event));

      const session = await agent.sessions.create({
        provider: "openai-compat",
        mcp: ["filesystem"],
        permissionMode: "ask",
      });
      await session.send("write into notes.txt");

      assert.equal(errors.length, 1);
      assert.equal(errors[0].error?.code, "AB-4001");
      assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before\n");
    } finally {
      await agent.stop();
      await endpoint.close();
    }
  });
});
