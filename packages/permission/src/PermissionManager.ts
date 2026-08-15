import { randomUUID } from "node:crypto";

import { AgentBridgeError, type AgentEventPayload } from "@agentbridge/core";

import {
  evaluate,
  validateRule,
  type EvaluationContext,
  type Permission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
} from "./policy.js";

export type RememberScope = "once" | "session" | "always";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId?: string;
  callId: string;
  toolId: string;
  tool: string;
  arguments: unknown;
  permissions: Permission[];
  requestedAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

/** Minimal persistence surface, mirroring the storage repositories without depending on them. */
export interface PermissionStore {
  rules: {
    list(): Promise<PermissionRule[]>;
    put(value: PermissionRule): Promise<void>;
    delete(id: string): Promise<void>;
  };
  appendApproval(record: ApprovalRequest & { id: string; sessionId: string }): Promise<void>;
}

export interface PermissionLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface PermissionManagerOptions {
  /** How long a request waits before it is treated as denied. Defaults to 120000ms (spec 33 D2). */
  approvalTimeoutMs?: number;
  /** Receives permission_request events. The core stamps the envelope. */
  emit?: (payload: AgentEventPayload) => void;
  /** Called for every decision so the host can persist an audit trail (spec 25.5). */
  onAudit?: (request: ApprovalRequest) => void;
  rules?: PermissionRule[];
  /** Persists rules and the approval audit trail (spec 20.5). */
  storage?: PermissionStore;
  logger?: PermissionLogger;
}

export interface AuthorizeInput {
  toolId: string;
  tool: string;
  callId: string;
  sessionId: string;
  provider: string;
  permissions: Permission[];
  mode: PermissionMode;
  arguments?: unknown;
  turnId?: string;
  signal?: AbortSignal;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Decides whether a tool call may run (spec 25).
 *
 * Deny-by-default: an unanswered request becomes a denial once it times out, and any decision
 * path that is not an explicit allow ends as a denial.
 */
export class PermissionManager {
  readonly #rules = new Map<string, PermissionRule>();
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  readonly #emit: ((payload: AgentEventPayload) => void) | undefined;
  readonly #onAudit: ((request: ApprovalRequest) => void) | undefined;
  readonly #storage: PermissionStore | undefined;
  readonly #logger: PermissionLogger | undefined;

  constructor(options: PermissionManagerOptions = {}) {
    this.#timeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.#emit = options.emit;
    this.#onAudit = options.onAudit;
    this.#storage = options.storage;
    this.#logger = options.logger;
    for (const rule of options.rules ?? []) this.setRule(rule);
  }

  /** Reloads rules written by a previous process, skipping any that no longer validate. */
  async restore(): Promise<PermissionRule[]> {
    if (!this.#storage) return [];

    const restored: PermissionRule[] = [];
    for (const rule of await this.#storage.rules.list()) {
      try {
        validateRule(rule);
        this.#rules.set(rule.id, rule);
        restored.push(rule);
      } catch (error) {
        // A rule that no longer parses must not block startup, but it must be visible.
        this.#logger?.error("permission.rule_invalid", { ruleId: rule.id, reason: String(error) });
      }
    }

    if (restored.length > 0) this.#logger?.info("permission.rules_restored", { count: restored.length });
    return restored;
  }

  setRule(rule: PermissionRule): void {
    validateRule(rule);
    this.#rules.set(rule.id, rule);
    void this.#storage?.rules.put(rule).catch((error: unknown) => {
      this.#logger?.error("permission.persist_failed", { ruleId: rule.id, reason: String(error) });
    });
  }

  removeRule(ruleId: string): void {
    this.#rules.delete(ruleId);
    void this.#storage?.rules.delete(ruleId).catch(() => undefined);
  }

  listRules(): PermissionRule[] {
    return [...this.#rules.values()];
  }

  /** Evaluates policy without creating an approval request. */
  evaluate(context: EvaluationContext): PermissionDecision {
    return evaluate(this.listRules(), context);
  }

  /**
   * Resolves to a decision, creating and awaiting an approval request when policy says `ask`.
   * Never throws for a denial; the caller turns the decision into AB-4001.
   */
  async authorize(input: AuthorizeInput): Promise<PermissionDecision> {
    const decision = this.evaluate({
      toolId: input.toolId,
      permissions: input.permissions,
      sessionId: input.sessionId,
      provider: input.provider,
      mode: input.mode,
      ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
    });

    if (decision.effect !== "ask") return decision;
    return this.#requestApproval(input);
  }

  approve(requestId: string, options: { remember?: RememberScope; decidedBy?: string } = {}): void {
    const pending = this.#settle(requestId, "approved", options.decidedBy);

    if (options.remember && options.remember !== "once") {
      this.#remember(pending.request, "allow", options.remember);
    }

    pending.resolve({ effect: "allow", reason: "approved by the host application" });
  }

  deny(requestId: string, options: { reason?: string; decidedBy?: string } = {}): void {
    const pending = this.#settle(requestId, "denied", options.decidedBy, options.reason);
    pending.resolve({ effect: "deny", reason: options.reason ?? "denied by the host application" });
  }

  pending(sessionId?: string): ApprovalRequest[] {
    return [...this.#pending.values()]
      .map((entry) => entry.request)
      .filter((request) => (sessionId ? request.sessionId === sessionId : true));
  }

  /** Expires everything still waiting, e.g. when a session stops (spec 25.6). */
  cancelSession(sessionId: string, reason = "the session ended"): void {
    for (const [id, entry] of this.#pending) {
      if (entry.request.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.#pending.delete(id);
      entry.request.status = "expired";
      entry.request.reason = reason;
      entry.request.decidedAt = new Date().toISOString();
      this.#onAudit?.(entry.request);
      entry.resolve({ effect: "deny", reason });
    }
  }

  async #requestApproval(input: AuthorizeInput): Promise<PermissionDecision> {
    const now = Date.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      callId: input.callId,
      toolId: input.toolId,
      tool: input.tool,
      arguments: input.arguments ?? {},
      permissions: input.permissions,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#timeoutMs).toISOString(),
      status: "pending",
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };

    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        request.status = "expired";
        request.decidedAt = new Date().toISOString();
        request.reason = "the approval request timed out";
        this.#onAudit?.(request);
        resolve({ effect: "deny", reason: "AB-4003: the approval request timed out" });
      }, this.#timeoutMs);
      timer.unref?.();

      this.#pending.set(request.id, { request, resolve, timer });

      input.signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.has(request.id)) return;
          this.deny(request.id, { reason: "the turn was interrupted" });
        },
        { once: true },
      );

      this.#logger?.info("permission.requested", {
        requestId: request.id,
        toolId: request.toolId,
        permissions: request.permissions,
      });

      this.#emit?.({
        type: "permission_request",
        requestId: request.id,
        tool: request.tool,
        toolId: request.toolId,
        arguments: request.arguments,
        permissions: request.permissions,
        expiresAt: request.expiresAt,
      });
    });
  }

  #settle(
    requestId: string,
    status: "approved" | "denied",
    decidedBy?: string,
    reason?: string,
  ): Pending {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      throw new AgentBridgeError("AB-4002", { details: { requestId } });
    }

    clearTimeout(pending.timer);
    this.#pending.delete(requestId);

    pending.request.status = status;
    pending.request.decidedAt = new Date().toISOString();
    if (decidedBy !== undefined) pending.request.decidedBy = decidedBy;
    if (reason !== undefined) pending.request.reason = reason;

    this.#onAudit?.(pending.request);
    this.#logger?.info("permission.decided", {
      requestId,
      toolId: pending.request.toolId,
      decision: status,
    });
    void this.#storage?.appendApproval(pending.request).catch((error: unknown) => {
      this.#logger?.error("permission.audit_failed", { requestId, reason: String(error) });
    });

    return pending;
  }

  /**
   * Promotes a decision into a rule so the host is not asked again (spec 25.5).
   *
   * A "session" scope needs a session to scope to. A call made outside one - a host invoking a
   * tool directly - would otherwise produce a rule keyed on an empty session id, which quietly
   * matches every other sessionless call. Such a decision stays a one-off.
   */
  #remember(request: ApprovalRequest, effect: "allow" | "deny", scope: Exclude<RememberScope, "once">): void {
    if (scope === "session" && !request.sessionId) return;

    this.setRule({
      id: `remembered:${scope}:${request.toolId}:${request.sessionId}`,
      match: {
        toolId: request.toolId,
        ...(scope === "session" ? { sessionId: request.sessionId } : {}),
      },
      effect,
      priority: scope === "session" ? 100 : 50,
      createdAt: new Date().toISOString(),
    });
  }
}
