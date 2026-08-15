/**
 * Line-delimited JSON parser for agent CLI stdout.
 *
 * Chunks arrive on arbitrary boundaries, so a trailing partial line is held until the rest
 * shows up. Non-JSON noise (banners, warnings) is reported rather than dropped silently,
 * because a CLI format change must surface as an error instead of missing events (spec 12.2).
 */
export class StreamParser {
  #buffer = "";

  /** Feeds a chunk and returns whatever complete lines it produced. */
  push(chunk: string): ParsedLine[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map(parseLine).filter((line): line is ParsedLine => line !== undefined);
  }

  /** Flushes a trailing line that never got its newline, e.g. at process exit. */
  flush(): ParsedLine[] {
    const rest = this.#buffer;
    this.#buffer = "";
    const parsed = parseLine(rest);
    return parsed ? [parsed] : [];
  }

  get pending(): string {
    return this.#buffer;
  }
}

export type ParsedLine =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

function parseLine(line: string): ParsedLine | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, raw: trimmed, error: "expected a JSON object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      raw: trimmed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
