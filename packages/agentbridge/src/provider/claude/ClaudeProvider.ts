import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { parseClaudeLine } from "./parse.js";

export interface ClaudeProviderOptions {
  /** Overrides PATH resolution. */
  executablePath?: string;
  /** Defaults to "claude". */
  command?: string;
  /** Per-turn deadline. Defaults to 300000ms. */
  turnTimeoutMs?: number;
  /** Used when a session does not choose a model (spec 19.8). */
  defaultModel?: string;
}

interface SessionRuntime {
  handle: ProviderSessionHandle;
  options: AgentStartOptions;
  runner: ProcessRunner | undefined;
  tempDir: string | undefined;
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
 * Claude Code adapter.
 *
 * Runs one process per turn in `--print` mode and preserves continuity through the CLI's own
 * session id (`--resume`). This is the fallback path described in spec 12.3.1; it is used
 * unconditionally for now because it survives CLI versions that do not stream stdin.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly capabilities = CAPABILITIES;

  readonly #command: string;
  readonly #executablePath: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly defaultModel: string | undefined;
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: ClaudeProviderOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#executablePath = options.executablePath;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
    this.defaultModel = options.defaultModel;
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
        message: detection.reason ?? "claude was not found",
        details: { providerId: this.id },
      });
    }

    const handle: ProviderSessionHandle = {
      sessionId: options.sessionId,
      providerId: this.id,
      ...(options.resumeToken ? { nativeSessionId: options.resumeToken } : {}),
    };

    this.#sessions.set(options.sessionId, { handle, options, runner: undefined, tempDir: undefined });
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

    const mcpConfigPath = await this.#writeMcpConfig(session);
    const args = this.#buildArgs(session, message, mcpConfigPath);

    const parser = new StreamParser();
    let sawResult = false;

    const handleLine = (raw: string): void => {
      for (const line of parser.push(raw)) {
        if (!line.ok) {
          // A format change must be visible, not silently swallowed (spec 12.2).
          emit({
            type: "error",
            error: {
              code: "AB-1004",
              message: `unparsable line from claude: ${line.error}`,
              details: { raw: line.raw.slice(0, 200) },
              retryable: true,
            },
            fatal: false,
          });
          continue;
        }

        const parsed = parseClaudeLine(line.value);
        if (parsed.nativeSessionId) session.handle.nativeSessionId = parsed.nativeSessionId;
        for (const event of parsed.events) emit(event);
        if (parsed.done) sawResult = true;
      }
    };

    const runner = new ProcessRunner({
      command: this.#executablePath ?? this.#command,
      args,
      ...(session.options.workingDirectory ? { cwd: session.options.workingDirectory } : {}),
      ...(session.options.env ? { env: session.options.env } : {}),
      onStdout: handleLine,
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
      handleLine("");
      for (const line of parser.flush()) {
        if (line.ok) {
          const parsed = parseClaudeLine(line.value);
          if (parsed.nativeSessionId) session.handle.nativeSessionId = parsed.nativeSessionId;
          for (const event of parsed.events) emit(event);
          if (parsed.done) sawResult = true;
        }
      }

      if (signal?.aborted) return;

      if (exit.code !== 0 || !sawResult) {
        throw new AgentBridgeError("AB-1006", {
          message: `claude exited with code ${exit.code ?? "null"}`,
          details: { stderr: exit.stderr.slice(-2000), sawResult },
        });
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      session.runner = undefined;
      await this.#cleanupTemp(session);
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
    await this.#cleanupTemp(session);
    this.#sessions.delete(handle.sessionId);
  }

  #buildArgs(session: SessionRuntime, message: string, mcpConfigPath: string | undefined): string[] {
    const args = ["--print", message, "--output-format", "stream-json", "--verbose"];

    if (session.handle.nativeSessionId) {
      args.push("--resume", session.handle.nativeSessionId);
    }
    const model = session.options.model ?? this.defaultModel;
    if (model) {
      args.push("--model", model);
    }
    if (session.options.systemPrompt) {
      args.push("--append-system-prompt", session.options.systemPrompt);
    }
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    // Claude names MCP tools mcp__<server>__<tool>; naming the server authorizes all of its tools.
    const preauthorized = session.options.preauthorizedMcpServers ?? [];
    if (preauthorized.length > 0) {
      args.push("--allowedTools", ...preauthorized.map((id) => `mcp__${id}`));
    }

    // Undocumented in --help but present in the binary: the CLI calls this MCP tool for every
    // tool call and waits for {behavior, updatedInput|message}.
    const prompt = session.options.permissionPrompt;
    if (prompt) {
      args.push("--permission-prompt-tool", `mcp__${prompt.server.id}__${prompt.toolName}`);
    }

    return args;
  }

  /** Writes a session-scoped MCP config file, the injection path described in spec 12.3.1. */
  async #writeMcpConfig(session: SessionRuntime): Promise<string | undefined> {
    const prompt = session.options.permissionPrompt;
    const servers = [
      ...(session.options.mcpServers ?? []),
      ...(prompt ? [prompt.server] : []),
    ];
    if (servers.length === 0) return undefined;

    const dir = session.tempDir ?? (await mkdtemp(join(tmpdir(), "agentbridge-claude-")));
    session.tempDir = dir;
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: toClaudeMcpConfig(servers) }, null, 2), "utf8");
    return path;
  }

  async #cleanupTemp(session: SessionRuntime): Promise<void> {
    if (!session.tempDir) return;
    await rm(session.tempDir, { recursive: true, force: true });
    session.tempDir = undefined;
  }
}

function toClaudeMcpConfig(servers: ResolvedMcpServer[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((server) => [
      server.id,
      server.transport === "stdio"
        ? {
            command: server.command,
            ...(server.args ? { args: server.args } : {}),
            ...(server.env ? { env: server.env } : {}),
          }
        : {
            type: server.transport === "sse" ? "sse" : "http",
            url: server.url,
            ...(server.headers ? { headers: server.headers } : {}),
          },
    ]),
  );
}
