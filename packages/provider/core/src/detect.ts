import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import type { ProviderDetection } from "./AgentProvider.js";

export interface DetectExecutableOptions {
  /** Executable name to look for, e.g. "claude". */
  command: string;
  /** Arguments used to read the version. Defaults to ["--version"]. */
  versionArgs?: string[];
  /** Absolute path that skips PATH resolution entirely. */
  executablePath?: string;
  /** Extra directories searched after PATH, for installers that do not update the shell profile. */
  extraPaths?: string[];
  /** Deadline for the version probe. Defaults to 3000ms. */
  timeoutMs?: number;
}

/** Directories where agent CLIs commonly land even when PATH was not updated. */
function defaultExtraPaths(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".npm-global", "bin"),
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves an executable against PATH and the common install directories. */
export async function resolveExecutable(
  command: string,
  extraPaths: string[] = defaultExtraPaths(),
): Promise<string | undefined> {
  if (isAbsolute(command)) {
    return (await isExecutable(command)) ? command : undefined;
  }

  const pathEnv = process.env["PATH"] ?? "";
  const candidates = [...pathEnv.split(delimiter).filter(Boolean), ...extraPaths];
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

  for (const dir of candidates) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      if (await isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

/** Extracts the first semver-looking token, since CLIs pad version output with names and build info. */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

/**
 * Runs the version probe for a CLI and reports whether it is usable.
 * Never throws: a failure becomes `available: false` with a reason (spec chapter 8).
 */
export async function detectExecutable(
  options: DetectExecutableOptions,
): Promise<ProviderDetection> {
  const { command, versionArgs = ["--version"], timeoutMs = 3_000 } = options;

  const executablePath =
    options.executablePath ?? (await resolveExecutable(command, options.extraPaths));

  if (!executablePath) {
    return { available: false, reason: `${command} was not found on PATH` };
  }

  return new Promise<ProviderDetection>((resolve) => {
    execFile(
      executablePath,
      versionArgs,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            "killed" in error && error.killed
              ? `${command} --version timed out after ${timeoutMs}ms`
              : `${command} --version failed: ${error.message.split("\n")[0]}`;
          resolve({ available: false, executablePath, reason });
          return;
        }

        const version = parseVersion(`${stdout}\n${stderr}`);
        resolve({
          available: true,
          executablePath,
          ...(version ? { version } : {}),
        });
      },
    );
  });
}
