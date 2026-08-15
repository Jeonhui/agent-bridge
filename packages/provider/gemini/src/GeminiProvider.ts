import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBridgeError } from "@agentbridge/core";
import {
  ProcessRunner,
  detectExecutable,
  type AgentProvider,
  type AgentStartOptions,
  type ProviderCapabilities,
  type ProviderDetection,
  type ProviderSessionHandle,
  type ResolvedMcpServer,
  type SendOptions,
} from "@agentbridge/provider-core";

export interface GeminiProviderOptions {
  executablePath?: string;
  command?: string;
  turnTimeoutMs?: number;
  /** Flag used to pass a non-interactive prompt. Defaults to `-p`. */
  promptFlag?: string;
  /** Directory holding the session-scoped settings file. Defaults to a temp directory. */
  settingsDir?: string;
}

interface SessionRuntime {
  handle: ProviderSessionHandle;
  options: AgentStartOptions;
  runner: ProcessRunner | undefined;
  tempDir: string | undefined;
  /** Replayed as context because the CLI has no resume in this mode. */
  history: string[];
}

/**
 * Gemini CLI adapter, written to the conservative path in spec 12.3.2.
 *
 * It assumes only plain text on stdout: the prompt goes in through the non-interactive flag and
 * whatever comes back becomes one message at turn end. No structured event schema is assumed,
 * because a schema guessed rather than captured is exactly the failure mode risk R1 describes.
 *
 * The consequences are declared rather than hidden:
 *   `streaming: false`  the answer arrives whole, not in deltas
 *   `resume: false`     continuity is replayed history, not a CLI session id
 *
 * The flag names below were not verified against a live install. `detect()` still reports the
 * version, so an integrator can confirm them; `promptFlag` exists to correct the one that matters.
 */
export class GeminiProvider implements AgentProvider {
  readonly id = "gemini";
  readonly name = "Gemini CLI";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    mcp: true,
    resume: false,
    interrupt: true,
    workingDirectory: true,
    permissionHook: false,
  };

  readonly #command: string;
  readonly #executablePath: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly #promptFlag: string;
  readonly #settingsDir: string | undefined;
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: GeminiProviderOptions = {}) {
    this.#command = options.command ?? "gemini";
    this.#executablePath = options.executablePath;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
    this.#promptFlag = options.promptFlag ?? "-p";
    this.#settingsDir = options.settingsDir;
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
        message: detection.reason ?? "gemini was not found",
        details: { providerId: this.id },
      });
    }

    const handle: ProviderSessionHandle = { sessionId: options.sessionId, providerId: this.id };
    this.#sessions.set(options.sessionId, {
      handle,
      options,
      runner: undefined,
      tempDir: undefined,
      history: [],
    });
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

    const settingsPath = await this.#writeSettings(session);
    let output = "";

    const runner = new ProcessRunner({
      command: this.#executablePath ?? this.#command,
      args: this.#buildArgs(session, message, settingsPath),
      ...(session.options.workingDirectory ? { cwd: session.options.workingDirectory } : {}),
      ...(session.options.env ? { env: session.options.env } : {}),
      onStdout: (chunk) => {
        output += chunk;
      },
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

      if (signal?.aborted) return;

      if (exit.code !== 0) {
        throw new AgentBridgeError("AB-1006", {
          message: `gemini exited with code ${exit.code ?? "null"}`,
          details: { stderr: exit.stderr.slice(-2000) },
        });
      }

      const answer = output.trim();
      if (answer === "") {
        throw new AgentBridgeError("AB-1004", {
          message: "gemini produced no output",
          details: { stderr: exit.stderr.slice(-2000) },
        });
      }

      emit({ type: "message", role: "assistant", content: answer, delta: false, done: true });
      session.history.push(`User: ${message}`, `Assistant: ${answer}`);
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

  #buildArgs(session: SessionRuntime, message: string, settingsPath: string | undefined): string[] {
    const args: string[] = [];

    if (session.options.model) args.push("-m", session.options.model);
    if (settingsPath) args.push("--settings", settingsPath);

    args.push(this.#promptFlag, buildPrompt(session, message));
    return args;
  }

  /** Writes the session-scoped MCP settings the CLI reads (spec 12.3.2). */
  async #writeSettings(session: SessionRuntime): Promise<string | undefined> {
    const servers = session.options.mcpServers ?? [];
    if (servers.length === 0) return undefined;

    const dir =
      session.tempDir ??
      this.#settingsDir ??
      (await mkdtemp(join(tmpdir(), "agentbridge-gemini-")));
    session.tempDir = dir;

    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          mcpServers: toGeminiMcpConfig(servers),
          // Only the servers this session bound may be reached, so an unrelated server
          // registered elsewhere cannot leak into it.
          allowMCPServers: servers.map((server) => server.id),
        },
        null,
        2,
      ),
      "utf8",
    );
    return path;
  }

  async #cleanupTemp(session: SessionRuntime): Promise<void> {
    if (!session.tempDir || this.#settingsDir) return;
    await rm(session.tempDir, { recursive: true, force: true });
    session.tempDir = undefined;
  }
}

/**
 * Builds the prompt for a turn.
 *
 * Without CLI-side resume, earlier turns are replayed as plain context. That is the documented
 * fallback in spec 12.3.2 and the reason `capabilities.resume` is false.
 */
export function buildPrompt(session: { history: string[] }, message: string): string {
  if (session.history.length === 0) return message;
  return `${session.history.join("\n")}\nUser: ${message}`;
}

export function toGeminiMcpConfig(servers: ResolvedMcpServer[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((server) => [
      server.id,
      server.transport === "stdio"
        ? {
            command: server.command,
            ...(server.args ? { args: server.args } : {}),
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(server.env ? { env: server.env } : {}),
          }
        : {
            ...(server.transport === "sse" ? { url: server.url } : { httpUrl: server.url }),
            ...(server.headers ? { headers: server.headers } : {}),
          },
    ]),
  );
}
