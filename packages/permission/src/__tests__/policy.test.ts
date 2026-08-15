import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "@agentbridge/core";

import {
  evaluate,
  extractPaths,
  globToRegExp,
  validateRule,
  type EvaluationContext,
  type PermissionRule,
} from "../policy.js";

function rule(partial: Partial<PermissionRule> & Pick<PermissionRule, "id" | "match" | "effect">): PermissionRule {
  return { priority: 0, createdAt: new Date(0).toISOString(), ...partial };
}

const context: EvaluationContext = {
  toolId: "mcp:filesystem:write_file",
  permissions: ["WRITE"],
  sessionId: "s1",
  provider: "claude",
  mode: "ask",
  arguments: { path: "/workspace/project/README.md" },
};

describe("globToRegExp (spec 25.3)", () => {
  it("keeps a single star inside one segment", () => {
    assert.equal(globToRegExp("mcp:filesystem:*").test("mcp:filesystem:read"), true);
    assert.equal(globToRegExp("mcp:filesystem:*").test("mcp:github:read"), false);
    assert.equal(globToRegExp("/workspace/*").test("/workspace/nested/file"), false);
  });

  it("lets a double star cross separators", () => {
    assert.equal(globToRegExp("/workspace/**").test("/workspace/a/b/c.txt"), true);
  });

  it("escapes regex metacharacters in the literal parts", () => {
    assert.equal(globToRegExp("a.b").test("a.b"), true);
    assert.equal(globToRegExp("a.b").test("axb"), false);
  });
});

describe("extractPaths", () => {
  it("pulls path-like values out of arguments", () => {
    assert.deepEqual(extractPaths({ path: "/a", content: "not a path" }), ["/a"]);
    assert.deepEqual(extractPaths({ target_file: "/b" }), ["/b"]);
    assert.deepEqual(extractPaths({ nested: { directory: "/c" } }), ["/c"]);
  });

  it("returns nothing when no argument looks like a path", () => {
    assert.deepEqual(extractPaths({ query: "hello" }), []);
    assert.deepEqual(extractPaths(null), []);
  });
});

describe("evaluate (spec 25.3)", () => {
  it("falls back to the session mode when nothing matches", () => {
    const decision = evaluate([], context);
    assert.equal(decision.effect, "ask");
    assert.equal(decision.matchedRuleId, undefined);
  });

  it("uses the highest priority matching rule", () => {
    const decision = evaluate(
      [
        rule({ id: "low", match: { toolPattern: "mcp:*:*" }, effect: "deny", priority: 1 }),
        rule({ id: "high", match: { toolPattern: "mcp:filesystem:*" }, effect: "allow", priority: 10 }),
      ],
      context,
    );
    assert.deepEqual([decision.effect, decision.matchedRuleId], ["allow", "high"]);
  });

  it("breaks a priority tie toward the more specific rule", () => {
    const decision = evaluate(
      [
        rule({ id: "broad", match: { toolPattern: "mcp:filesystem:*" }, effect: "deny" }),
        rule({ id: "exact", match: { toolId: "mcp:filesystem:write_file" }, effect: "allow" }),
      ],
      context,
    );
    assert.equal(decision.matchedRuleId, "exact");
  });

  it("only applies a path-scoped rule inside its scope", () => {
    const scoped = rule({
      id: "workspace-only",
      match: { toolPattern: "mcp:filesystem:*", pathScope: "/workspace/**" },
      effect: "allow",
      priority: 5,
    });

    assert.equal(evaluate([scoped], context).effect, "allow");
    assert.equal(
      evaluate([scoped], { ...context, arguments: { path: "/etc/passwd" } }).effect,
      "ask",
      "outside the scope the rule must not match",
    );
  });

  it("does not apply a path-scoped rule when the call names no path", () => {
    const scoped = rule({
      id: "workspace-only",
      match: { toolPattern: "mcp:*:*", pathScope: "/workspace/**" },
      effect: "allow",
    });
    assert.equal(evaluate([scoped], { ...context, arguments: { query: "x" } }).effect, "ask");
  });

  it("matches on permission, session, and provider", () => {
    assert.equal(evaluate([rule({ id: "r", match: { permission: "WRITE" }, effect: "deny" })], context).effect, "deny");
    assert.equal(evaluate([rule({ id: "r", match: { permission: "READ" }, effect: "deny" })], context).effect, "ask");
    assert.equal(evaluate([rule({ id: "r", match: { sessionId: "other" }, effect: "deny" })], context).effect, "ask");
    assert.equal(evaluate([rule({ id: "r", match: { provider: "claude" }, effect: "deny" })], context).effect, "deny");
  });

  it("ignores an expired rule", () => {
    const expired = rule({
      id: "temp",
      match: { toolId: context.toolId },
      effect: "allow",
      expiresAt: new Date(1000).toISOString(),
    });
    assert.equal(evaluate([expired], context, 2000).effect, "ask");
    assert.equal(evaluate([expired], context, 500).effect, "allow");
  });
});

describe("validateRule (spec 25.3)", () => {
  it("rejects a rule with no match conditions", () => {
    assert.throws(
      () => validateRule(rule({ id: "everything", match: {}, effect: "allow" })),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-4004",
    );
  });

  it("rejects an unknown effect", () => {
    assert.throws(
      () => validateRule(rule({ id: "bad", match: { toolId: "x" }, effect: "maybe" as never })),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-4004",
    );
  });

  it("accepts a well-formed rule", () => {
    assert.doesNotThrow(() => validateRule(rule({ id: "ok", match: { toolPattern: "mcp:*:*" }, effect: "ask" })));
  });
});
