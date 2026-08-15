import type { AgentBridgeErrorInfo } from "../errors/AgentBridgeError.js";

export type SessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type PermissionMode = "ask" | "allow" | "deny";

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
