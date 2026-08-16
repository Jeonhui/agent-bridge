import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logging/Logger.js";
import type { SecretResolver } from "../secrets/SecretResolver.js";
import type { Identified, Storage } from "../storage/Storage.js";
import type { PermissionMode } from "../session/types.js";

export interface AgentBridgeConfig {
  dataDir?: string;
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  defaultPermissionMode?: PermissionMode;
  approvalTimeoutMs?: number;
  eventRetentionPerSession?: number;
  workingDirectory?: string;
  /**
   * How deep agent-calls-agent chains may go (spec 12.6). The host's own call is depth 0;
   * the default of 2 lets an agent consult another agent, but not recurse further.
   */
  maxAgentCallDepth?: number;
  /** Defaults to MemoryStorage, which suits a library embedded in an application (spec 20.2). */
  storage?: Storage<Identified, Identified, Identified>;
  /** Defaults to a logger at `logLevel` writing structured records to stderr. */
  logger?: Logger;
  /** Resolves `secret://` references (spec 26.3). Without one, using a reference is an error. */
  secrets?: SecretResolver;
}

export type ResolvedConfig = Required<
  Omit<AgentBridgeConfig, "workingDirectory" | "storage" | "logger" | "secrets">
> & {
  workingDirectory: string;
};

/** Defaults from spec 14.1 and the recommended defaults in chapter 33. */
export function resolveConfig(config: AgentBridgeConfig = {}): ResolvedConfig {
  return {
    dataDir: config.dataDir ?? join(homedir(), ".agentbridge"),
    // "warn" so an embedded library does not write JSON to stderr on every session;
    // the daemon passes "info" explicitly, where lifecycle logs are the point (spec 27.4).
    logLevel: config.logLevel ?? "warn",
    defaultPermissionMode: config.defaultPermissionMode ?? "ask",
    approvalTimeoutMs: config.approvalTimeoutMs ?? 120_000,
    eventRetentionPerSession: config.eventRetentionPerSession ?? 1000,
    workingDirectory: config.workingDirectory ?? process.cwd(),
    maxAgentCallDepth: config.maxAgentCallDepth ?? 2,
  };
}
