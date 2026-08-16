import type { ProviderDetection, SessionToolExecutor } from "../core/AgentProvider.js";
import {
  ApiProviderBase,
  apiFetch,
  apiFetchSse,
  uniqueWireName,
  wireNameFor,
  type ApiMessage,
  type ApiTurnResult,
  type ApiUsage,
} from "./base.js";
import type { ApiHistoryStore } from "./history.js";

export interface AnthropicOptions {
  /** Falls back to ANTHROPIC_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  /** The Messages API requires max_tokens on every request. Defaults to 4096. */
  maxTokens?: number;
  maxToolRounds?: number;
  requestTimeoutMs?: number;
  /** SSE streaming. Defaults to true. */
  streaming?: boolean;
  /** History persistence; setting it turns `capabilities.resume` on. See FileHistoryStore. */
  history?: ApiHistoryStore;
  /** Retry policy for 429/5xx/network failures. Defaults: 2 retries, 500ms base, 10s cap. */
  retry?: import("./base.js").RetryPolicy;
}

interface WireBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface WireResponse {
  model?: string;
  content?: WireBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Claude over the Anthropic Messages API - the same models the Claude Code CLI drives, without
 * needing the CLI installed. Tool results travel back as `tool_result` blocks in a user turn,
 * and consecutive user-side entries merge into one message because the API requires alternating
 * roles.
 */
export class AnthropicProvider extends ApiProviderBase {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #maxTokens: number;

  constructor(options: AnthropicOptions = {}) {
    super({
      id: "anthropic",
      name: "Anthropic API",
      defaultModel: options.defaultModel ?? "claude-sonnet-4-5",
      streaming: options.streaming ?? true,
      ...(options.history ? { history: options.history } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    this.#apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.#maxTokens = options.maxTokens ?? 4096;
  }

  async detect(): Promise<ProviderDetection> {
    if (!this.#apiKey) {
      return { available: false, reason: "ANTHROPIC_API_KEY is not set (option apiKey or the environment)" };
    }
    return { available: true, version: "api" };
  }

  protected async complete(request: {
    model: string | undefined;
    messages: ApiMessage[];
    tools: ReturnType<SessionToolExecutor["list"]>;
    signal: AbortSignal;
    onDelta?: (chunk: string) => void;
  }): Promise<ApiTurnResult> {
    const wireNames = new Map<string, string>();
    const toolDefs = request.tools.map((tool) => ({
      name: uniqueWireName(tool.id, wireNames),
      description: tool.description,
      input_schema: tool.inputSchema ?? { type: "object" },
    }));

    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const streaming = this.capabilities.streaming && request.onDelta !== undefined;
    const body = {
      model: request.model ?? this.defaultModel ?? "claude-sonnet-4-5",
      max_tokens: this.#maxTokens,
      ...(system ? { system } : {}),
      messages: toWireMessages(request.messages, wireNames),
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      ...(streaming ? { stream: true } : {}),
    };
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    };
    const url = `${this.#baseUrl}/messages`;

    if (streaming) {
      const collected = new MessageCollector(request.onDelta!);
      const plainJson = await apiFetchSse(url, init, this.id, (event) => collected.take(event as never), this.retry);
      if (plainJson === undefined) return collected.result(wireNames);
      return parseResponse(plainJson as WireResponse, wireNames);
    }

    const json = (await apiFetch(url, init, this.id, this.retry)) as WireResponse;
    return parseResponse(json, wireNames);
  }
}

function parseResponse(json: WireResponse, wireNames: Map<string, string>): ApiTurnResult {
  const blocks = json.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, index) => {
      const toolId = wireNames.get(b.name ?? "") ?? b.name ?? "";
      return {
        id: b.id ?? `toolu_${index}`,
        toolId,
        name: toolId.split(":").pop() ?? toolId,
        arguments: b.input ?? {},
      };
    });

  const usage: ApiUsage | undefined = json.usage
    ? {
        ...(json.model ? { model: json.model } : {}),
        ...(json.usage.input_tokens !== undefined ? { inputTokens: json.usage.input_tokens } : {}),
        ...(json.usage.output_tokens !== undefined ? { outputTokens: json.usage.output_tokens } : {}),
      }
    : undefined;

  return {
    ...(text ? { text } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Maps the provider-neutral history onto Messages API turns, merging consecutive user-side
 *  entries (tool results, then possibly a user message) because roles must alternate. */
function toWireMessages(messages: ApiMessage[], wireNames: Map<string, string>): unknown[] {
  const wire: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  const push = (role: "user" | "assistant", content: unknown[]): void => {
    const last = wire.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else wire.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === "system") continue;   // carried in the top-level `system` field
    if (message.role === "user") {
      const content: unknown[] = [];
      for (const attachment of message.attachments ?? []) {
        content.push({
          type: attachment.type === "image" ? "image" : "document",
          source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
        });
      }
      content.push({ type: "text", text: message.content });
      push("user", content);
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: wireNameFor(call.toolId, wireNames),
          input: call.arguments ?? {},
        });
      }
      push("assistant", content);
    } else {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    }
  }

  return wire;
}

/** Reassembles one streamed message from Messages API events: text deltas stream out, tool_use
 *  blocks accumulate their input from partial_json fragments, usage arrives at both ends. */
class MessageCollector {
  readonly #onDelta: (chunk: string) => void;
  #text = "";
  #model: string | undefined;
  #inputTokens = 0;
  #outputTokens = 0;
  #sawUsage = false;
  readonly #blocks = new Map<number, { id?: string; name: string; json: string }>();

  constructor(onDelta: (chunk: string) => void) {
    this.#onDelta = onDelta;
  }

  take(event: {
    type?: string;
    index?: number;
    message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    content_block?: WireBlock;
    delta?: { type?: string; text?: string; partial_json?: string };
    usage?: { output_tokens?: number };
  }): void {
    switch (event.type) {
      case "message_start": {
        if (event.message?.model) this.#model = event.message.model;
        if (event.message?.usage?.input_tokens !== undefined) {
          this.#inputTokens = event.message.usage.input_tokens;
          this.#sawUsage = true;
        }
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          this.#blocks.set(event.index ?? 0, { name: block.name ?? "", json: "", ...(block.id ? { id: block.id } : {}) });
        }
        return;
      }
      case "content_block_delta": {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          this.#text += event.delta.text;
          this.#onDelta(event.delta.text);
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
          const block = this.#blocks.get(event.index ?? 0);
          if (block) block.json += event.delta.partial_json;
        }
        return;
      }
      case "message_delta": {
        if (event.usage?.output_tokens !== undefined) {
          this.#outputTokens = event.usage.output_tokens;
          this.#sawUsage = true;
        }
        return;
      }
      default:
        return;
    }
  }

  result(wireNames: Map<string, string>): ApiTurnResult {
    const calls = [...this.#blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, block]) => {
        const toolId = wireNames.get(block.name) ?? block.name;
        let args: unknown = {};
        if (block.json) {
          try {
            args = JSON.parse(block.json);
          } catch {
            args = { _raw: block.json };
          }
        }
        return {
          id: block.id ?? `toolu_${index}`,
          toolId,
          name: toolId.split(":").pop() ?? toolId,
          arguments: args,
        };
      });

    const usage: ApiUsage | undefined = this.#sawUsage
      ? {
          ...(this.#model ? { model: this.#model } : {}),
          inputTokens: this.#inputTokens,
          outputTokens: this.#outputTokens,
        }
      : undefined;

    return {
      ...(this.#text ? { text: this.#text } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
