import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AgentBridgeError, type AgentBridge, type AgentEvent } from "@agentbridge/core";

import { extractToken, generateToken, tokenMatches } from "./auth.js";
import { WebSocketHub } from "./ws.js";

export interface RuntimeServerOptions {
  agent: AgentBridge;
  /** Defaults to 8760, falling back to an ephemeral port if it is taken (spec 33 D4). */
  port?: number;
  /** Defaults to 127.0.0.1. Binding elsewhere exposes local agents to the network (spec 26.2). */
  host?: string;
  token?: string;
}

export interface RuntimeAddress {
  host: string;
  port: number;
  token: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (context: RouteContext) => Promise<RouteResult>;
}

interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface RouteResult {
  status: number;
  body?: unknown;
}

const STATUS_BY_CODE: Record<string, number> = {
  "AB-1001": 404,
  "AB-1002": 404,
  "AB-1003": 502,
  "AB-1005": 400,
  "AB-1006": 502,
  "AB-1007": 409,
  "AB-2001": 400,
  "AB-2002": 409,
  "AB-2003": 404,
  "AB-2004": 400,
  "AB-2101": 502,
  "AB-2102": 502,
  "AB-2201": 404,
  "AB-2202": 502,
  "AB-2204": 408,
  "AB-3001": 400,
  "AB-3002": 409,
  "AB-3003": 409,
  "AB-3004": 404,
  "AB-3005": 400,
  "AB-3006": 409,
  "AB-4001": 403,
  "AB-4002": 404,
  "AB-4003": 408,
  "AB-4004": 400,
  "AB-5001": 401,
  "AB-5004": 400,
  "AB-5005": 503,
};

/**
 * Local HTTP and WebSocket runtime (spec 16, 17).
 *
 * Exists so applications that cannot import the SDK - Python, Swift, Kotlin, anything - reach the
 * same functionality over the wire. Binds to loopback and requires a token generated per start.
 */
export class RuntimeServer {
  readonly #agent: AgentBridge;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #token: string;
  readonly #routes: Route[] = [];
  readonly #hub: WebSocketHub;
  #server: Server | undefined;
  #address: RuntimeAddress | undefined;

  constructor(options: RuntimeServerOptions) {
    this.#agent = options.agent;
    this.#host = options.host ?? "127.0.0.1";
    this.#requestedPort = options.port ?? 8760;
    this.#token = options.token ?? generateToken();
    this.#hub = new WebSocketHub({
      replay: (sessionId, sinceSeq) => options.agent.events.replay(sessionId, sinceSeq),
      hasGap: (sessionId, sinceSeq) => options.agent.events.hasGap(sessionId, sinceSeq),
      knownSessions: () => options.agent.sessions.list().map((session) => session.id),
    });
    this.#defineRoutes();
  }

  get address(): RuntimeAddress {
    if (!this.#address) {
      throw new AgentBridgeError("AB-5005", { message: "the runtime has not started" });
    }
    return this.#address;
  }

  async start(): Promise<RuntimeAddress> {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${this.#host}`);
      if (url.pathname !== "/events" || !tokenMatches(this.#token, extractToken(request.headers, url))) {
        socket.destroy();
        return;
      }
      this.#hub.accept(request, socket, head);
    });

    const port = await listen(server, this.#requestedPort, this.#host);
    this.#address = { host: this.#host, port, token: this.#token };

    // Every event fans out to whoever subscribed over WebSocket.
    this.#agent.on("*" as never, ((event: AgentEvent) => this.#hub.broadcast(event)) as never);

    return this.#address;
  }

  async stop(): Promise<void> {
    this.#hub.closeAll();
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.#host}`);

    if (url.pathname !== "/health" && !tokenMatches(this.#token, extractToken(request.headers, url))) {
      return send(response, 401, {
        error: { code: "AB-5001", message: "authentication failed", retryable: false },
      });
    }

    for (const route of this.#routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      try {
        const body = await readJsonBody(request);
        const result = await route.handler({
          params: match.groups ?? {},
          query: url.searchParams,
          body,
        });
        return send(response, result.status, result.body);
      } catch (error) {
        const info =
          error instanceof AgentBridgeError
            ? error.toJSON()
            : { code: "AB-5004", message: String(error), retryable: false };
        return send(response, STATUS_BY_CODE[info.code] ?? 500, { error: info });
      }
    }

    return send(response, 404, {
      error: { code: "AB-5004", message: `no route for ${request.method} ${url.pathname}`, retryable: false },
    });
  }

  #defineRoutes(): void {
    const route = (method: string, path: string, handler: Route["handler"]): void => {
      const pattern = new RegExp(
        `^${path.replace(/:([a-zA-Z]+)/g, (_, name: string) => `(?<${name}>[^/]+)`)}$`,
      );
      this.#routes.push({ method, pattern, handler });
    };

    route("GET", "/health", async () => ({
      status: 200,
      body: { status: "ok", version: "0.0.0", uptimeMs: Math.round(process.uptime() * 1000) },
    }));

    route("GET", "/providers", async () => ({
      status: 200,
      body: { items: await this.#agent.providers.list() },
    }));

    route("POST", "/providers/detect", async ({ body }) => {
      const { id } = (body ?? {}) as { id?: string };
      return { status: 200, body: { items: await this.#agent.providers.detect(id) } };
    });

    route("GET", "/sessions", async ({ query }) => {
      const provider = query.get("provider");
      const status = query.get("status");
      return {
        status: 200,
        body: {
          items: this.#agent.sessions.list({
            ...(provider ? { provider } : {}),
            ...(status ? { status: status as never } : {}),
          }),
        },
      };
    });

    route("POST", "/sessions", async ({ body }) => {
      const session = await this.#agent.sessions.create(body as never);
      return { status: 201, body: session.info };
    });

    route("GET", "/sessions/:id", async ({ params }) => ({
      status: 200,
      body: this.#agent.sessions.get(params["id"]!).info,
    }));

    route("POST", "/sessions/:id/messages", async ({ params, body }) => {
      const { message } = (body ?? {}) as { message?: string };
      if (typeof message !== "string" || message.length === 0) {
        throw new AgentBridgeError("AB-5004", { message: "message is required" });
      }
      const result = await this.#agent.sessions.get(params["id"]!).send(message);
      return { status: 202, body: result };
    });

    route("POST", "/sessions/:id/interrupt", async ({ params }) => {
      await this.#agent.sessions.get(params["id"]!).interrupt();
      return { status: 204 };
    });

    route("POST", "/sessions/:id/resume", async ({ params }) => {
      const session = await this.#agent.sessions.resume(params["id"]!);
      return { status: 200, body: session.info };
    });

    route("PATCH", "/sessions/:id/mcp", async ({ params, body }) => {
      const { servers } = (body ?? {}) as { servers?: string[] };
      if (!Array.isArray(servers)) {
        throw new AgentBridgeError("AB-5004", { message: "servers must be an array" });
      }
      return { status: 200, body: await this.#agent.sessions.updateMcp(params["id"]!, servers) };
    });

    route("PATCH", "/sessions/:id/permission-mode", async ({ params, body }) => {
      const { mode } = (body ?? {}) as { mode?: string };
      if (mode !== "ask" && mode !== "allow" && mode !== "deny") {
        throw new AgentBridgeError("AB-5004", { message: "mode must be ask, allow, or deny" });
      }
      return {
        status: 200,
        body: await this.#agent.sessions.setPermissionMode(params["id"]!, mode),
      };
    });

    route("DELETE", "/sessions/:id", async ({ params }) => {
      await this.#agent.sessions.stop(params["id"]!);
      return { status: 204 };
    });

    route("GET", "/sessions/:id/events", async ({ params, query }) => {
      const sinceSeq = Number(query.get("sinceSeq") ?? 0);
      const sessionId = params["id"]!;
      if (this.#agent.events.hasGap(sessionId, sinceSeq)) {
        throw new AgentBridgeError("AB-5003", { details: { sessionId, sinceSeq } });
      }
      return { status: 200, body: { items: this.#agent.events.replay(sessionId, sinceSeq) } };
    });

    route("GET", "/mcp", async () => ({ status: 200, body: { items: this.#agent.mcp.list() } }));

    route("POST", "/mcp", async ({ body }) => ({
      status: 201,
      body: await this.#agent.mcp.add(body),
    }));

    route("GET", "/mcp/:id", async ({ params }) => ({
      status: 200,
      body: this.#agent.mcp.get(params["id"]!),
    }));

    route("DELETE", "/mcp/:id", async ({ params, query }) => {
      await this.#agent.mcp.remove(params["id"]!, { force: query.get("force") === "true" });
      return { status: 204 };
    });

    route("POST", "/mcp/:id/connect", async ({ params }) => ({
      status: 200,
      body: await this.#agent.mcp.connect(params["id"]!),
    }));

    route("POST", "/mcp/:id/disconnect", async ({ params }) => {
      await this.#agent.mcp.disconnect(params["id"]!);
      return { status: 204 };
    });

    route("POST", "/mcp/:id/reload", async ({ params }) => ({
      status: 200,
      body: await this.#agent.mcp.reload(params["id"]!),
    }));

    route("GET", "/tools", async ({ query }) => {
      const sessionId = query.get("sessionId");
      const server = query.get("server");
      return {
        status: 200,
        body: {
          items: this.#agent.tools.list({
            ...(sessionId ? { sessionId } : {}),
            ...(server ? { server } : {}),
          }),
        },
      };
    });

    route("GET", "/tools/:id", async ({ params }) => ({
      status: 200,
      body: this.#agent.tools.get(decodeURIComponent(params["id"]!)),
    }));

    route("POST", "/tools/:id/call", async ({ params, body }) => {
      const { arguments: args, sessionId, timeoutMs } = (body ?? {}) as {
        arguments?: unknown;
        sessionId?: string;
        timeoutMs?: number;
      };
      const result = await this.#agent.tools.call(decodeURIComponent(params["id"]!), args, {
        ...(sessionId ? { sessionId } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return { status: result.ok ? 200 : (STATUS_BY_CODE[result.error?.code ?? ""] ?? 502), body: result };
    });

    route("GET", "/permissions/pending", async ({ query }) => {
      const sessionId = query.get("sessionId");
      return {
        status: 200,
        body: { items: this.#agent.permissions.pending(sessionId ?? undefined) },
      };
    });

    route("POST", "/permissions/:requestId/approve", async ({ params, body }) => {
      this.#agent.permissions.approve(params["requestId"]!, (body ?? {}) as never);
      return { status: 204 };
    });

    route("POST", "/permissions/:requestId/deny", async ({ params, body }) => {
      this.#agent.permissions.deny(params["requestId"]!, (body ?? {}) as never);
      return { status: 204 };
    });

    route("GET", "/permissions/policies", async () => ({
      status: 200,
      body: { items: this.#agent.permissions.listPolicies() },
    }));

    route("PUT", "/permissions/policies", async ({ body }) => {
      this.#agent.permissions.setPolicy(body);
      return { status: 200, body };
    });
  }
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      // A taken default port falls back to an ephemeral one and the caller learns the real address.
      if (error.code === "EADDRINUSE" && port !== 0) {
        server.removeListener("error", onError);
        listen(server, 0, host).then(resolve, reject);
        return;
      }
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentBridgeError("AB-5004", { message: "request body is not valid JSON" });
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined || status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }

  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
