import { AgentBridgeError } from "../../core/index.js";
import {
  ProcessRunner,
  StreamParser,
  detectExecutable,
  type AgentProvider,
  type AgentStartOptions,
  type ProviderCapabilities,
  type ProviderDetection,
  type ProviderSessionHandle,
  type ResolvedMcpServer,
  type SendOptions,
} from "../core/index.js";

import { parseCodexLine } from "./parse.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexProviderOptions {
  executablePath?: string;
  command?: string;
  turnTimeoutMs?: number;
  /** Used when a session does not choose a model (spec 19.8). */
  defaultModel?: string;
  /**
   * Sandbox used when AgentBridge has pre-authorized the session's tools.
   * Defaults to workspace-write; danger-full-access is never selected implicitly.
   */
  authorizedSandbox?: CodexSandbox;
}

interface SessionRuntime {
  handle: ProviderSessionHandle;
  options: AgentStartOptions;
  runner: ProcessRunner | undefined;
}

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  mcp: true,
  resume: true,
  interrupt: true,
  workingDirectory: true,
  permissionHook: false,
};

/**
 * Codex CLI adapter.
 *
 * Runs `codex exec --json` once per turn and keeps continuity through the CLI's thread id
 * (`codex exec resume <id>`). Codex writes structured events to stdout and its own logs to
 * stderr, so only stdout is parsed.
 */
export class CodexProvider implements AgentProvider {
  readonly id = "codex";
  readonly name = "Codex CLI";
  readonly capabilities = CAPABILITIES;

  readonly #command: string;
  readonly #executablePath: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly defaultModel: string | undefined;
  readonly #authorizedSandbox: CodexSandbox;
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: CodexProviderOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#executablePath = options.executablePath;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
    this.defaultModel = options.defaultModel;
    this.#authorizedSandbox = options.authorizedSandbox ?? "workspace-write";
  }

  async detect(): Promise<ProviderDetection> {
    return detectExecutable({
      command: this.#command,
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
    });
  }

  async start(options: AgentStartOptions): Promise<ProviderSessionHandle> {
    const detection = await this.detect();
    if (!detection.available) {
      throw new AgentBridgeError("AB-1002", {
        message: detection.reason ?? "codex was not found",
        details: { providerId: this.id },
      });
    }

    const handle: ProviderSessionHandle = {
      sessionId: options.sessionId,
      providerId: this.id,
      ...(options.resumeToken ? { nativeSessionId: options.resumeToken } : {}),
    };

    this.#sessions.set(options.sessionId, { handle, options, runner: undefined });
    return handle;
  }

  async send(
    handle: ProviderSessionHandle,
    message: string,
    { emit, signal }: SendOptions,
  ): Promise<void> {
    const session = this.#sessions.get(handle.sessionId);
    if (!session) {
      throw new AgentBridgeError("AB-3004", { details: { sessionId: handle.sessionId } });
    }
    if (signal?.aborted) {
      throw new AgentBridgeError("AB-3006", { message: "the turn was aborted before it started" });
    }

    const parser = new StreamParser();
    let sawTurnEnd = false;
    let turnFailed = false;

    const consume = (raw: string): void => {
      for (const line of parser.push(raw)) {
        // Codex keeps its own logs on stderr, so an unparsable stdout line means the event
        // format moved and the host needs to know (spec 12.2).
        if (!line.ok) {
          emit({
            type: "error",
            error: {
              code: "AB-1004",
              message: `unparsable line from codex: ${line.error}`,
              details: { raw: line.raw.slice(0, 200) },
              retryable: true,
            },
            fatal: false,
          });
          continue;
        }

        const parsed = parseCodexLine(line.value);
        if (parsed.nativeSessionId) session.handle.nativeSessionId = parsed.nativeSessionId;
        for (const event of parsed.events) emit(event);
        if (parsed.done) {
          sawTurnEnd = true;
          turnFailed = parsed.isError === true;
        }
      }
    };

    const runner = new ProcessRunner({
      command: this.#executablePath ?? this.#command,
      args: this.#buildArgs(session, message),
      ...(session.options.workingDirectory ? { cwd: session.options.workingDirectory } : {}),
      ...(session.options.env ? { env: session.options.env } : {}),
      onStdout: consume,
    });
    session.runner = runner;

    const onAbort = () => runner.signal("SIGINT");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => runner.signal("SIGINT"), this.#turnTimeoutMs);
    timeout.unref?.();

    try {
      runner.start();
      runner.closeStdin();
      const exit = await runner.wait();

      for (const line of parser.flush()) {
        if (!line.ok) continue;
        const parsed = parseCodexLine(line.value);
        if (parsed.nativeSessionId) session.handle.nativeSessionId = parsed.nativeSessionId;
        for (const event of parsed.events) emit(event);
        if (parsed.done) {
          sawTurnEnd = true;
          turnFailed = parsed.isError === true;
        }
      }

      if (signal?.aborted) return;

      if (turnFailed || exit.code !== 0 || !sawTurnEnd) {
        throw new AgentBridgeError("AB-1006", {
          message: `codex turn did not complete (exit ${exit.code ?? "null"})`,
          details: { stderr: exit.stderr.slice(-2000), sawTurnEnd, turnFailed },
        });
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      session.runner = undefined;
    }
  }

  async interrupt(handle: ProviderSessionHandle): Promise<void> {
    const runner = this.#sessions.get(handle.sessionId)?.runner;
    if (!runner?.running) {
      throw new AgentBridgeError("AB-3006", { details: { sessionId: handle.sessionId } });
    }
    runner.signal("SIGINT");
  }

  async stop(handle: ProviderSessionHandle): Promise<void> {
    const session = this.#sessions.get(handle.sessionId);
    if (!session) return;
    if (session.runner) await session.runner.stop();
    this.#sessions.delete(handle.sessionId);
  }

  #buildArgs(session: SessionRuntime, message: string): string[] {
    const { options, handle } = session;
    const args = ["exec", "--json", "--skip-git-repo-check"];

    if (handle.nativeSessionId) args.push("resume", handle.nativeSessionId);

    // Codex expresses authorization as a sandbox level rather than a tool allowlist, so the
    // session's pre-authorization decides how much the agent may touch (spec 25.4).
    const authorized = (options.preauthorizedMcpServers ?? []).length > 0;
    args.push("--sandbox", authorized ? this.#authorizedSandbox : "read-only");

    if (options.workingDirectory) args.push("--cd", options.workingDirectory);
    const model = options.model ?? this.defaultModel;
    if (model) args.push("--model", model);

    for (const config of mcpConfigOverrides(options.mcpServers ?? [])) {
      args.push("-c", config);
    }

    args.push(message);
    return args;
  }
}

/** Injects MCP servers as `-c mcp_servers.<id>.<field>=<toml>` overrides (spec 12.3.3). */
export function mcpConfigOverrides(servers: ResolvedMcpServer[]): string[] {
  const overrides: string[] = [];

  for (const server of servers) {
    const prefix = `mcp_servers.${server.id}`;

    if (server.transport === "stdio") {
      if (server.command) overrides.push(`${prefix}.command=${JSON.stringify(server.command)}`);
      if (server.args?.length) overrides.push(`${prefix}.args=${JSON.stringify(server.args)}`);
      if (server.env && Object.keys(server.env).length > 0) {
        overrides.push(`${prefix}.env=${JSON.stringify(server.env)}`);
      }
      continue;
    }

    if (server.url) overrides.push(`${prefix}.url=${JSON.stringify(server.url)}`);
  }

  return overrides;
}
