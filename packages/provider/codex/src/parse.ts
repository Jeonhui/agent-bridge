import type { AgentEventPayload } from "@jeonhui/agentbridge-core";

/**
 * Maps Codex CLI `exec --json` lines onto AgentBridge events.
 *
 * Envelope names were read out of the codex 0.132.0 binary and confirmed against live output:
 *   thread.started                 carries thread_id, the handle used to resume
 *   turn.started / turn.completed  turn boundaries
 *   turn.failed                    turn boundary carrying an error
 *   item.started / .updated / .completed   work items
 *   error                          a standalone failure
 *
 * Item payload variants are matched structurally rather than by an exhaustive type list, because
 * the CLI adds item kinds over time and an unknown kind must not drop the event.
 */
export interface CodexParseResult {
  events: AgentEventPayload[];
  nativeSessionId?: string;
  done: boolean;
  isError?: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Codex nests its upstream error as a JSON string; surface the readable part when it is there. */
export function readErrorMessage(value: unknown): string {
  const direct = asString(value);
  if (direct) {
    try {
      const parsed = asRecord(JSON.parse(direct));
      const nested = asRecord(parsed?.["error"]);
      return asString(nested?.["message"]) ?? direct;
    } catch {
      return direct;
    }
  }

  const record = asRecord(value);
  if (record) return readErrorMessage(record["message"] ?? record["error"]);
  return "codex reported an error";
}

function itemEvents(item: Record<string, unknown>): AgentEventPayload[] {
  const kind = asString(item["type"]) ?? asString(item["item_type"]) ?? "";

  // Reasoning is internal deliberation, not an answer, so it is not surfaced as a message.
  if (kind === "reasoning") return [];

  if (kind === "mcp_tool_call") {
    const server = asString(item["server"]) ?? "";
    const tool = asString(item["tool"]) ?? asString(item["name"]) ?? "unknown";
    return [
      {
        type: "tool_call",
        callId: asString(item["id"]) ?? tool,
        tool: server ? `${server}.${tool}` : tool,
        toolId: `mcp:${server}:${tool}`,
        arguments: item["arguments"] ?? item["input"] ?? {},
        source: { type: "mcp", ...(server ? { server } : {}) },
      },
    ];
  }

  if (kind === "command_execution") {
    const command = asString(item["command"]) ?? "";
    return [
      {
        type: "tool_call",
        callId: asString(item["id"]) ?? "command",
        tool: "command_execution",
        toolId: "builtin::command_execution",
        arguments: { command },
        source: { type: "builtin" },
      },
    ];
  }

  const text = asString(item["text"]) ?? asString(item["content"]) ?? asString(item["message"]);
  if (text !== undefined && text !== "") {
    return [{ type: "message", role: "assistant", content: text, delta: false, done: true }];
  }

  return [];
}

export function parseCodexLine(line: Record<string, unknown>): CodexParseResult {
  const type = asString(line["type"]);
  const base: CodexParseResult = { events: [], done: false };

  switch (type) {
    case "thread.started": {
      const threadId = asString(line["thread_id"]);
      return threadId ? { ...base, nativeSessionId: threadId } : base;
    }

    case "turn.started":
    case "item.started":
    case "item.updated":
      return base;

    case "item.completed": {
      const item = asRecord(line["item"]);
      return item ? { ...base, events: itemEvents(item) } : base;
    }

    case "turn.completed":
      return { ...base, done: true, isError: false };

    case "turn.failed": {
      const message = readErrorMessage(line["error"]);
      return {
        ...base,
        done: true,
        isError: true,
        events: [
          {
            type: "error",
            error: { code: "AB-1006", message, retryable: true },
            fatal: false,
          },
        ],
      };
    }

    case "error": {
      const message = readErrorMessage(line["message"] ?? line["error"]);
      return {
        ...base,
        events: [
          {
            type: "error",
            error: { code: "AB-1006", message, retryable: true },
            fatal: false,
          },
        ],
      };
    }

    default:
      return base;
  }
}
