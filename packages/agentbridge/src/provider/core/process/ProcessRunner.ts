import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessRunnerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL. Defaults to 5000ms (spec 21.2). */
  killGraceMs?: number;
  /** Cap on retained stderr, so a chatty process cannot grow memory without bound (spec 26.4). */
  stderrLimit?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** The signals this runner ever sends. A self-contained union keeps NodeJS types out of the public surface. */
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface ProcessExit {
  code: number | null;
  signal: string | null;
  stderr: string;
}

/**
 * Thin wrapper over child_process.spawn.
 *
 * Children always start attached (`detached: false`) so the whole tree is reclaimed when
 * AgentBridge exits and no orphans are left behind (spec 26.4).
 */
export class ProcessRunner {
  readonly #options: ProcessRunnerOptions;
  readonly #stderrLimit: number;
  #child: ChildProcessWithoutNullStreams | undefined;
  #hasExited = false;
  #stderr = "";
  #exited: Promise<ProcessExit> | undefined;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ProcessRunnerOptions) {
    this.#options = options;
    this.#stderrLimit = options.stderrLimit ?? 10 * 1024 * 1024;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /**
   * Whether the process is still alive.
   *
   * Deliberately not based on `child.killed`: that flag only means a signal was delivered, so a
   * process that ignores SIGTERM still reports killed === true and the SIGKILL escalation below
   * would never fire.
   */
  get running(): boolean {
    return this.#child !== undefined && !this.#hasExited;
  }

  start(): void {
    if (this.#child) throw new Error("ProcessRunner has already been started");

    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.#options.env },
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#options.onStdout?.(chunk));
    child.stderr.on("data", (chunk: string) => {
      if (this.#stderr.length < this.#stderrLimit) {
        this.#stderr = (this.#stderr + chunk).slice(0, this.#stderrLimit);
      }
      this.#options.onStderr?.(chunk);
    });

    this.#exited = new Promise<ProcessExit>((resolve) => {
      const finish = (code: number | null, signal: string | null) => {
        this.#hasExited = true;
        if (this.#killTimer) clearTimeout(this.#killTimer);
        resolve({ code, signal, stderr: this.#stderr });
      };
      child.once("exit", finish);
      // spawn failures (ENOENT) never emit "exit", so surface them through the same channel.
      child.once("error", (error) => {
        this.#stderr += `\n${error.message}`;
        finish(null, null);
      });
    });
  }

  write(data: string): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed) {
      throw new Error("cannot write to a process that is not running");
    }
    child.stdin.write(data);
  }

  closeStdin(): void {
    this.#child?.stdin.end();
  }

  /** Sends a signal without waiting. Used by interrupt (spec 25.5). */
  signal(sig: ProcessSignal = "SIGINT"): void {
    if (this.running) this.#child?.kill(sig);
  }

  /** SIGTERM, then SIGKILL after the grace period. Resolves once the process is gone. */
  async stop(): Promise<ProcessExit> {
    if (!this.#child || !this.#exited) {
      return { code: null, signal: null, stderr: this.#stderr };
    }

    if (this.running) {
      this.#child.kill("SIGTERM");
      this.#killTimer = setTimeout(() => {
        if (this.running) this.#child?.kill("SIGKILL");
      }, this.#options.killGraceMs ?? 5_000);
      this.#killTimer.unref?.();
    }

    return this.#exited;
  }

  /** Resolves when the process exits on its own. */
  async wait(): Promise<ProcessExit> {
    if (!this.#exited) throw new Error("ProcessRunner has not been started");
    return this.#exited;
  }
}
