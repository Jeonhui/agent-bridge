import type { AgentEventPayload } from "@agentbridge/core";

export interface ProviderCapabilities {
  streaming: boolean;
  mcp: boolean;
  resume: boolean;
  interrupt: boolean;
  workingDirectory: boolean;
  permissionHook: boolean;
}

export interface ProviderDetection {
  available: boolean;
  version?: string;
  executablePath?: string;
  /** Why detection failed. Populated when `available` is false. */
  reason?: string;
}

export interface ProviderInfo extends ProviderDetection {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
}

export type McpTransport = "stdio" | "sse" | "streamable-http";

/** Injection-ready configuration resolved by the MCP Manager when binding to a session (spec 12.1). */
export interface ResolvedMcpServer {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolPrefix?: string;
}

export interface AgentStartOptions {
  sessionId: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  mcpServers?: ResolvedMcpServer[];
  model?: string;
  systemPrompt?: string;
  resumeToken?: string;
  /**
   * Tools AgentBridge has already authorized for this session.
   *
   * Agent CLIs carry their own approval prompts, which in non-interactive mode resolve to a
   * denial. AgentBridge owns the permission decision (spec 25), so it passes the outcome down
   * and each adapter expresses it in that CLI's vocabulary. An empty list authorizes nothing.
   */
  preauthorizedMcpServers?: string[];
}

export interface ProviderSessionHandle {
  sessionId: string;
  providerId: string;
  pid?: number;
  /** The Agent CLI's own session identifier. Used to resume. */
  nativeSessionId?: string;
}

/**
 * Sink the adapter pushes normalized events into.
 * The adapter never sets id, seq, sessionId, or timestamp; the core stamps those on emission.
 */
export type ProviderEmit = (payload: AgentEventPayload) => void;

export interface SendOptions {
  emit: ProviderEmit;
  /** Aborts the turn. Adapters must stop their process when this fires (spec 25.5). */
  signal?: AbortSignal;
}

/**
 * Every Agent CLI is abstracted behind this interface (spec 6.1 / 12.1).
 * The core knows nothing about CLI flags or output formats.
 */
export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Detects local installation and version. Must be free of side effects. */
  detect(): Promise<ProviderDetection>;

  /**
   * Prepares a session. Adapters that run one process per turn do no spawning here;
   * they validate options and return the handle.
   */
  start(options: AgentStartOptions): Promise<ProviderSessionHandle>;

  /**
   * Runs one turn. Resolves when the agent finishes the turn, having pushed every event
   * into `options.emit`. Rejects with an AgentBridgeError if the turn could not run.
   */
  send(handle: ProviderSessionHandle, message: string, options: SendOptions): Promise<void>;

  /** Interrupts the in-flight turn. The session stays alive. */
  interrupt(handle: ProviderSessionHandle): Promise<void>;

  /** Terminates the agent process and reclaims its resources. */
  stop(handle: ProviderSessionHandle): Promise<void>;
}
