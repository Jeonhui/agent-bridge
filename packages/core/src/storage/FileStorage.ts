import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import type { AuditRecord, Identified, Repository, Storage } from "./Storage.js";

export interface FileStorageOptions {
  /** Root directory. Defaults to `<dataDir>/state`. */
  dataDir: string;
  /** Reports a quarantined document instead of throwing (spec 20.5). */
  onCorrupt?: (path: string, quarantinedTo: string, error: unknown) => void;
}

/**
 * Writes a document atomically: serialize to a sibling temp file, then rename over the target.
 * A crash mid-write leaves the previous version intact (spec 20.5).
 */
async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

class FileRepository<T extends Identified> implements Repository<T> {
  #cache: Map<string, T> | undefined;
  /** Serializes writes so two concurrent puts cannot interleave a full-file rewrite. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly onCorrupt: FileStorageOptions["onCorrupt"],
  ) {}

  async get(id: string): Promise<T | undefined> {
    return (await this.#load()).get(id);
  }

  async list(): Promise<T[]> {
    return [...(await this.#load()).values()];
  }

  async put(value: T): Promise<void> {
    await this.#mutate((items) => {
      items.set(value.id, value);
    });
  }

  async delete(id: string): Promise<void> {
    await this.#mutate((items) => {
      items.delete(id);
    });
  }

  async #mutate(change: (items: Map<string, T>) => void): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      const items = await this.#load();
      change(items);
      await writeAtomic(this.path, JSON.stringify([...items.values()], null, 2));
    });
    await this.#queue;
  }

  async #load(): Promise<Map<string, T>> {
    if (this.#cache) return this.#cache;

    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      this.#cache = new Map();
      return this.#cache;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array of records");
      this.#cache = new Map((parsed as T[]).map((item) => [item.id, item]));
      return this.#cache;
    } catch (error) {
      // Refusing to boot over one bad file would strand the whole runtime, so quarantine
      // the document and start empty, loudly (spec 20.5).
      const quarantine = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, quarantine).catch(() => undefined);
      this.onCorrupt?.(this.path, quarantine, error);
      this.#cache = new Map();
      return this.#cache;
    }
  }
}

/** JSON-document backend for Local Runtime Mode (spec 20.2). */
export class FileStorage<
  TSession extends Identified = Identified,
  TMcp extends Identified = Identified,
  TRule extends Identified = Identified,
> implements Storage<TSession, TMcp, TRule>
{
  readonly sessions: Repository<TSession>;
  readonly mcpServers: Repository<TMcp>;
  readonly permissionRules: Repository<TRule>;
  readonly #auditDir: string;

  constructor(options: FileStorageOptions) {
    const stateDir = join(options.dataDir, "state");
    this.sessions = new FileRepository<TSession>(join(stateDir, "sessions.json"), options.onCorrupt);
    this.mcpServers = new FileRepository<TMcp>(join(stateDir, "mcp.json"), options.onCorrupt);
    this.permissionRules = new FileRepository<TRule>(
      join(stateDir, "permissions.json"),
      options.onCorrupt,
    );
    this.#auditDir = join(options.dataDir, "audit");
  }

  /** Approvals are append-only and rotate monthly by filename (spec 20.5). */
  async appendApproval(record: AuditRecord): Promise<void> {
    const month = (record.decidedAt ?? new Date().toISOString()).slice(0, 7);
    const path = join(this.#auditDir, `approvals-${month}.jsonl`);
    await mkdir(this.#auditDir, { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async listApprovals(filter: { sessionId?: string; since?: string } = {}): Promise<AuditRecord[]> {
    const months = filter.since ? [filter.since.slice(0, 7)] : await this.#months();
    const records: AuditRecord[] = [];

    for (const month of months) {
      const path = join(this.#auditDir, `approvals-${month}.jsonl`);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as AuditRecord);
        } catch {
          // One unreadable line must not hide the rest of the audit trail.
        }
      }
    }

    return records.filter(
      (record) =>
        (filter.sessionId ? record.sessionId === filter.sessionId : true) &&
        (filter.since ? (record.decidedAt ?? "") >= filter.since : true),
    );
  }

  async #months(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const files = await readdir(this.#auditDir);
      return files
        .map((name) => /^approvals-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1])
        .filter((month): month is string => month !== undefined)
        .sort();
    } catch {
      return [];
    }
  }
}

export function assertWritableDataDir(dataDir: string): void {
  if (!dataDir) {
    throw new AgentBridgeError("AB-6001", { message: "a data directory is required" });
  }
}
