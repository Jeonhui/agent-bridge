/**
 * Error code definitions. Maps 1:1 to table 18.2 of the specification.
 * When adding or changing a code, update docs/AgentBridge-Product-Spec.md 18.2 as well.
 */

export interface ErrorCodeSpec {
  readonly message: string;
  readonly retryable: boolean;
}

export const ERROR_CODES = {
  // AB-1xxx Provider
  "AB-1001": { message: "Unknown provider id", retryable: false },
  "AB-1002": { message: "Provider not installed or detection failed", retryable: false },
  "AB-1003": { message: "Provider process failed to start", retryable: true },
  "AB-1004": { message: "Failed to parse provider output", retryable: true },
  "AB-1005": { message: "Provider does not support the requested capability", retryable: false },
  "AB-1006": { message: "Provider process exited unexpectedly", retryable: true },
  "AB-1007": { message: "Duplicate provider id", retryable: false },

  // AB-2xxx MCP / Tool
  "AB-2001": { message: "MCP configuration validation failed", retryable: false },
  "AB-2002": { message: "Duplicate MCP server id", retryable: false },
  "AB-2003": { message: "MCP server not found", retryable: false },
  "AB-2004": { message: "MCP server cannot be bound to the session", retryable: false },
  "AB-2101": { message: "MCP connection failed", retryable: true },
  "AB-2102": { message: "MCP hot reload failed", retryable: true },
  "AB-2103": { message: "MCP initialize failed", retryable: false },
  "AB-2104": { message: "MCP connection lost", retryable: true },
  "AB-2201": { message: "Tool not found", retryable: false },
  "AB-2202": { message: "Tool execution failed", retryable: true },
  "AB-2203": { message: "Tool input schema validation failed", retryable: false },
  "AB-2204": { message: "Tool execution timed out", retryable: true },
  "AB-2205": { message: "Tool name conflict", retryable: false },

  // AB-3xxx Session
  "AB-3001": { message: "Session options validation failed", retryable: false },
  "AB-3002": { message: "Operation on a terminated session", retryable: false },
  "AB-3003": { message: "Session is already running a turn", retryable: true },
  "AB-3004": { message: "Session not found", retryable: false },
  "AB-3005": { message: "Working directory is not accessible", retryable: false },
  "AB-3006": { message: "Nothing to interrupt", retryable: false },
  "AB-3007": { message: "Session cannot be resumed", retryable: false },

  // AB-4xxx Permission
  "AB-4001": { message: "Permission denied", retryable: false },
  "AB-4002": { message: "Approval request not found or expired", retryable: false },
  "AB-4003": { message: "Approval wait timed out", retryable: true },
  "AB-4004": { message: "Permission rule validation failed", retryable: false },

  // AB-5xxx Runtime / Transport
  "AB-5001": { message: "Authentication failed", retryable: false },
  "AB-5002": { message: "Events dropped due to backpressure", retryable: true },
  "AB-5003": { message: "Requested sinceSeq is beyond event retention", retryable: false },
  "AB-5004": { message: "Request body validation failed", retryable: false },
  "AB-5005": { message: "Runtime is not running", retryable: true },

  // AB-6xxx Storage / Config
  "AB-6001": { message: "Storage initialization failed", retryable: true },
  "AB-6002": { message: "State document is corrupt", retryable: false },
  "AB-6003": { message: "Config file parsing failed", retryable: false },
  "AB-6004": { message: "Secret store access failed", retryable: true },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: string): value is ErrorCode {
  return value in ERROR_CODES;
}
