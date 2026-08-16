import { randomUUID } from "node:crypto";

import type { ProviderDetection, SessionToolExecutor } from "../core/AgentProvider.js";
import {
  ApiProviderBase,
  apiFetch,
  uniqueWireName,
  wireNameFor,
  type ApiMessage,
  type ApiTurnResult,
} from "./base.js";


export interface GeminiApiOptions {
  /** Falls back to GEMINI_API_KEY, the same variable the retired CLI documented. */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxToolRounds?: number;
  requestTimeoutMs?: number;
  /** History persistence; setting it turns `capabilities.resume` on. See FileHistoryStore. */
  history?: import("./history.js").ApiHistoryStore;
  /** Retry policy for 429/5xx/network failures. Defaults: 2 retries, 500ms base, 10s cap. */
  retry?: import("./base.js").RetryPolicy;
}

/**
 * Gemini over its REST API.
 *
 * This is how the Gemini family returns after Google retired the CLI's individual sign-in:
 * Antigravity ships a GUI with no headless entry point, but the API never went away and takes the
 * same GEMINI_API_KEY. Tool naming here is friendlier than OpenAI's: `functionDeclarations` allow
 * dots, so the registry id maps through a per-request table like the OpenAI adapter, kept
 * consistent rather than clever.
 */
export class GeminiApiProvider extends ApiProviderBase {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor(options: GeminiApiOptions = {}) {
    super({
      id: "gemini",
      name: "Gemini API",
      defaultModel: options.defaultModel ?? "gemini-2.0-flash",
      ...(options.history ? { history: options.history } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    this.#apiKey = options.apiKey ?? process.env["GEMINI_API_KEY"];
    this.#baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  }

  async detect(): Promise<ProviderDetection> {
    if (!this.#apiKey) {
      return { available: false, reason: "GEMINI_API_KEY is not set (option apiKey or the environment)" };
    }
    return { available: true, version: "api" };
  }

  protected async complete(request: {
    model: string | undefined;
    messages: ApiMessage[];
    tools: ReturnType<SessionToolExecutor["list"]>;
    signal: AbortSignal;
  }): Promise<ApiTurnResult> {
    // Collision-safe like the other adapters: sanitized-and-truncated ids can collide, and a
    // last-write-wins map would execute a DIFFERENT tool than the model asked for.
    const wireNames = new Map<string, string>();
    const declarations = request.tools.map((tool) => ({
      name: uniqueWireName(tool.id, wireNames, GEMINI_NAME_CHARS),
      description: tool.description,
      parameters: sanitizeSchema(tool.inputSchema),
    }));

    const systemParts = request.messages
      .filter((m) => m.role === "system")
      .map((m) => ({ text: m.content }));

    const contents = mergeConsecutiveRoles(
      request.messages
        .filter((m) => m.role !== "system")
        .map((m) => toContent(m, wireNames))
        // An assistant turn that ended with empty text maps to zero parts, which the API rejects.
        .filter((c) => (c["parts"] as unknown[]).length > 0),
    );

    const model = request.model ?? this.defaultModel ?? "gemini-2.0-flash";
    const json = (await apiFetch(
      `${this.#baseUrl}/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey! },
        body: JSON.stringify({
          contents,
          ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
          ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
        }),
        signal: request.signal,
      },
      this.id,
      this.retry,
    )) as {
      modelVersion?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> };
      }>;
    };

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const wire = p.functionCall?.name ?? "";
        const toolId = wireNames.get(wire) ?? wire;
        return {
          // Unique across rounds: hosts correlate tool_result events to tool_call events by id.
          id: `call_${randomUUID()}`,
          toolId,
          name: toolId.split(":").pop() ?? toolId,
          arguments: p.functionCall?.args ?? {},
        };
      });

    return {
      ...(text ? { text } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(json.usageMetadata
        ? {
            usage: {
              model: json.modelVersion ?? model,
              ...(json.usageMetadata.promptTokenCount !== undefined
                ? { inputTokens: json.usageMetadata.promptTokenCount }
                : {}),
              ...(json.usageMetadata.candidatesTokenCount !== undefined
                ? { outputTokens: json.usageMetadata.candidatesTokenCount }
                : {}),
            },
          }
        : {}),
    };
  }
}

function toContent(message: ApiMessage, wireNames: Map<string, string>): Record<string, unknown> {
  if (message.role === "assistant") {
    const parts: unknown[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({
        functionCall: { name: wireNameFor(call.toolId, wireNames, GEMINI_NAME_CHARS), args: call.arguments ?? {} },
      });
    }
    return { role: "model", parts };
  }
  if (message.role === "tool") {
    // Gemini answers a functionCall with a functionResponse part in a user turn, keyed by the
    // function NAME the model called - not by a call id, which this API does not have.
    let payload: unknown;
    try { payload = JSON.parse(message.content); } catch { payload = { output: message.content }; }
    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: message.toolId ? wireNameFor(message.toolId, wireNames, GEMINI_NAME_CHARS) : "tool",
          response: { result: payload },
        },
      }],
    };
  }
  const parts: unknown[] = (message.attachments ?? []).map((attachment) => ({
    inlineData: { mimeType: attachment.mimeType, data: attachment.data },
  }));
  parts.push({ text: message.content });
  return { role: "user", parts };
}

/** Gemini allows dots in function names, unlike the OpenAI dialect. */
const GEMINI_NAME_CHARS = /[^A-Za-z0-9_.-]/g;

/**
 * Gemini's contract is alternating roles: a multi-tool round produces several consecutive
 * user-side functionResponse contents, which must collapse into one content whose part count
 * matches the model turn's functionCall count.
 */
function mergeConsecutiveRoles(
  contents: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  for (const content of contents) {
    const last = merged.at(-1);
    if (last && last["role"] === content["role"]) {
      (last["parts"] as unknown[]).push(...(content["parts"] as unknown[]));
    } else {
      merged.push(content);
    }
  }
  return merged;
}

/** Gemini rejects JSON Schema fields it does not know; keep the subset it documents. */
function sanitizeSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return { type: "object" };
  const allowed = ["type", "description", "properties", "required", "items", "enum", "format", "nullable", "anyOf", "oneOf"];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!allowed.includes(key)) continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]),
      );
    } else if (key === "items") {
      out[key] = sanitizeSchema(value);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      // Gemini understands anyOf; rewriting a union as {type:"object"} misdescribes it and the
      // model then sends objects the tool rejects until the round limit trips.
      out["anyOf"] = value.map((v) => sanitizeSchema(v));
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : { type: "object" };
}
