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
import { AnthropicProvider } from "../anthropic.js";
import { GeminiApiProvider } from "../geminiApi.js";
import { FileHistoryStore } from "../history.js";
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

/** A scripted SSE endpoint: each request pops a list of chunk objects, sent as `data:` lines. */
async function fakeSseEndpoint(
  responders: Array<(body: any) => unknown[]>,
): Promise<{ url: string; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      const responder = responders.shift();
      if (!responder) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of responder(body)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise((r) => server.close(() => r())) };
}

describe("OpenAICompatProvider streaming (spec 12.5)", () => {
  it("streams deltas, closes with a full message, and reports usage", async () => {
    const endpoint = await fakeSseEndpoint([
      (body) => {
        assert.equal(body.stream, true, "the request must ask for a stream");
        return [
          { model: "test-model-v2", choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          { choices: [{ delta: {} }] },
          { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } },
        ];
      },
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, defaultModel: "test-model" });
      const handle = await provider.start({ sessionId: "s1" });
      const { events, emit } = collector();
      await provider.send(handle, "hi", { emit });

      assert.deepEqual(
        events.map((e) => [e.type, (e as any).content ?? null, (e as any).delta ?? null]),
        [
          ["message", "Hel", true],
          ["message", "lo", true],
          ["message", "Hello", false],
          ["usage", null, null],
        ],
      );
      const usage = events.at(-1) as any;
      assert.equal(usage.model, "test-model-v2", "the model that actually served the turn");
      assert.equal(usage.inputTokens, 11);
      assert.equal(usage.outputTokens, 5);
      assert.equal(usage.totalTokens, 16);
      // History commits the full text once, not the deltas.
      assert.deepEqual(provider.historyOf("s1").map((m) => m.content), ["hi", "Hello"]);
    } finally {
      await endpoint.close();
    }
  });

  it("reassembles tool calls whose arguments arrive split across chunks", async () => {
    const endpoint = await fakeSseEndpoint([
      () => [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "mcp_fs_write_file" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } }] },
      ],
      () => [
        { choices: [{ delta: { content: "done" } }] },
      ],
    ]);
    try {
      const called: Array<[string, unknown]> = [];
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url });
      const handle = await provider.start({
        sessionId: "s1",
        toolExecutor: stubExecutor(
          [{ id: "mcp:fs:write_file", name: "write_file", description: "w", inputSchema: { type: "object" }, permissions: ["write"] }],
          async (toolId, args) => {
            called.push([toolId, args]);
            return { ok: true, content: "written" };
          },
        ),
      });
      const { events, emit } = collector();
      await provider.send(handle, "write it", { emit });

      assert.deepEqual(called, [["mcp:fs:write_file", { path: "x" }]]);
      assert.deepEqual(
        events.map((e) => e.type),
        ["tool_call", "tool_result", "message", "message"],
        "tool round, then the streamed final answer (delta + full)",
      );
    } finally {
      await endpoint.close();
    }
  });

  it("accepts a plain JSON answer to a stream request", async () => {
    // Some compatible servers ignore `stream: true`; a complete answer is not an error.
    const endpoint = await fakeEndpoint([
      () => ({ model: "m1", usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ message: { content: "plain" } }] }),
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url });
      const handle = await provider.start({ sessionId: "s1" });
      const { events, emit } = collector();
      await provider.send(handle, "hi", { emit });
      assert.deepEqual(events.map((e) => e.type), ["message", "usage"]);
      assert.equal((events[0] as any).content, "plain");
    } finally {
      await endpoint.close();
    }
  });

  it("keeps streaming off when the host disables it", async () => {
    const endpoint = await fakeEndpoint([
      (body) => {
        assert.equal(body.stream, undefined, "no stream field when streaming is disabled");
        return { choices: [{ message: { content: "ok" } }] };
      },
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      assert.equal(provider.capabilities.streaming, false);
      const handle = await provider.start({ sessionId: "s1" });
      const { emit } = collector();
      await provider.send(handle, "hi", { emit });
    } finally {
      await endpoint.close();
    }
  });
});

describe("GeminiApiProvider (spec 12.5)", () => {
  it("speaks generateContent: system instruction, key header, text answer", async () => {
    const endpoint = await fakeEndpoint([
      () => ({
        modelVersion: "gemini-2.0-flash-001",
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
        candidates: [{ content: { parts: [{ text: "hi from gemini" }] } }],
      }),
    ]);
    try {
      const provider = new GeminiApiProvider({ apiKey: "k-test", baseUrl: endpoint.url });
      const handle = await provider.start({ sessionId: "g1", systemPrompt: "be terse", model: "gemini-2.0-flash" });
      const { events, emit } = collector();
      await provider.send(handle, "hello", { emit });

      assert.equal(events[0]?.type, "message");
      assert.equal((events[0] as any).content, "hi from gemini");
      const usage = events.find((e) => e.type === "usage") as any;
      assert.equal(usage?.model, "gemini-2.0-flash-001");
      assert.equal(usage?.inputTokens, 9);
      assert.equal(usage?.outputTokens, 3);
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

describe("message attachments (spec 13.6)", () => {
  const PNG = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" };
  const PDF = { type: "document" as const, data: "cGRm", mimeType: "application/pdf" };

  it("openai dialect: images become data URLs alongside the text", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ choices: [{ message: { content: "seen" } }] }),
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "s1" });
      await provider.send(handle, "what is this?", { emit: collector().emit, attachments: [PNG] });

      const user = endpoint.bodies[0].messages.at(-1);
      assert.deepEqual(user.content, [
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "text", text: "what is this?" },
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it("openai dialect: a document is refused as AB-1005, not dropped", async () => {
    const endpoint = await fakeEndpoint([]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "s1" });
      await assert.rejects(
        provider.send(handle, "read this", { emit: collector().emit, attachments: [PDF] }),
        (error: any) => error.code === "AB-1005",
      );
      assert.equal(endpoint.bodies.length, 0, "nothing must go over the wire");
    } finally {
      await endpoint.close();
    }
  });

  it("anthropic: image and document blocks precede the text in the user turn", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ content: [{ type: "text", text: "seen" }] }),
    ]);
    try {
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "a1" });
      await provider.send(handle, "look", { emit: collector().emit, attachments: [PNG, PDF] });

      const user = endpoint.bodies[0].messages.at(-1);
      assert.deepEqual(user.content, [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
        { type: "text", text: "look" },
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it("gemini: attachments become inlineData parts", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ candidates: [{ content: { parts: [{ text: "seen" }] } }] }),
    ]);
    try {
      const provider = new GeminiApiProvider({ apiKey: "k", baseUrl: endpoint.url });
      const handle = await provider.start({ sessionId: "g1" });
      await provider.send(handle, "look", { emit: collector().emit, attachments: [PNG] });

      assert.deepEqual(endpoint.bodies[0].contents.at(-1).parts, [
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        { text: "look" },
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it("attachments survive in history and replay on the next turn", async () => {
    const endpoint = await fakeEndpoint([
      () => ({ choices: [{ message: { content: "first" } }] }),
      () => ({ choices: [{ message: { content: "second" } }] }),
    ]);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "s1" });
      await provider.send(handle, "what is this?", { emit: collector().emit, attachments: [PNG] });
      await provider.send(handle, "and now?", { emit: collector().emit });

      const replayedUser = endpoint.bodies[1].messages.find((m: any) => Array.isArray(m.content));
      assert.ok(replayedUser, "the image-bearing turn must replay with its image");
      assert.equal(replayedUser.content[0].type, "image_url");
    } finally {
      await endpoint.close();
    }
  });
});

describe("API provider retry policy (spec 12.5)", () => {
  /** A server that fails `failures` times with `status`, then succeeds. */
  async function flakyEndpoint(failures: number, status: number, headers: Record<string, string> = {}) {
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests += 1;
        if (requests <= failures) {
          res.writeHead(status, headers).end(JSON.stringify({ error: "try later" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      requests: () => requests,
      close: () => new Promise((r) => server.close(() => r(null))),
    };
  }

  it("retries a 429 honoring Retry-After and recovers", async () => {
    const endpoint = await flakyEndpoint(2, 429, { "retry-after": "0" });
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "s1" });
      const { events, emit } = collector();
      await provider.send(handle, "hi", { emit });

      assert.equal(endpoint.requests(), 3, "two failures, then the success");
      assert.equal((events[0] as any).content, "recovered");
    } finally {
      await endpoint.close();
    }
  });

  it("retries a 503 on the streaming path before the first byte", async () => {
    const endpoint = await flakyEndpoint(1, 503, { "retry-after": "0" });
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url });   // streaming on
      const handle = await provider.start({ sessionId: "s1" });
      const { events, emit } = collector();
      await provider.send(handle, "hi", { emit });
      assert.equal(endpoint.requests(), 2);
      assert.equal((events.find((e) => e.type === "message") as any).content, "recovered");
    } finally {
      await endpoint.close();
    }
  });

  it("does not retry a 400 - the request's own fault repeats identically", async () => {
    const endpoint = await flakyEndpoint(5, 400);
    try {
      const provider = new OpenAICompatProvider({ baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "s1" });
      await assert.rejects(
        provider.send(handle, "hi", { emit: collector().emit }),
        (error: any) => error.code === "AB-1006" && String(error.message).includes("400"),
      );
      assert.equal(endpoint.requests(), 1, "a 400 must not be retried");
    } finally {
      await endpoint.close();
    }
  });

  it("maxRetries: 0 disables retrying entirely", async () => {
    const endpoint = await flakyEndpoint(1, 429, { "retry-after": "0" });
    try {
      const provider = new OpenAICompatProvider({
        baseUrl: endpoint.url,
        streaming: false,
        retry: { maxRetries: 0 },
      });
      const handle = await provider.start({ sessionId: "s1" });
      await assert.rejects(
        provider.send(handle, "hi", { emit: collector().emit }),
        (error: any) => error.code === "AB-1006" && String(error.message).includes("429"),
      );
      assert.equal(endpoint.requests(), 1);
    } finally {
      await endpoint.close();
    }
  });
});

describe("API provider resume via FileHistoryStore (spec 12.5)", () => {
  it("declares resume only when a store is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentbridge-history-"));
    assert.equal(new OpenAICompatProvider({ baseUrl: "http://x" }).capabilities.resume, false);
    assert.equal(
      new OpenAICompatProvider({ baseUrl: "http://x", history: new FileHistoryStore({ directory: dir }) })
        .capabilities.resume,
      true,
    );
  });

  it("replays the conversation after a process restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentbridge-history-"));
    const endpoint = await fakeEndpoint([
      () => ({ choices: [{ message: { content: "first answer" } }] }),
      () => ({ choices: [{ message: { content: "second answer" } }] }),
    ]);
    try {
      // Process one: a turn happens and its history lands in the store.
      const first = new OpenAICompatProvider({
        baseUrl: endpoint.url,
        streaming: false,
        history: new FileHistoryStore({ directory: dir }),
      });
      const handle = await first.start({ sessionId: "s-restart", systemPrompt: "be terse" });
      assert.equal(handle.nativeSessionId, "s-restart", "the store key doubles as the resume token");
      await first.send(handle, "one", { emit: collector().emit });

      // Process two: a NEW provider instance - the in-memory map is gone, only the files remain.
      const second = new OpenAICompatProvider({
        baseUrl: endpoint.url,
        streaming: false,
        history: new FileHistoryStore({ directory: dir }),
      });
      const resumed = await second.start({ sessionId: "s-restart", resumeToken: "s-restart" });
      await second.send(resumed, "two", { emit: collector().emit });

      assert.deepEqual(
        endpoint.bodies[1].messages.map((m: any) => [m.role, m.content]),
        [
          ["system", "be terse"],
          ["user", "one"],
          ["assistant", "first answer"],
          ["user", "two"],
        ],
        "the second process must replay everything the first one said",
      );
    } finally {
      await endpoint.close();
    }
  });

  it("quarantines a corrupt history file instead of failing the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentbridge-history-"));
    const store = new FileHistoryStore({ directory: dir });
    await store.save("s1", [{ role: "user", content: "hello" }]);
    await writeFile(join(dir, "s1.json"), "{ not json", "utf8");

    assert.equal(await store.load("s1"), undefined);
    const quarantined = await readFile(join(dir, "s1.json.corrupt"), "utf8");
    assert.equal(quarantined, "{ not json", "the bytes must survive for diagnosis");
  });
});

describe("AnthropicProvider (spec 12.5)", () => {
  it("speaks the Messages API: system field, alternating roles, usage", async () => {
    const endpoint = await fakeEndpoint([
      () => ({
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "hello from claude" }],
        usage: { input_tokens: 20, output_tokens: 6 },
      }),
    ]);
    try {
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({ sessionId: "a1", systemPrompt: "be terse" });
      const { events, emit } = collector();
      await provider.send(handle, "hi", { emit });

      const body = endpoint.bodies[0];
      assert.equal(body._path, "/messages");
      assert.equal(body._headers["x-api-key"], "k");
      assert.equal(body._headers["anthropic-version"], "2023-06-01");
      assert.equal(body.system, "be terse");
      assert.equal(typeof body.max_tokens, "number", "the Messages API requires max_tokens");
      assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);

      assert.deepEqual(events.map((e) => e.type), ["message", "usage"]);
      assert.equal((events[0] as any).content, "hello from claude");
      assert.equal((events[1] as any).model, "claude-sonnet-4-5-20250929");
      assert.equal((events[1] as any).inputTokens, 20);
    } finally {
      await endpoint.close();
    }
  });

  it("answers tool_use with a merged tool_result user turn", async () => {
    const endpoint = await fakeEndpoint([
      (body) => ({
        content: [
          { type: "text", text: "let me write that" },
          { type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: { path: "x", content: "y" } },
        ],
      }),
      (body) => {
        // Roles must alternate: the tool result arrives as ONE user message of tool_result blocks.
        const last = body.messages.at(-1);
        assert.equal(last.role, "user");
        assert.deepEqual(last.content[0].type, "tool_result");
        assert.equal(last.content[0].tool_use_id, "toolu_1");
        const roles = body.messages.map((m: any) => m.role);
        assert.deepEqual(roles, ["user", "assistant", "user"], "no consecutive same-role messages");
        return { content: [{ type: "text", text: "done" }] };
      },
    ]);
    try {
      const called: string[] = [];
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: endpoint.url, streaming: false });
      const handle = await provider.start({
        sessionId: "a1",
        toolExecutor: stubExecutor(
          [{ id: "mcp:fs:write_file", name: "write_file", description: "w", inputSchema: { type: "object" }, permissions: ["write"] }],
          async (toolId) => {
            called.push(toolId);
            return { ok: true, content: "written" };
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

  it("streams text and assembles tool input from partial_json fragments", async () => {
    const endpoint = await fakeSseEndpoint([
      (body) => {
        assert.equal(body.stream, true);
        return [
          { type: "message_start", message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 30 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Wri" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ting" } },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: body.tools[0].name } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"x\"}" } },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } },
          { type: "message_stop" },
        ];
      },
      () => [
        { type: "message_start", message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 40 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      ],
    ]);
    try {
      const called: Array<[string, unknown]> = [];
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: endpoint.url });
      const handle = await provider.start({
        sessionId: "a1",
        toolExecutor: stubExecutor(
          [{ id: "mcp:fs:write_file", name: "write_file", description: "w", inputSchema: { type: "object" }, permissions: ["write"] }],
          async (toolId, args) => {
            called.push([toolId, args]);
            return { ok: true, content: "written" };
          },
        ),
      });
      const { events, emit } = collector();
      await provider.send(handle, "write it", { emit });

      assert.deepEqual(called, [["mcp:fs:write_file", { path: "x" }]]);
      const kinds = events.map((e) => [e.type, (e as any).delta ?? null]);
      assert.deepEqual(kinds, [
        ["message", true],   // "Wri"
        ["message", true],   // "ting"
        ["tool_call", null],
        ["tool_result", null],
        ["message", true],   // "done" streamed
        ["message", false],  // full closing message
        ["usage", null],
      ]);
      const usage = events.at(-1) as any;
      assert.equal(usage.inputTokens, 70, "usage sums the rounds of one turn");
      assert.equal(usage.outputTokens, 19);
      assert.equal(usage.model, "claude-sonnet-4-5-20250929");
    } finally {
      await endpoint.close();
    }
  });

  it("reports a missing key at detect time", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const detection = await new AnthropicProvider().detect();
      assert.equal(detection.available, false);
      assert.match(detection.reason ?? "", /ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
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

  it("shows the provider's default model in listings", async () => {
    const agent = new AgentBridge();
    agent.registerProvider(new OpenAICompatProvider({ baseUrl: "http://127.0.0.1:9", defaultModel: "llama3.2" }) as never);
    await agent.start();
    const providers = await agent.providers.list();
    assert.equal(providers[0]?.defaultModel, "llama3.2");
    await agent.stop();
  });

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
