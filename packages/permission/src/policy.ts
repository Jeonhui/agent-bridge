import { AgentBridgeError } from "@agentbridge/core";

export type Permission = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "SYSTEM";
export type PermissionMode = "ask" | "allow" | "deny";
export type Effect = "allow" | "deny" | "ask";

export interface PermissionRule {
  id: string;
  match: {
    toolId?: string;
    /** Glob over the tool id, e.g. `mcp:filesystem:*`. */
    toolPattern?: string;
    permission?: Permission;
    sessionId?: string;
    provider?: string;
    /** Glob over path-like arguments, e.g. `/workspace/**`. */
    pathScope?: string;
  };
  effect: Effect;
  /** Higher wins. Ties break toward the more specific rule. */
  priority: number;
  expiresAt?: string;
  createdAt: string;
}

export interface EvaluationContext {
  toolId: string;
  permissions: Permission[];
  sessionId: string;
  provider: string;
  arguments?: unknown;
  /** Session permission mode, applied when no rule matches. */
  mode: PermissionMode;
}

export interface PermissionDecision {
  effect: "allow" | "deny" | "ask";
  matchedRuleId?: string;
  reason?: string;
}

/**
 * Translates a glob into a regular expression.
 * `**` crosses separators, `*` does not, so `/workspace/**` covers nested paths while
 * `mcp:filesystem:*` stays within one id segment.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/:]*";
      }
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Pulls path-like values out of tool arguments so `pathScope` can be checked. */
export function extractPaths(args: unknown, depth = 0): string[] {
  if (depth > 4 || args === null || typeof args !== "object") return [];

  const paths: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string" && /path|file|dir|directory|target/i.test(key)) {
      paths.push(value);
    } else if (typeof value === "object") {
      paths.push(...extractPaths(value, depth + 1));
    }
  }
  return paths;
}

function specificity(rule: PermissionRule): number {
  const { match } = rule;
  return (
    (match.toolId ? 8 : 0) +
    (match.pathScope ? 4 : 0) +
    (match.toolPattern ? 2 : 0) +
    (match.sessionId ? 1 : 0) +
    (match.provider ? 1 : 0) +
    (match.permission ? 1 : 0)
  );
}

export function ruleMatches(rule: PermissionRule, context: EvaluationContext, now = Date.now()): boolean {
  if (rule.expiresAt && Date.parse(rule.expiresAt) <= now) return false;

  const { match } = rule;
  if (match.toolId && match.toolId !== context.toolId) return false;
  if (match.toolPattern && !globToRegExp(match.toolPattern).test(context.toolId)) return false;
  if (match.sessionId && match.sessionId !== context.sessionId) return false;
  if (match.provider && match.provider !== context.provider) return false;
  if (match.permission && !context.permissions.includes(match.permission)) return false;

  if (match.pathScope) {
    const paths = extractPaths(context.arguments);
    // A path-scoped rule only applies to calls that actually name a path inside the scope.
    if (paths.length === 0) return false;
    const scope = globToRegExp(match.pathScope);
    if (!paths.every((path) => scope.test(path))) return false;
  }

  return true;
}

/** First matching rule by priority wins; otherwise the session mode applies (spec 25.3). */
export function evaluate(
  rules: PermissionRule[],
  context: EvaluationContext,
  now = Date.now(),
): PermissionDecision {
  const matching = rules
    .filter((rule) => ruleMatches(rule, context, now))
    .sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a));

  const rule = matching[0];
  if (rule) {
    return { effect: rule.effect, matchedRuleId: rule.id, reason: "matched a permission rule" };
  }

  return { effect: context.mode, reason: "no rule matched; session permission mode applied" };
}

export function validateRule(rule: PermissionRule): void {
  if (!rule.id) {
    throw new AgentBridgeError("AB-4004", { message: "a permission rule needs an id" });
  }
  if (!["allow", "deny", "ask"].includes(rule.effect)) {
    throw new AgentBridgeError("AB-4004", {
      message: `unknown effect: ${rule.effect}`,
      details: { ruleId: rule.id },
    });
  }
  if (Object.keys(rule.match).length === 0) {
    throw new AgentBridgeError("AB-4004", {
      message: "a rule with no match conditions would apply to everything",
      details: { ruleId: rule.id },
    });
  }
  for (const pattern of [rule.match.toolPattern, rule.match.pathScope]) {
    if (pattern === undefined) continue;
    try {
      globToRegExp(pattern);
    } catch {
      throw new AgentBridgeError("AB-4004", {
        message: `invalid glob: ${pattern}`,
        details: { ruleId: rule.id },
      });
    }
  }
}
