import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError, type AgentEventPayload } from "@jeonhui/agentbridge-core";

import { PermissionManager, type ApprovalRequest } from "../PermissionManager.js";

function harness(options: { approvalTimeoutMs?: number } = {}) {
  const events: AgentEventPayload[] = [];
  const audit: ApprovalRequest[] = [];
  const manager = new PermissionManager({
    approvalTimeoutMs: options.approvalTimeoutMs ?? 120_000,
    emit: (payload) => events.push(payload),
    onAudit: (record) => audit.push({ ...record }),
  });
  return { manager, events, audit };
}

const call = {
  toolId: "mcp:filesystem:write_file",
  tool: "write_file",
  callId: "c1",
  sessionId: "s1",
  provider: "claude",
  permissions: ["WRITE"] as const,
  arguments: { path: "/workspace/a.txt" },
};

describe("PermissionManager (spec 25.4 / 25.5)", () => {
  it("allows without asking when the session mode is allow", async () => {
    const { manager, events } = harness();
    const decision = await manager.authorize({ ...call, permissions: ["WRITE"], mode: "allow" });

    assert.equal(decision.effect, "allow");
    assert.deepEqual(events, [], "no approval request is emitted");
  });

  it("denies without asking when the session mode is deny", async () => {
    const { manager } = harness();
    const decision = await manager.authorize({ ...call, permissions: ["WRITE"], mode: "deny" });
    assert.equal(decision.effect, "deny");
  });

  it("emits permission_request under ask and resolves when the host approves", async () => {
    const { manager, events, audit } = harness();
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });

    await Promise.resolve();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "permission_request");
    assert.equal(event.type === "permission_request" ? event.tool : "", "write_file");

    const requestId = event.type === "permission_request" ? event.requestId : "";
    assert.equal(manager.pending("s1").length, 1);

    manager.approve(requestId, { decidedBy: "desktop-app" });
    assert.equal((await pending).effect, "allow");

    assert.equal(manager.pending().length, 0);
    assert.equal(audit.at(-1)?.status, "approved");
    assert.equal(audit.at(-1)?.decidedBy, "desktop-app");
  });

  it("resolves to deny when the host denies", async () => {
    const { manager, events, audit } = harness();
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();

    const event = events[0]!;
    manager.deny(event.type === "permission_request" ? event.requestId : "", { reason: "user said no" });

    const decision = await pending;
    assert.equal(decision.effect, "deny");
    assert.match(decision.reason ?? "", /user said no/);
    assert.equal(audit.at(-1)?.status, "denied");
  });

  it("times out into a denial rather than hanging", async () => {
    const { manager, audit } = harness({ approvalTimeoutMs: 20 });
    const decision = await manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });

    assert.equal(decision.effect, "deny");
    assert.match(decision.reason ?? "", /AB-4003/);
    assert.equal(audit.at(-1)?.status, "expired");
  });

  it("remembering for the session stops asking again in that session only", async () => {
    const { manager, events } = harness();
    const first = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    const event = events[0]!;
    manager.approve(event.type === "permission_request" ? event.requestId : "", { remember: "session" });
    await first;

    const second = await manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    assert.equal(second.effect, "allow");
    assert.equal(events.length, 1, "the host is not asked twice");

    const otherSession = manager.authorize({
      ...call,
      sessionId: "s2",
      permissions: ["WRITE"],
      mode: "ask",
    });
    await Promise.resolve();
    assert.equal(events.length, 2, "a different session is still asked");
    manager.deny(events[1]!.type === "permission_request" ? events[1]!.requestId : "");
    await otherSession;
  });

  it("remembering always applies across sessions", async () => {
    const { manager, events } = harness();
    const first = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    manager.approve(events[0]!.type === "permission_request" ? events[0]!.requestId : "", {
      remember: "always",
    });
    await first;

    const other = await manager.authorize({ ...call, sessionId: "s9", permissions: ["WRITE"], mode: "ask" });
    assert.equal(other.effect, "allow");
  });

  it("remembering once does not create a rule", async () => {
    const { manager, events } = harness();
    const first = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    manager.approve(events[0]!.type === "permission_request" ? events[0]!.requestId : "", { remember: "once" });
    await first;

    assert.deepEqual(manager.listRules(), []);
  });

  it("deciding an unknown request is AB-4002", () => {
    const { manager } = harness();
    assert.throws(
      () => manager.approve("nope"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-4002",
    );
  });

  it("deciding the same request twice is AB-4002", async () => {
    const { manager, events } = harness();
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    const requestId = events[0]!.type === "permission_request" ? events[0]!.requestId : "";

    manager.approve(requestId);
    await pending;
    assert.throws(
      () => manager.approve(requestId),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-4002",
    );
  });

  it("an interrupted turn denies its pending request", async () => {
    const { manager } = harness();
    const controller = new AbortController();
    const pending = manager.authorize({
      ...call,
      permissions: ["WRITE"],
      mode: "ask",
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    const decision = await pending;
    assert.equal(decision.effect, "deny");
    assert.match(decision.reason ?? "", /interrupted/);
  });

  it("stopping a session expires everything it left pending", async () => {
    const { manager, audit } = harness();
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();

    manager.cancelSession("s1");

    assert.equal((await pending).effect, "deny");
    assert.equal(audit.at(-1)?.status, "expired");
    assert.equal(manager.pending().length, 0);
  });
});

describe("PermissionManager remember scoping", () => {
  it("does not create a session rule for a call that has no session", async () => {
    const { manager, events } = harness();
    const pending = manager.authorize({ ...call, sessionId: "", permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();

    const event = events[0]!;
    manager.approve(event.type === "permission_request" ? event.requestId : "", {
      remember: "session",
    });
    await pending;

    assert.deepEqual(manager.listRules(), [], "an empty session id must not become a rule");

    // The host is asked again rather than silently inheriting the earlier answer.
    const second = manager.authorize({ ...call, sessionId: "", permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    assert.equal(events.length, 2);
    manager.deny(events[1]!.type === "permission_request" ? events[1]!.requestId : "");
    assert.equal((await second).effect, "deny");
  });

  it("an explicit policy outranks a remembered answer when it is given higher priority", async () => {
    const { manager, events } = harness();
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    manager.approve(events[0]!.type === "permission_request" ? events[0]!.requestId : "", {
      remember: "session",
    });
    await pending;

    manager.setRule({
      id: "no-writes",
      match: { toolPattern: "mcp:filesystem:write*" },
      effect: "deny",
      priority: 200,
      createdAt: new Date().toISOString(),
    });

    assert.equal((await manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" })).effect, "deny");
  });
});

describe("permission prompt hook (spec 25.4)", () => {
  it("returns no hook when it is disabled, so ask degrades visibly", async () => {
    const { manager } = harness();
    assert.equal(await manager.promptTool("s1"), undefined);
  });

  it("describes an MCP server the agent can be pointed at", async () => {
    const manager = new PermissionManager({ promptHook: { enabled: true } });
    const hook = await manager.promptTool("s1");

    assert.equal(hook?.toolName, "permission_prompt");
    const server = hook?.server as { id: string; transport: string; env: Record<string, string> };
    assert.equal(server.id, "agentbridge_approval");
    assert.equal(server.transport, "stdio");
    assert.match(server.env["AGENTBRIDGE_APPROVAL_URL"] ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.env["AGENTBRIDGE_SESSION_ID"], "s1");
    await manager.close();
  });

  it("reuses one gateway across sessions", async () => {
    const manager = new PermissionManager({ promptHook: { enabled: true } });
    const first = (await manager.promptTool("s1"))?.server as { env: Record<string, string> };
    const second = (await manager.promptTool("s2"))?.server as { env: Record<string, string> };

    assert.equal(first.env["AGENTBRIDGE_APPROVAL_URL"], second.env["AGENTBRIDGE_APPROVAL_URL"]);
    assert.notEqual(first.env["AGENTBRIDGE_SESSION_ID"], second.env["AGENTBRIDGE_SESSION_ID"]);
    await manager.close();
  });
});

describe("autoApprove", () => {
  it("allows everything while enabled and asks nothing", async () => {
    const { manager, events } = harness();
    manager.autoApprove(true);

    assert.equal((await manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" })).effect, "allow");
    assert.deepEqual(events, [], "no approval request is raised");
  });

  it("is visible as a policy rather than a hidden switch", () => {
    const { manager } = harness();
    manager.autoApprove(true);
    assert.deepEqual(manager.listRules().map((r) => r.id), ["auto-approve-all"]);
  });

  it("is lifted the same way it was set", async () => {
    const { manager, events } = harness();
    manager.autoApprove(true);
    manager.autoApprove(false);

    assert.deepEqual(manager.listRules(), []);
    const pending = manager.authorize({ ...call, permissions: ["WRITE"], mode: "ask" });
    await Promise.resolve();
    assert.equal(events.length, 1, "the host is asked again");
    manager.deny(events[0]!.type === "permission_request" ? events[0]!.requestId : "");
    await pending;
  });
});
