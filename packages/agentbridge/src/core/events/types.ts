import type { AgentBridgeErrorInfo } from "../errors/AgentBridgeError.js";
import type { SessionStatus } from "../session/types.js";

export interface AgentEventBase {
  id: string;
  /** Monotonically increasing sequence within a session. Used for reconnect recovery. */
  seq: number;
  sessionId: string;
  turnId?: string;
  /** ISO 8601 */
  timestamp: string;
}

export type AgentEventType =
  | "message"
  | "tool_call"
  | "tool_progress"
  | "tool_result"
  | "tool_error"
  | "status"
  | "permission_request"
  | "mcp_status"
  | "error";

export type Permission = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "SYSTEM";

export interface ToolSource {
  type: "mcp" | "builtin" | "system" | "agent";
  server?: string;
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "reloading"
  | "disconnected"
  | "error";

export interface MessageEvent extends AgentEventBase {
  type: "message";
  role: "assistant" | "user" | "system";
  content: string;
  delta: boolean;
  done: boolean;
}

export interface ToolCallEvent extends AgentEventBase {
  type: "tool_call";
  callId: string;
  tool: string;
  toolId: string;
  arguments: unknown;
  source: ToolSource;
}

export interface ToolProgressEvent extends AgentEventBase {
  type: "tool_progress";
  callId: string;
  tool: string;
  progress?: number;
  message?: string;
}

export interface ToolResultEvent extends AgentEventBase {
  type: "tool_result";
  callId: string;
  tool: string;
  ok: true;
  content: unknown;
  durationMs: number;
}

export interface ToolErrorEvent extends AgentEventBase {
  type: "tool_error";
  callId: string;
  tool: string;
  ok: false;
  error: AgentBridgeErrorInfo;
  durationMs: number;
}

export interface StatusEvent extends AgentEventBase {
  type: "status";
  status: SessionStatus;
  previous: SessionStatus;
  reason?: string;
}

export interface PermissionRequestEvent extends AgentEventBase {
  type: "permission_request";
  requestId: string;
  tool: string;
  toolId: string;
  arguments: unknown;
  permissions: Permission[];
  expiresAt: string;
}

export interface McpStatusEvent extends AgentEventBase {
  type: "mcp_status";
  serverId: string;
  state: McpConnectionState;
  toolCount?: number;
  error?: AgentBridgeErrorInfo;
}

export interface ErrorEvent extends AgentEventBase {
  type: "error";
  error: AgentBridgeErrorInfo;
  fatal: boolean;
}

export type AgentEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StatusEvent
  | PermissionRequestEvent
  | McpStatusEvent
  | ErrorEvent;

export type AgentEventOf<E extends AgentEventType> = Extract<AgentEvent, { type: E }>;

/**
 * An event without its envelope. Provider adapters produce these because they cannot know a
 * session's `seq`; the core stamps id, seq, sessionId, turnId, and timestamp on emission.
 */
export type AgentEventPayload = WithoutEnvelope<AgentEvent>;

type WithoutEnvelope<T> = T extends AgentEventBase ? Omit<T, keyof AgentEventBase> : never;

export type AgentEventPayloadOf<E extends AgentEventType> = Extract<AgentEventPayload, { type: E }>;

export type Unsubscribe = () => void;
