import { ERROR_CODES, type ErrorCode } from "./codes.js";

export interface AgentBridgeErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export class AgentBridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    const spec = ERROR_CODES[code];
    super(
      options.message ?? spec.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "AgentBridgeError";
    this.code = code;
    this.details = options.details;
    this.retryable = spec.retryable;
  }

  /** Serialization for external consumers. `cause` is deliberately excluded (spec 18.3). */
  toJSON(): AgentBridgeErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }
}
