import type { AgentBridgeErrorInfo } from "../errors/AgentBridgeError.js";

export type SessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type PermissionMode = "ask" | "allow" | "deny";

/**
 * A binary payload accompanying one message (spec 13.6). Base64, because it must survive JSON
 * transport (REST body, history files) unchanged. Which types a provider accepts is the
 * adapter's business: API adapters map them onto their wire format, CLI adapters that cannot
 * carry them reject with AB-1005 rather than silently dropping them.
 */
export interface MessageAttachment {
  type: "image" | "document";
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
  mimeType: string;
  name?: string;
}

export interface SendMessageOptions {
  attachments?: MessageAttachment[];
}

export interface AgentSession {
  id: string;
  provider: string;
  title?: string;
  workingDirectory?: string;
  status: SessionStatus;
  mcpServers: string[];
  model?: string;
  env?: Record<string, string>;
  permissionMode: PermissionMode;
  /** Cumulative token consumption across turns, when the provider reports it (spec 15.2). */
  usage?: { inputTokens: number; outputTokens: number; turns: number };
  nativeSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastError?: AgentBridgeErrorInfo;
}

export interface CreateSessionOptions {
  provider: string;
  workingDirectory?: string;
  mcp?: string[];
  model?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
  title?: string;
  queueing?: boolean;
}
