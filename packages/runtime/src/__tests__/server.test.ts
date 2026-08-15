import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { AgentBridge, type AgentEventPayload } from "@agentbridge/core";

import { RuntimeServer } from "../server.js";
import { generateToken, tokenMatches } from "../auth.js";

/** A provider that answers instantly, so the runtime is tested without touching a real CLI. */
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

describe("tokenMatches", () => {
  it("accepts the exact token and nothing else", () => {
    const token = generateToken();
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(token, undefined), false);
    assert.equal(tokenMatches(token, token.slice(0, -1)), false);
    assert.equal(tokenMatches(token, `${token}x`), false);
  });
});

describe("RuntimeServer (spec 16)", () => {
  const agent = new AgentBridge();
  const server = new RuntimeServer({ agent, port: 0 });
  let base: string;
  let token: string;

  before(async () => {
    agent.registerProvider(echoProvider() as never);
    await agent.start();
    const address = await server.start();
    base = `http://${address.host}:${address.port}`;
    token = address.token;
  });

  after(async () => {
    await server.stop();
    await agent.stop();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  const json = async (response: Response): Promise<Record<string, never>> =>
    (await response.json()) as Record<string, never>;

  it("serves /health without a token", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal((await json(response))["status"], "ok");
  });

  it("rejects an unauthenticated request with AB-5001", async () => {
    const response = await fetch(`${base}/providers`);
    assert.equal(response.status, 401);
    assert.equal((await json(response))["error"]?.["code"], "AB-5001");
  });

  it("lists providers", async () => {
    const body = await json(await call("/providers"));
    assert.equal(body["items"]?.[0]?.["id"], "echo");
    assert.equal(body["items"]?.[0]?.["available"], true);
  });

  it("creates a session, sends a message, and replays its events", async () => {
    const created = await call("/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "echo" }),
    });
    assert.equal(created.status, 201);
    const session = await json(created);
    assert.equal(session["status"], "ready");

    const sent = await call(`/sessions/${session["id"]}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(sent.status, 202);
    assert.ok((await json(sent))["turnId"]);

    const events = await json(await call(`/sessions/${session["id"]}/events`));
    const items = events["items"] as unknown as Array<{ type: string; content?: string }>;
    assert.equal(items.find((e) => e.type === "message")?.content, "echo:hi");
  });

  it("rejects a message with no body content", async () => {
    const created = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );

    const response = await call(`/sessions/${created["id"]}/messages`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.equal((await json(response))["error"]?.["code"], "AB-5004");
  });

  it("maps an unknown session onto 404 AB-3004", async () => {
    const response = await call("/sessions/does-not-exist");
    assert.equal(response.status, 404);
    assert.equal((await json(response))["error"]?.["code"], "AB-3004");
  });

  it("maps an unknown provider onto 404 AB-1001", async () => {
    const response = await call("/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "nope" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await json(response))["error"]?.["code"], "AB-1001");
  });

  it("rejects a malformed JSON body", async () => {
    const response = await call("/sessions", { method: "POST", body: "{" });
    assert.equal(response.status, 400);
    assert.equal((await json(response))["error"]?.["code"], "AB-5004");
  });

  it("stops a session and refuses further messages", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );

    assert.equal((await call(`/sessions/${session["id"]}`, { method: "DELETE" })).status, 204);

    const response = await call(`/sessions/${session["id"]}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "again" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await json(response))["error"]?.["code"], "AB-3002");
  });

  it("returns 404 for an unknown route", async () => {
    assert.equal((await call("/nope")).status, 404);
  });
});
