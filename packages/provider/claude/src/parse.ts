import type { AgentEventPayload } from "@jeonhui/agentbridge-core";

/**
 * Maps Claude Code's `--output-format stream-json` lines onto AgentBridge events.
 *
 * The shapes here were captured from claude 2.1.220 rather than assumed. Line types observed:
 *   system/init          session_id, cwd, tools, mcp_servers, model
 *   system/hook_*        hook lifecycle noise, ignored
 *   assistant            message.content[] of text and tool_use blocks
 *   user                 message.content[] of tool_result blocks
 *   rate_limit_event     quota telemetry, ignored
 *   result               final turn outcome, carries `result` and `is_error`
 *
 * Unknown line types are ignored rather than treated as errors, since the CLI adds new
 * telemetry types over time. A malformed line is the caller's concern (see StreamParser).
 */
export interface ClaudeParseResult {
  events: AgentEventPayload[];
  /** Present on system/init and result lines. Stored as the resume token. */
  nativeSessionId?: string;
  /** True once the turn is finished. */
  done: boolean;
  /** Present on the result line. */
  isError?: boolean;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentBlocks(line: Record<string, unknown>): ContentBlock[] {
  const message = line["message"];
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>)["content"];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function parseClaudeLine(line: Record<string, unknown>): ClaudeParseResult {
  const type = asString(line["type"]);
  const sessionId = asString(line["session_id"]);
  const base: ClaudeParseResult = {
    events: [],
    done: false,
    ...(sessionId ? { nativeSessionId: sessionId } : {}),
  };

  switch (type) {
    case "system": {
      // Only init carries session identity; hook chatter is noise.
      return base;
    }

    case "assistant": {
      const events: AgentEventPayload[] = [];
      for (const block of contentBlocks(line)) {
        if (block.type === "text") {
          const text = asString(block.text);
          if (text !== undefined && text !== "") {
            events.push({ type: "message", role: "assistant", content: text, delta: false, done: true });
          }
        } else if (block.type === "tool_use") {
          const name = asString(block.name) ?? "unknown";
          events.push({
            type: "tool_call",
            callId: asString(block.id) ?? name,
            tool: name,
            toolId: `builtin::${name}`,
            arguments: block.input ?? {},
            source: { type: "builtin" },
          });
        }
      }
      return { ...base, events };
    }

    case "user": {
      const events: AgentEventPayload[] = [];
      for (const block of contentBlocks(line)) {
        if (block.type !== "tool_result") continue;
        const callId = asString(block.tool_use_id) ?? "unknown";
        if (block.is_error === true) {
          events.push({
            type: "tool_error",
            callId,
            tool: callId,
            ok: false,
            error: {
              code: "AB-2202",
              message: typeof block.content === "string" ? block.content : "tool execution failed",
              retryable: true,
            },
            durationMs: 0,
          });
        } else {
          events.push({
            type: "tool_result",
            callId,
            tool: callId,
            ok: true,
            content: block.content ?? null,
            durationMs: 0,
          });
        }
      }
      return { ...base, events };
    }

    case "result": {
      const isError = line["is_error"] === true;
      const events: AgentEventPayload[] = [];

      if (isError) {
        events.push({
          type: "error",
          error: {
            code: "AB-1006",
            message: asString(line["result"]) ?? asString(line["subtype"]) ?? "claude turn failed",
            retryable: true,
          },
          fatal: false,
        });
      }

      return { ...base, events, done: true, isError };
    }

    default:
      return base;
  }
}
