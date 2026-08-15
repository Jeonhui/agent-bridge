import { redact } from "./redaction.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where records go. Defaults to stderr, so stdout stays free for host output. */
  sink?: (record: LogRecord) => void;
  /** Fields attached to every record, e.g. a traceId. */
  base?: Record<string, unknown>;
}

/**
 * Structured logger (spec 27).
 *
 * Every field passes through redaction, so a caller cannot leak a secret by logging an object
 * that happens to carry one.
 */
export class Logger {
  readonly #level: LogLevel;
  readonly #sink: (record: LogRecord) => void;
  readonly #base: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#sink = options.sink ?? ((record) => process.stderr.write(`${JSON.stringify(record)}\n`));
    this.#base = options.base ?? {};
  }

  child(base: Record<string, unknown>): Logger {
    return new Logger({ level: this.#level, sink: this.#sink, base: { ...this.#base, ...base } });
  }

  enabled(level: LogLevel): boolean {
    return ORDER[level] >= ORDER[this.#level];
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled(level)) return;

    this.#sink({
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact({ ...this.#base, ...fields }) as Record<string, unknown>),
    });
  }

  trace(event: string, fields?: Record<string, unknown>): void {
    this.log("trace", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
}
