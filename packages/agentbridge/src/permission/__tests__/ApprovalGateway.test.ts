import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApprovalGateway, type PromptDecision } from "../ApprovalGateway.js";

async function gateway(
  onRequest: (payload: { toolName: string; input: unknown }) => Promise<PromptDecision>,
) {
  const instance = new ApprovalGateway({ onRequest: onRequest as never });
  const address = await instance.start();
  const ask = (body: unknown, token = address.token) =>
    fetch(`${address.url}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { instance, address, ask };
}

describe("ApprovalGateway (spec 25.4)", () => {
  it("binds to loopback with a token", async () => {
    const { instance, address } = await gateway(async () => ({ behavior: "allow" }));
    assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(address.token.length >= 32);
    await instance.stop();
  });

  it("passes the request through and returns the decision", async () => {
    const seen: Array<{ toolName: string; input: unknown }> = [];
    const { instance, ask } = await gateway(async (payload) => {
      seen.push(payload);
      return { behavior: "allow", updatedInput: payload.input };
    });

    const response = await ask({ sessionId: "s1", toolName: "write_file", input: { path: "a" } });
    assert.deepEqual(await response.json(), { behavior: "allow", updatedInput: { path: "a" } });
    assert.deepEqual(seen[0]?.toolName, "write_file");
    await instance.stop();
  });

  it("rejects a wrong token without consulting the host", async () => {
    let consulted = false;
    const { instance, ask } = await gateway(async () => {
      consulted = true;
      return { behavior: "allow" };
    });

    const response = await ask({ toolName: "x" }, "wrong-token");
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as PromptDecision).behavior, "deny");
    assert.equal(consulted, false);
    await instance.stop();
  });

  it("answers a malformed body with a denial rather than hanging the agent", async () => {
    const { instance, ask } = await gateway(async () => ({ behavior: "allow" }));
    const response = await ask("{ not json");

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as PromptDecision).behavior, "deny");
    await instance.stop();
  });

  it("turns a host failure into a denial, because the agent is blocked on the answer", async () => {
    const { instance, ask } = await gateway(async () => {
      throw new Error("host exploded");
    });

    const response = await ask({ toolName: "x" });
    const body = (await response.json()) as PromptDecision;
    assert.equal(response.status, 200, "the agent still needs a reply");
    assert.equal(body.behavior, "deny");
    assert.match(body.message ?? "", /host exploded/);
    await instance.stop();
  });

  it("serves nothing but the approval route", async () => {
    const { instance, address } = await gateway(async () => ({ behavior: "allow" }));
    const response = await fetch(`${address.url}/`, {
      headers: { authorization: `Bearer ${address.token}` },
    });
    assert.equal(response.status, 404);
    await instance.stop();
  });

  it("stop is safe before start and twice", async () => {
    const instance = new ApprovalGateway({ onRequest: async () => ({ behavior: "allow" }) });
    await instance.stop();
    await instance.start();
    await instance.stop();
    await instance.stop();
    assert.equal(instance.address, undefined);
  });
});
