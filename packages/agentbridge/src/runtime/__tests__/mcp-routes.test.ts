import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { fixture } from "../../testing/repoRoot.js";
import { AgentBridge, type AgentEventPayload } from "../../core/index.js";
import { McpManager } from "../../mcp/manager/index.js";

import { RuntimeServer } from "../server.js";

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

describe("MCP and session management routes (spec 16.2)", () => {
  const agent = new AgentBridge();
  const mcp = new McpManager();
  const server = new RuntimeServer({ agent, port: 0 });
  let base: string;
  let token: string;
  let workspace: string;
  let fixturePath: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentbridge-routes-"));
    await writeFile(join(workspace, "a.txt"), "hi\n", "utf8");
    fixturePath = fixture("filesystem-mcp.mjs");

    agent.registerProvider(echoProvider() as never);
    agent.attachMcp(mcp);
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
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  const json = async (response: Response): Promise<Record<string, never>> =>
    (await response.json()) as Record<string, never>;

  it("registers an MCP server over POST /mcp", async () => {
    const response = await call("/mcp", {
      method: "POST",
      body: JSON.stringify({
        id: "filesystem",
        transport: "stdio",
        command: process.execPath,
        args: [fixturePath, workspace],
      }),
    });

    assert.equal(response.status, 201);
    const state = await json(response);
    assert.equal(state["state"], "connected");
    assert.equal(state["toolCount"], 2);
  });

  it("lists and reads MCP servers", async () => {
    assert.equal(((await json(await call("/mcp")))["items"] as never as unknown[]).length, 1);
    assert.equal((await json(await call("/mcp/filesystem")))["id"], "filesystem");
  });

  it("rejects a duplicate registration with AB-2002", async () => {
    const response = await call("/mcp", {
      method: "POST",
      body: JSON.stringify({ id: "filesystem", transport: "stdio", command: "node" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await json(response))["error"]?.["code"], "AB-2002");
  });

  it("rejects an invalid config with AB-2001", async () => {
    const response = await call("/mcp", {
      method: "POST",
      body: JSON.stringify({ id: "Bad Id", transport: "stdio", command: "node" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await json(response))["error"]?.["code"], "AB-2001");
  });

  it("reloads a server and reports the diff", async () => {
    const response = await call("/mcp/filesystem/reload", { method: "POST" });
    assert.equal(response.status, 200);

    const result = await json(response);
    assert.equal(result["serverId"], "filesystem");
    assert.ok(Array.isArray(result["addedTools"]));
  });

  it("lists tools discovered from the registered server", async () => {
    const tools = (await json(await call("/tools")))["items"] as never as Array<{ name: string }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["read_file", "write_file"]);
  });

  it("rebinds a session's MCP servers with PATCH /sessions/:id/mcp", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );

    const response = await call(`/sessions/${session["id"]}/mcp`, {
      method: "PATCH",
      body: JSON.stringify({ servers: ["filesystem"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await json(response))["mcpServers"], ["filesystem"]);
  });

  it("validates the PATCH body", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );

    const response = await call(`/sessions/${session["id"]}/mcp`, {
      method: "PATCH",
      body: JSON.stringify({ servers: "filesystem" }),
    });
    assert.equal(response.status, 400);
  });

  it("changes the permission mode", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );

    const ok = await call(`/sessions/${session["id"]}/permission-mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode: "allow" }),
    });
    assert.equal((await json(ok))["permissionMode"], "allow");

    const bad = await call(`/sessions/${session["id"]}/permission-mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode: "maybe" }),
    });
    assert.equal(bad.status, 400);
  });

  it("resumes a stopped session", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );
    await call(`/sessions/${session["id"]}`, { method: "DELETE" });

    const response = await call(`/sessions/${session["id"]}/resume`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await json(response))["status"], "ready");
  });

  it("re-detects providers on demand", async () => {
    const items = (await json(await call("/providers/detect", { method: "POST", body: "{}" })))[
      "items"
    ] as never as Array<{ id: string; available: boolean }>;
    assert.equal(items[0]?.id, "echo");
    assert.equal(items[0]?.available, true);
  });

  it("refuses to remove a server a session still uses, unless forced", async () => {
    const session = await json(
      await call("/sessions", { method: "POST", body: JSON.stringify({ provider: "echo" }) }),
    );
    await call(`/sessions/${session["id"]}/mcp`, {
      method: "PATCH",
      body: JSON.stringify({ servers: ["filesystem"] }),
    });

    const blocked = await call("/mcp/filesystem", { method: "DELETE" });
    assert.equal(blocked.status, 400);
    assert.equal((await json(blocked))["error"]?.["code"], "AB-2004");

    assert.equal((await call("/mcp/filesystem?force=true", { method: "DELETE" })).status, 204);
    assert.equal((await call("/mcp/filesystem")).status, 404);
  });
});
