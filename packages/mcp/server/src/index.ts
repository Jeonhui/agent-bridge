import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { AgentBridgeError, type AgentBridge } from "@jeonhui/agentbridge-core";

export interface AgentBridgeMcpServerOptions {
  agent: AgentBridge;
  /** Rejects a call whose depth exceeds this, so a session cannot drive itself (spec 23.4). */
  maxDepth?: number;
  /** Cap on the synchronous wait in agentbridge.sessions.send. Defaults to 120000ms. */
  sendTimeoutMs?: number;
  name?: string;
  version?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const DEPTH_KEY = "_agentBridgeDepth";

/**
 * The other direction of the bidirectional structure (spec 20, 23): an external agent connects
 * here and drives AgentBridge as a set of tools.
 *
 * Kept separate from the MCP client so a host can expose its runtime without also consuming
 * external servers, and vice versa.
 */
export class AgentBridgeMcpServer {
  readonly #agent: AgentBridge;
  readonly #maxDepth: number;
  readonly #sendTimeoutMs: number;
  readonly #server: Server;
  readonly #tools: ToolDefinition[];

  constructor(options: AgentBridgeMcpServerOptions) {
    this.#agent = options.agent;
    this.#maxDepth = options.maxDepth ?? 2;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? 120_000;
    this.#tools = this.#defineTools();

    this.#server = new Server(
      { name: options.name ?? "agentbridge", version: options.version ?? "0.0.0" },
      { capabilities: { tools: {} } },
    );

    this.#server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.#tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    }));

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      return this.call(name, args as Record<string, unknown>);
    });
  }

  /** Exposed directly so the tool surface is testable without a transport. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return errorContent(new AgentBridgeError("AB-2201", { details: { tool: name } }));
    }

    const depth = Number(args[DEPTH_KEY] ?? 0);
    if (depth >= this.#maxDepth) {
      return errorContent(
        new AgentBridgeError("AB-2202", {
          message: `call depth ${depth} reached the limit of ${this.#maxDepth}`,
          details: { tool: name, depth },
        }),
      );
    }

    try {
      const result = await tool.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return errorContent(error);
    }
  }

  listToolNames(): string[] {
    return this.#tools.map((tool) => tool.name);
  }

  /** Serves over stdio, the transport an agent CLI launches as a child process (spec 23.2). */
  async serveStdio(): Promise<void> {
    await this.#server.connect(new StdioServerTransport());
  }

  async close(): Promise<void> {
    await this.#server.close();
  }

  #defineTools(): ToolDefinition[] {
    const agent = this.#agent;

    return [
      {
        name: "agentbridge_providers_list",
        description: "List the agent CLIs detected on this machine.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => agent.providers.list(),
      },
      {
        name: "agentbridge_sessions_list",
        description: "List agent sessions and their status.",
        inputSchema: {
          type: "object",
          properties: { provider: { type: "string" } },
        },
        handler: async (args) =>
          agent.sessions.list(
            typeof args["provider"] === "string" ? { provider: args["provider"] } : undefined,
          ),
      },
      {
        name: "agentbridge_sessions_create",
        description: "Create an agent session and return its id.",
        inputSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            workingDirectory: { type: "string" },
            model: { type: "string" },
          },
          required: ["provider"],
        },
        handler: async (args) => {
          const session = await agent.sessions.create(args as never);
          return { sessionId: session.id, status: session.info.status };
        },
      },
      {
        name: "agentbridge_sessions_send",
        description: "Send a message to an agent session and wait for the turn to finish.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" }, message: { type: "string" } },
          required: ["sessionId", "message"],
        },
        handler: async (args) => {
          const sessionId = String(args["sessionId"]);
          const session = agent.sessions.get(sessionId);

          const replies: string[] = [];
          const off = session.on("message", (event) => replies.push(event.content));

          try {
            await withTimeout(session.send(String(args["message"])), this.#sendTimeoutMs, sessionId);
            return { sessionId, messages: replies };
          } finally {
            off();
          }
        },
      },
      {
        name: "agentbridge_sessions_stop",
        description: "Stop an agent session.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          required: ["sessionId"],
        },
        handler: async (args) => {
          await agent.sessions.stop(String(args["sessionId"]));
          return { sessionId: args["sessionId"], stopped: true };
        },
      },
      {
        name: "agentbridge_mcp_list",
        description: "List the tools AgentBridge has discovered from its MCP servers.",
        inputSchema: {
          type: "object",
          properties: { server: { type: "string" } },
        },
        handler: async (args) =>
          agent.tools.list(typeof args["server"] === "string" ? { server: args["server"] } : undefined),
      },
      {
        name: "agentbridge_tools_call",
        description: "Call a registered tool through AgentBridge, subject to its permission policy.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string" },
            arguments: { type: "object" },
            sessionId: { type: "string" },
          },
          required: ["toolId"],
        },
        handler: async (args) => {
          const result = await agent.tools.call(
            String(args["toolId"]),
            args["arguments"] ?? {},
            typeof args["sessionId"] === "string" ? { sessionId: args["sessionId"] } : {},
          );
          if (!result.ok) {
            throw new AgentBridgeError((result.error?.code ?? "AB-2202") as never, {
              ...(result.error?.message ? { message: result.error.message } : {}),
            });
          }
          return result;
        },
      },
    ];
  }
}

function errorContent(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const info =
    error instanceof AgentBridgeError
      ? error.toJSON()
      : { code: "AB-2202", message: String(error), retryable: true };

  return { content: [{ type: "text", text: `${info.code}: ${info.message}` }], isError: true };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, sessionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AgentBridgeError("AB-2204", {
            message: `waiting for session ${sessionId} exceeded ${ms}ms`,
            details: { sessionId },
          }),
        ),
      ms,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
