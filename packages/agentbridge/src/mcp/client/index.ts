import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AgentBridgeError } from "../../core/index.js";

export type McpTransportKind = "stdio" | "sse" | "streamable-http";

export interface McpServerConfigBase {
  id: string;
  name?: string;
  transport: McpTransportKind;
  enabled?: boolean;
  autoConnect?: boolean;
  toolPrefix?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; backoffMs: number };
}

export interface WatchConfig {
  enabled: boolean;
  paths?: string[];
  debounceMs?: number;
}

export interface StdioMcpConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  watch?: WatchConfig;
}

export interface SseMcpConfig extends McpServerConfigBase {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface StreamableHttpMcpConfig extends McpServerConfigBase {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpConfig | SseMcpConfig | StreamableHttpMcpConfig;

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Validates a config before anything is spawned or connected (spec 21.1 step 1). */
export function validateMcpConfig(config: McpServerConfig): void {
  if (!ID_PATTERN.test(config.id)) {
    throw new AgentBridgeError("AB-2001", {
      message: `invalid MCP server id: ${config.id}`,
      details: { id: config.id },
    });
  }

  if (config.transport === "stdio") {
    if (!config.command) {
      throw new AgentBridgeError("AB-2001", {
        message: "stdio transport requires a command",
        details: { id: config.id },
      });
    }
    return;
  }

  if (!config.url) {
    throw new AgentBridgeError("AB-2001", {
      message: `${config.transport} transport requires a url`,
      details: { id: config.id },
    });
  }

  try {
    new URL(config.url);
  } catch {
    throw new AgentBridgeError("AB-2001", {
      message: `invalid url for MCP server ${config.id}: ${config.url}`,
      details: { id: config.id, url: config.url },
    });
  }
}

/** Replaces secret-looking values so a config can be returned over the API (spec 26.3). */
export function maskMcpConfig(config: McpServerConfig): McpServerConfig {
  const masked = { ...config } as McpServerConfig;

  if (masked.transport === "stdio" && masked.env) {
    masked.env = Object.fromEntries(Object.keys(masked.env).map((key) => [key, "***"]));
  }
  if (masked.transport !== "stdio" && masked.headers) {
    masked.headers = Object.fromEntries(Object.keys(masked.headers).map((key) => [key, "***"]));
  }

  return masked;
}

/**
 * One connection to an MCP server, wrapping the official SDK client.
 * Transport differences stop here; nothing above this layer knows which kind is in use.
 */
export class McpClient {
  readonly config: McpServerConfig;
  #client: Client | undefined;
  #serverInfo: McpServerInfo | undefined;

  constructor(config: McpServerConfig) {
    validateMcpConfig(config);
    this.config = config;
  }

  get connected(): boolean {
    return this.#client !== undefined;
  }

  get serverInfo(): McpServerInfo | undefined {
    return this.#serverInfo;
  }

  async connect(): Promise<McpServerInfo> {
    if (this.#client) return this.#serverInfo ?? { name: this.config.id, version: "unknown" };

    const client = new Client(
      { name: "agentbridge", version: "0.0.0" },
      { capabilities: {} },
    );

    try {
      // The SDK's Transport type predates exactOptionalPropertyTypes, so widen at this seam only.
      await client.connect(this.#createTransport() as Parameters<Client["connect"]>[0]);
    } catch (error) {
      throw new AgentBridgeError("AB-2101", {
        message: `failed to connect to MCP server ${this.config.id}`,
        details: { id: this.config.id },
        cause: error,
      });
    }

    const version = client.getServerVersion();
    this.#client = client;
    this.#serverInfo = {
      name: version?.name ?? this.config.id,
      version: version?.version ?? "unknown",
    };
    return this.#serverInfo;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const client = this.#require();
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;

    // tools/list is paginated; a server with many tools returns a cursor (spec 21.1).
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(name: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    const client = this.#require();

    try {
      const result = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
      );
      if (result.isError) {
        throw new AgentBridgeError("AB-2202", {
          message: `tool ${name} reported an error`,
          details: { serverId: this.config.id, name, content: result.content },
        });
      }
      return result.content;
    } catch (error) {
      if (error instanceof AgentBridgeError) throw error;
      throw new AgentBridgeError("AB-2202", {
        message: `tool ${name} failed on server ${this.config.id}`,
        details: { serverId: this.config.id, name },
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#serverInfo = undefined;
    await client?.close();
  }

  #createTransport() {
    const config = this.config;

    if (config.transport === "stdio") {
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        env: { ...(process.env as Record<string, string>), ...config.env },
      });
    }

    const url = new URL(config.url);
    const requestInit = config.headers ? { requestInit: { headers: config.headers } } : undefined;

    return config.transport === "sse"
      ? new SSEClientTransport(url, requestInit)
      : new StreamableHTTPClientTransport(url, requestInit);
  }

  #require(): Client {
    if (!this.#client) {
      throw new AgentBridgeError("AB-2104", {
        message: `MCP server ${this.config.id} is not connected`,
        details: { id: this.config.id },
      });
    }
    return this.#client;
  }
}
