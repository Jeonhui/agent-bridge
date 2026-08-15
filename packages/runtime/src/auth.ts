import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface RuntimeCredentials {
  token: string;
  port: number;
  pid: number;
  startedAt: string;
}

export function generateToken(): string {
  return `ab_local_${randomBytes(24).toString("hex")}`;
}

export function credentialsPath(dataDir = join(homedir(), ".agentbridge")): string {
  return join(dataDir, "runtime.json");
}

/** Writes the local token with owner-only permissions (spec 16.1, 26.2). */
export async function writeCredentials(path: string, credentials: RuntimeCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readCredentials(path: string): Promise<RuntimeCredentials | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RuntimeCredentials;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time comparison so a caller cannot learn the token one character at a time
 * by measuring how long a rejection takes.
 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided || provided.length !== expected.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

export function extractToken(headers: Record<string, string | string[] | undefined>, url: URL): string | undefined {
  const header = headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value?.startsWith("Bearer ")) return value.slice("Bearer ".length);
  return url.searchParams.get("token") ?? undefined;
}
