import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** Keys whose values never appear in a log line, whatever the log level (spec 27.3). */
const SECRET_KEY = /token|secret|password|api[-_]?key|authorization|cookie|credential/i;

export const REDACTED = "***";

export function digest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** Shortens the home directory to `~` so logs do not leak the operator's username (spec 27.3). */
export function abbreviatePath(value: string): string {
  const home = homedir();
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/**
 * Replaces secret-looking values anywhere in a structure.
 * Cycles are cut rather than followed, so a self-referencing object cannot hang the logger.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return abbreviatePath(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redact(item, seen),
    ]),
  );
}

/**
 * Summarizes tool arguments for logging.
 *
 * Values are withheld by default: the argument names and a digest are enough to correlate a call
 * without writing file contents or credentials to disk (spec 27.3).
 */
export function summarizeArguments(
  args: unknown,
  options: { includeValues?: boolean } = {},
): { keys: string[]; argsDigest: string; values?: unknown } {
  const keys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>)
      : [];

  return {
    keys,
    argsDigest: digest(args),
    ...(options.includeValues ? { values: redact(args) } : {}),
  };
}

/** Message bodies are never logged verbatim; length plus a digest is what remains (spec 27.3). */
export function summarizeContent(content: string): { length: number; contentDigest: string } {
  return { length: content.length, contentDigest: digest(content) };
}
