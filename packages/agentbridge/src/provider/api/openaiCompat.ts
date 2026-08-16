import type { ProviderDetection, SessionToolExecutor } from "../core/AgentProvider.js";
import {
  ApiProviderBase,
  apiFetch,
  apiFetchSse,
  type ApiMessage,
  type ApiTurnResult,
  type ApiUsage,
} from "./base.js";

export interface OpenAICompatOptions {
  /** Provider id sessions refer to, e.g. "litellm", "openai", "openrouter". */
  id?: string;
  name?: string;
  /** Endpoint root, e.g. "https://api.openai.com/v1" or "http://127.0.0.1:4000/v1". */
  baseUrl: string;
  /** Falls back to OPENAI_API_KEY. Some local endpoints need none. */
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  maxToolRounds?: number;
  requestTimeoutMs?: number;
  /** SSE streaming (`stream: true`). Defaults to true; disable for servers that reject it. */
  streaming?: boolean;
}

/**
 * Speaks the OpenAI chat-completions dialect, which has become the lingua franca of model
 * serving: LiteLLM, OpenRouter, Ollama, vLLM, and OpenAI itself all answer it. One adapter,
 * many backends — pick the backend with `baseUrl`, the model per session or via `defaultModel`.
 */
export class OpenAICompatProvider extends ApiProviderBase {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #headers: Record<string, string>;

  constructor(options: OpenAICompatOptions) {
    super({
      id: options.id ?? "openai-compat",
      name: options.name ?? "OpenAI-compatible API",
      streaming: options.streaming ?? true,
      ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
      ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"];
    this.#headers = options.headers ?? {};
  }

  async detect(): Promise<ProviderDetection> {
    // Configuration is the only local precondition; whether the endpoint is up shows at first use.
    if (!this.#baseUrl) return { available: false, reason: "baseUrl is not configured" };
    return { available: true, version: "api" };
  }

  protected async complete(request: {
    model: string | undefined;
    messages: ApiMessage[];
    tools: ReturnType<SessionToolExecutor["list"]>;
    signal: AbortSignal;
    onDelta?: (chunk: string) => void;
  }): Promise<ApiTurnResult> {
    // Wire names allow [A-Za-z0-9_-] only, and no reversible encoding survives tools whose own
    // names contain the separator — so the mapping is a per-request table, not an encoding.
    const wireNames = new Map<string, string>();   // wire name -> registry id
    const toolDefs = request.tools.map((tool) => {
      const wire = uniqueWireName(tool.id, wireNames);
      return {
        type: "function",
        function: {
          name: wire,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object" },
        },
      };
    });

    const streaming = this.capabilities.streaming && request.onDelta !== undefined;
    const body = {
      model: request.model ?? "default",
      messages: request.messages.map((m) => toWire(m, wireNames)),
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        ...this.#headers,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    };
    const url = `${this.#baseUrl}/chat/completions`;

    if (streaming) {
      const collected = new StreamCollector(request.onDelta!);
      const plainJson = await apiFetchSse(url, init, this.id, (chunk) => collected.take(chunk as WireChunk));
      // A server may answer `stream: true` with a plain JSON body; that is a complete answer,
      // not an error, so it takes the non-streaming route below.
      if (plainJson === undefined) return collected.result(wireNames);
      return parseCompletion(plainJson as WireCompletion, wireNames);
    }

    const json = (await apiFetch(url, init, this.id)) as WireCompletion;
    return parseCompletion(json, wireNames);
  }
}

/** LiteLLM's proxy speaks the OpenAI dialect on port 4000; this just fills in the defaults. */
export class LiteLLMProvider extends OpenAICompatProvider {
  constructor(options: Partial<OpenAICompatOptions> = {}) {
    const apiKey = options.apiKey ?? process.env["LITELLM_API_KEY"];
    super({
      id: options.id ?? "litellm",
      name: options.name ?? "LiteLLM",
      baseUrl: options.baseUrl ?? process.env["LITELLM_BASE_URL"] ?? "http://127.0.0.1:4000/v1",
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
  }
}

interface WireCompletion {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

interface WireChunk {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

function parseCompletion(json: WireCompletion, wireNames: Map<string, string>): ApiTurnResult {
  const message = json.choices?.[0]?.message;
  const calls = (message?.tool_calls ?? []).map((call, index) => {
    const wire = call.function?.name ?? "";
    const toolId = wireNames.get(wire) ?? wire;
    return {
      id: call.id ?? `call_${index}`,
      toolId,
      name: toolId.split(":").pop() ?? toolId,
      arguments: safeParse(call.function?.arguments),
    };
  });

  return {
    ...(message?.content ? { text: message.content } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    ...(wireUsage(json) ? { usage: wireUsage(json)! } : {}),
  };
}

function wireUsage(json: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }): ApiUsage | undefined {
  if (!json.usage) return undefined;
  return {
    ...(json.model ? { model: json.model } : {}),
    ...(json.usage.prompt_tokens !== undefined ? { inputTokens: json.usage.prompt_tokens } : {}),
    ...(json.usage.completion_tokens !== undefined ? { outputTokens: json.usage.completion_tokens } : {}),
  };
}

/** Reassembles one chat-completions answer from its SSE chunks: text deltas as they come, tool
 *  call fragments keyed by index with their argument strings concatenated. */
class StreamCollector {
  readonly #onDelta: (chunk: string) => void;
  #text = "";
  #model: string | undefined;
  #usage: ApiUsage | undefined;
  readonly #calls = new Map<number, { id?: string; name: string; arguments: string }>();

  constructor(onDelta: (chunk: string) => void) {
    this.#onDelta = onDelta;
  }

  take(chunk: WireChunk): void {
    if (chunk.model) this.#model = chunk.model;
    const usage = wireUsage(chunk);
    if (usage) this.#usage = usage;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      this.#text += delta.content;
      this.#onDelta(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const call = this.#calls.get(index) ?? { name: "", arguments: "" };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
      this.#calls.set(index, call);
    }
  }

  result(wireNames: Map<string, string>): ApiTurnResult {
    const calls = [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => {
        const toolId = wireNames.get(call.name) ?? call.name;
        return {
          id: call.id ?? `call_${index}`,
          toolId,
          name: toolId.split(":").pop() ?? toolId,
          arguments: safeParse(call.arguments || undefined),
        };
      });
    const usage = this.#usage ?? (this.#model ? { model: this.#model } : undefined);
    if (usage && this.#model && !usage.model) usage.model = this.#model;

    return {
      ...(this.#text ? { text: this.#text } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

function toWire(message: ApiMessage, wireNames: Map<string, string>): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: wireNameFor(call.toolId, wireNames),
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function uniqueWireName(toolId: string, wireNames: Map<string, string>): string {
  const base = toolId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool";
  let candidate = base;
  for (let n = 2; wireNames.has(candidate) && wireNames.get(candidate) !== toolId; n += 1) {
    candidate = `${base}_${n}`;
  }
  wireNames.set(candidate, toolId);
  return candidate;
}

function wireNameFor(toolId: string, wireNames: Map<string, string>): string {
  for (const [wire, id] of wireNames) if (id === toolId) return wire;
  return uniqueWireName(toolId, wireNames);
}

function safeParse(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
