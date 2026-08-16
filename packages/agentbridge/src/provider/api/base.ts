import { AgentBridgeError } from "../../core/errors/AgentBridgeError.js";
import type { AgentEventPayload } from "../../core/events/types.js";
import type { ApiHistoryStore } from "./history.js";
import type {
  AgentProvider,
  AgentStartOptions,
  ProviderCapabilities,
  ProviderDetection,
  ProviderSessionHandle,
  SendOptions,
  SessionToolExecutor,
} from "../core/AgentProvider.js";

/** One entry in the conversation an API provider maintains itself. */
export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant messages that requested tools, and on the tool results answering them. */
  toolCalls?: ApiToolCall[];
  toolCallId?: string;
  /** On tool results: the registry id of the tool that produced them (wire formats that key
   *  responses by function name, like Gemini, rebuild the name from this). */
  toolId?: string;
}

export interface ApiToolCall {
  id: string;
  toolId: string;
  name: string;
  arguments: unknown;
}

/** What one round trip to the model produced: either tool requests or a final answer. */
export interface ApiTurnResult {
  text?: string;
  toolCalls?: ApiToolCall[];
  /** Reported by APIs that return it; the base class sums rounds into one usage event per turn. */
  usage?: ApiUsage;
}

export interface ApiUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ApiProviderBaseOptions {
  id: string;
  name: string;
  defaultModel?: string;
  /** Rounds of tool execution allowed per turn before the loop is cut. Defaults to 8. */
  maxToolRounds?: number;
  /** Per-request deadline. Defaults to 120000ms. */
  requestTimeoutMs?: number;
  /** Whether this adapter streams deltas. Reflected in capabilities. Defaults to false. */
  streaming?: boolean;
  /**
   * Persists each session's replay history, which is what makes `capabilities.resume` true:
   * with a store, the conversation survives a process restart. Without one, history lives in
   * memory and resume is honestly false.
   */
  history?: ApiHistoryStore;
}

interface ApiSession {
  history: ApiMessage[];
  options: AgentStartOptions;
}

/**
 * Base for providers that talk to a model API instead of driving a CLI (spec 12.5).
 *
 * A CLI agent brings its own loop; an API is just a completion endpoint, so the loop lives here:
 * send the history and the session's tools, and when the model asks for a tool, execute it through
 * the core's tool executor — the same path as agent.tools.call, so permission rules, ask-mode
 * approval, and the audit trail all apply without any CLI-specific machinery. Conversation context
 * is the history this class keeps; `capabilities.resume` reflects whether a history store is
 * configured, because that store is exactly what lets the conversation survive a restart.
 *
 * Subclasses implement exactly one thing: `complete()`, one round trip in their wire format.
 */
export abstract class ApiProviderBase implements AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  readonly defaultModel: string | undefined;
  readonly #maxToolRounds: number;
  readonly #requestTimeoutMs: number;
  readonly #store: ApiHistoryStore | undefined;
  readonly #sessions = new Map<string, ApiSession>();

  constructor(options: ApiProviderBaseOptions) {
    this.id = options.id;
    this.name = options.name;
    this.defaultModel = options.defaultModel;
    this.#maxToolRounds = options.maxToolRounds ?? 8;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#store = options.history;
    this.capabilities = {
      streaming: options.streaming ?? false,
      mcp: true,                      // tools arrive through the executor rather than injection
      resume: this.#store !== undefined,   // a history store is exactly what resume requires
      interrupt: true,
      workingDirectory: false,
      permissionHook: true,           // ask works natively: every tool call runs through the core
    };
  }

  /** Subclasses check whatever credentials their API needs. Must not throw. */
  abstract detect(): Promise<ProviderDetection>;

  /**
   * One request/response against the API. `signal` must abort the HTTP call.
   * Throwing AgentBridgeError("AB-1006", ...) reports an upstream failure.
   */
  protected abstract complete(request: {
    model: string | undefined;
    messages: ApiMessage[];
    tools: ReturnType<SessionToolExecutor["list"]>;
    signal: AbortSignal;
    /** Streaming adapters call this per text chunk; the base emits delta message events. */
    onDelta?: (chunk: string) => void;
  }): Promise<ApiTurnResult>;

  async start(options: AgentStartOptions): Promise<ProviderSessionHandle> {
    const detection = await this.detect();
    if (!detection.available) {
      throw new AgentBridgeError("AB-1002", {
        message: detection.reason ?? `${this.id} is not configured`,
        details: { providerId: this.id },
      });
    }

    // A stored history wins over a fresh one: it already carries the system prompt and every
    // turn that came before the restart. The key doubles as the resume token, which is why the
    // handle names it as nativeSessionId below.
    const stored = this.#store
      ? await this.#store.load(options.resumeToken ?? options.sessionId).catch(() => undefined)
      : undefined;

    const history: ApiMessage[] = stored ?? [];
    if (!stored && options.systemPrompt) {
      history.push({ role: "system", content: options.systemPrompt });
    }

    this.#sessions.set(options.sessionId, { history, options });
    return {
      sessionId: options.sessionId,
      providerId: this.id,
      ...(this.#store ? { nativeSessionId: options.sessionId } : {}),
    };
  }

  async send(
    handle: ProviderSessionHandle,
    message: string,
    { emit, signal }: SendOptions,
  ): Promise<void> {
    const session = this.#sessions.get(handle.sessionId);
    if (!session) {
      throw new AgentBridgeError("AB-3004", { details: { sessionId: handle.sessionId } });
    }

    const executor = session.options.toolExecutor;
    const tools = executor?.list() ?? [];
    const model = session.options.model ?? this.defaultModel;

    // The turn mutates a working copy first: a failed turn must not corrupt the history the
    // next turn replays.
    const working = [...session.history, { role: "user", content: message } as ApiMessage];

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => controller.abort(), this.#requestTimeoutMs * (this.#maxToolRounds + 1));
    deadline.unref?.();

    // Deltas stream as they arrive; the final full message still closes the turn, so a consumer
    // that only understands whole messages stays correct (delta events append, a full one replaces).
    const onDelta = (chunk: string): void => {
      if (chunk === "" || signal?.aborted) return;
      emit({ type: "message", role: "assistant", content: chunk, delta: true, done: false });
    };
    const usageTotal = { inputTokens: 0, outputTokens: 0, sawAny: false, model: undefined as string | undefined };
    const takeUsage = (usage: ApiUsage | undefined): void => {
      if (!usage) return;
      usageTotal.sawAny = true;
      usageTotal.inputTokens += usage.inputTokens ?? 0;
      usageTotal.outputTokens += usage.outputTokens ?? 0;
      if (usage.model) usageTotal.model = usage.model;
    };

    try {
      for (let round = 0; ; round += 1) {
        const result = await this.complete({
          model,
          messages: working,
          tools,
          signal: controller.signal,
          ...(this.capabilities.streaming ? { onDelta } : {}),
        });

        if (signal?.aborted) return;
        takeUsage(result.usage);

        const calls = result.toolCalls ?? [];
        if (calls.length === 0) {
          const text = result.text ?? "";
          emit({ type: "message", role: "assistant", content: text, delta: false, done: true });
          if (usageTotal.sawAny) {
            const reportedModel = usageTotal.model ?? model;
            emit({
              type: "usage",
              ...(reportedModel ? { model: reportedModel } : {}),
              inputTokens: usageTotal.inputTokens,
              outputTokens: usageTotal.outputTokens,
              totalTokens: usageTotal.inputTokens + usageTotal.outputTokens,
            });
          }
          working.push({ role: "assistant", content: text });
          break;
        }

        if (round >= this.#maxToolRounds) {
          throw new AgentBridgeError("AB-1006", {
            message: `the model requested tools for ${round} consecutive rounds; giving up`,
            details: { providerId: this.id, maxToolRounds: this.#maxToolRounds },
          });
        }

        working.push({ role: "assistant", content: result.text ?? "", toolCalls: calls });

        for (const call of calls) {
          emit({
            type: "tool_call",
            callId: call.id,
            tool: call.name,
            toolId: call.toolId,
            arguments: call.arguments,
            source: { type: call.toolId.startsWith("agent:") ? "agent" : "mcp" },
          });

          const started = Date.now();
          // No executor, unknown tool, or a permission denial all become a result the model
          // reads — the loop continues and the model decides what to do about the refusal.
          // A hallucinated tool id makes the core's lookup throw, hence the catch.
          const outcome = executor
            ? await executor.call(call.toolId, call.arguments).catch((error: unknown) => ({
                ok: false as const,
                error:
                  error instanceof AgentBridgeError
                    ? error.toJSON()
                    : { code: "AB-2202", message: String(error), retryable: false },
              }))
            : { ok: false as const, error: { code: "AB-2201", message: "no tools are available in this session", retryable: false } };

          if (outcome.ok) {
            emit({
              type: "tool_result", callId: call.id, tool: call.name, ok: true,
              content: outcome.content, durationMs: Date.now() - started,
            });
          } else {
            emit({
              type: "tool_error", callId: call.id, tool: call.name, ok: false,
              error: outcome.error ?? { code: "AB-2202", message: "tool failed", retryable: true },
              durationMs: Date.now() - started,
            });
          }

          working.push({
            role: "tool",
            toolCallId: call.id,
            toolId: call.toolId,
            content: JSON.stringify(outcome.ok ? (outcome.content ?? null) : { error: outcome.error }),
          });
        }
      }

      session.history = working;
      if (this.#store) {
        // A persistence failure must not kill a live session (spec 28.3); the turn already
        // succeeded, only its durability is degraded.
        await this.#store.save(handle.sessionId, working).catch(() => undefined);
      }
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async interrupt(handle: ProviderSessionHandle): Promise<void> {
    // The abort travels through SendOptions.signal; nothing provider-side is left to stop.
    if (!this.#sessions.has(handle.sessionId)) {
      throw new AgentBridgeError("AB-3006", { details: { sessionId: handle.sessionId } });
    }
  }

  async stop(handle: ProviderSessionHandle): Promise<void> {
    this.#sessions.delete(handle.sessionId);
  }

  /** For tests and diagnostics: the conversation as this provider will replay it. */
  historyOf(sessionId: string): ApiMessage[] {
    return [...(this.#sessions.get(sessionId)?.history ?? [])];
  }
}

/** Shared helper: fetch that turns HTTP failures into provider errors with the body preserved. */
export async function apiFetch(
  url: string,
  init: RequestInit,
  providerId: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new AgentBridgeError("AB-1006", {
      message: `${providerId} request failed: ${String(error)}`,
      details: { providerId, url },
      cause: error,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AgentBridgeError("AB-1006", {
      message: `${providerId} returned ${response.status}: ${text.slice(0, 300)}`,
      details: { providerId, status: response.status },
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AgentBridgeError("AB-1004", {
      message: `${providerId} returned non-JSON output`,
      details: { providerId, body: text.slice(0, 200) },
    });
  }
}

/**
 * Shared helper: collision-safe wire names. APIs restrict tool names (OpenAI to [A-Za-z0-9_-],
 * Anthropic likewise), and no reversible encoding survives tool names that contain the
 * separator - so the mapping is a per-request table.
 */
export function uniqueWireName(
  toolId: string,
  wireNames: Map<string, string>,
  allowed: RegExp = /[^A-Za-z0-9_-]/g,
): string {
  const base = toolId.replace(allowed, "_").slice(0, 60) || "tool";
  let candidate = base;
  for (let n = 2; wireNames.has(candidate) && wireNames.get(candidate) !== toolId; n += 1) {
    candidate = `${base}_${n}`;
  }
  wireNames.set(candidate, toolId);
  return candidate;
}

export function wireNameFor(
  toolId: string,
  wireNames: Map<string, string>,
  allowed?: RegExp,
): string {
  for (const [wire, id] of wireNames) if (id === toolId) return wire;
  return uniqueWireName(toolId, wireNames, allowed);
}

/**
 * Shared helper: server-sent events. Calls `onData` once per `data:` JSON line ([DONE] excluded).
 * If the server answers with plain JSON instead - some endpoints ignore `stream: true` - the
 * parsed body is returned so the caller can fall back to its non-streaming path.
 */
export async function apiFetchSse(
  url: string,
  init: RequestInit,
  providerId: string,
  onData: (data: unknown) => void,
): Promise<unknown | undefined> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new AgentBridgeError("AB-1006", {
      message: `${providerId} request failed: ${String(error)}`,
      details: { providerId, url },
      cause: error,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    throw new AgentBridgeError("AB-1006", {
      message: `${providerId} returned ${response.status}: ${text.slice(0, 300)}`,
      details: { providerId, status: response.status },
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentBridgeError("AB-1004", {
        message: `${providerId} returned neither an event stream nor JSON`,
        details: { providerId, body: text.slice(0, 200) },
      });
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new AgentBridgeError("AB-1004", {
      message: `${providerId} returned an event stream with no body`,
      details: { providerId },
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        onData(JSON.parse(data));
      } catch {
        throw new AgentBridgeError("AB-1004", {
          message: `${providerId} sent a malformed stream chunk`,
          details: { providerId, chunk: data.slice(0, 200) },
        });
      }
    }
  }
  return undefined;
}
