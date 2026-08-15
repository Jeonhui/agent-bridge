import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The decision an agent CLI expects back from a permission prompt tool.
 * Shape taken from the claude 2.1.220 binary: `behavior` plus `updatedInput` or `message`.
 */
export interface PromptDecision {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

export interface ApprovalRequestPayload {
  sessionId: string;
  toolName: string;
  input: unknown;
}

export interface ApprovalGatewayOptions {
  /** Called for each request the agent raises. Resolving decides the tool call. */
  onRequest: (payload: ApprovalRequestPayload) => Promise<PromptDecision>;
  host?: string;
}

export interface GatewayAddress {
  url: string;
  token: string;
}

/**
 * A loopback endpoint the permission prompt tool calls back into.
 *
 * An agent CLI runs the prompt tool as an MCP server in its own process, so the decision has to
 * cross a process boundary to reach the host application. This is the smallest thing that does
 * that: loopback only, a token minted per start, and no route but the one.
 */
export class ApprovalGateway {
  readonly #onRequest: ApprovalGatewayOptions["onRequest"];
  readonly #host: string;
  readonly #token = randomBytes(24).toString("hex");
  #server: Server | undefined;
  #address: GatewayAddress | undefined;

  constructor(options: ApprovalGatewayOptions) {
    this.#onRequest = options.onRequest;
    this.#host = options.host ?? "127.0.0.1";
  }

  get address(): GatewayAddress | undefined {
    return this.#address;
  }

  async start(): Promise<GatewayAddress> {
    if (this.#address) return this.#address;

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.#host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const port = (server.address() as AddressInfo).port;
    this.#address = { url: `http://${this.#host}:${port}`, token: this.#token };
    return this.#address;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    if (request.method !== "POST" || request.url !== "/approve") {
      send(404, { behavior: "deny", message: "not found" });
      return;
    }

    const header = request.headers["authorization"];
    const provided = typeof header === "string" ? header.replace(/^Bearer /, "") : "";
    if (!this.#tokenMatches(provided)) {
      send(401, { behavior: "deny", message: "unauthorized" });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);

    let payload: ApprovalRequestPayload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ApprovalRequestPayload;
    } catch {
      send(400, { behavior: "deny", message: "malformed request" });
      return;
    }

    try {
      send(200, await this.#onRequest(payload));
    } catch (error) {
      // The agent is waiting on this response, so a failure here must still be an answer.
      send(200, { behavior: "deny", message: `approval failed: ${String(error)}` });
    }
  }

  #tokenMatches(provided: string): boolean {
    const expected = Buffer.from(this.#token);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
