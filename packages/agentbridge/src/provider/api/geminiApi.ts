import type { ProviderDetection, SessionToolExecutor } from "../core/AgentProvider.js";
import { ApiProviderBase, apiFetch, type ApiMessage, type ApiTurnResult } from "./base.js";

export interface GeminiApiOptions {
  /** Falls back to GEMINI_API_KEY, the same variable the retired CLI documented. */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxToolRounds?: number;
  requestTimeoutMs?: number;
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
    const wireNames = new Map<string, string>();
    const declarations = request.tools.map((tool) => {
      const wire = tool.id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
      wireNames.set(wire, tool.id);
      return {
        name: wire,
        description: tool.description,
        parameters: sanitizeSchema(tool.inputSchema),
      };
    });

    const systemParts = request.messages
      .filter((m) => m.role === "system")
      .map((m) => ({ text: m.content }));

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => toContent(m, wireNames));

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
    )) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> };
      }>;
    };

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p, index) => {
        const wire = p.functionCall?.name ?? "";
        const toolId = wireNames.get(wire) ?? wire;
        return {
          id: `call_${index}`,
          toolId,
          name: toolId.split(":").pop() ?? toolId,
          arguments: p.functionCall?.args ?? {},
        };
      });

    return {
      ...(text ? { text } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    };
  }
}

function toContent(message: ApiMessage, wireNames: Map<string, string>): Record<string, unknown> {
  if (message.role === "assistant") {
    const parts: unknown[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      let wire = call.toolId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
      for (const [w, id] of wireNames) if (id === call.toolId) wire = w;
      parts.push({ functionCall: { name: wire, args: call.arguments ?? {} } });
    }
    return { role: "model", parts };
  }
  if (message.role === "tool") {
    // Gemini answers a functionCall with a functionResponse part in a user turn.
    let payload: unknown;
    try { payload = JSON.parse(message.content); } catch { payload = { output: message.content }; }
    return {
      role: "user",
      parts: [{ functionResponse: { name: message.toolCallId ?? "tool", response: { result: payload } } }],
    };
  }
  return { role: "user", parts: [{ text: message.content }] };
}

/** Gemini rejects JSON Schema fields it does not know; keep the subset it documents. */
function sanitizeSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return { type: "object" };
  const allowed = ["type", "description", "properties", "required", "items", "enum", "format", "nullable"];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!allowed.includes(key)) continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]),
      );
    } else if (key === "items") {
      out[key] = sanitizeSchema(value);
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : { type: "object" };
}
