import type { AgentBridge } from "@jeonhui/agentbridge-core";

import { EmbeddedClient } from "./backends/embedded.js";
import { HttpClient, type HttpClientOptions } from "./backends/http.js";
import type { AgentBridgeClient } from "./types.js";

export type EmbeddedOptions = { transport: "embedded"; agent: AgentBridge };
export type HttpOptions = { transport: "http" } & HttpClientOptions;
export type ConnectOptions = EmbeddedOptions | HttpOptions;

/**
 * Builds a client over either backend (spec 9.3, 10.8).
 *
 * Host code depends on the returned interface, not on which transport produced it, so moving a
 * feature from an in-process integration to a shared runtime is a configuration change.
 */
export function createClient(options: ConnectOptions): AgentBridgeClient {
  return options.transport === "embedded"
    ? new EmbeddedClient(options.agent)
    : new HttpClient(options);
}

export { EmbeddedClient } from "./backends/embedded.js";
export { HttpClient, type HttpClientOptions, type WebSocketFactory, type WebSocketLike } from "./backends/http.js";
export * from "./types.js";
