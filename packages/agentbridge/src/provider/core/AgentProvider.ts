import type { AgentEventPayload } from "../../core/index.js";

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

/**
 * Lets an adapter execute tools through the core instead of injecting them into a CLI.
 *
 * CLI agents receive MCP servers and run tools themselves; API agents have no process to inject
 * into, so they call back through this. Every call runs the same path as agent.tools.call for the
 * session — permission rules, ask-mode approval, audit — which is why API providers get native
 * `ask` support without the permission-prompt hook.
 */
export interface SessionToolExecutor {
  list(): Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: unknown;
    permissions: string[];
  }>;
  call(toolId: string, args: unknown): Promise<{
    ok: boolean;
    content?: unknown;
    error?: { code: string; message: string; retryable: boolean };
  }>;
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
  /**
   * An MCP tool the agent must consult before running a tool call.
   *
   * This is how `ask` reaches an agent's own tool calls: the CLI runs the prompt tool in its own
   * process and blocks on the answer, so the decision travels back to the host rather than being
   * settled by the CLI's built-in prompt, which has nobody to ask in non-interactive mode.
   */
  permissionPrompt?: {
    server: ResolvedMcpServer;
    toolName: string;
  };
  /** Present when the core can execute tools on the adapter's behalf (spec 12.5). */
  toolExecutor?: SessionToolExecutor;
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
