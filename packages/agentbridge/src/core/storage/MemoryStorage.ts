import type { AuditRecord, Identified, Repository, Storage } from "./Storage.js";

class MemoryRepository<T extends Identified> implements Repository<T> {
  readonly #items = new Map<string, T>();

  async get(id: string): Promise<T | undefined> {
    return this.#items.get(id);
  }

  async list(): Promise<T[]> {
    return [...this.#items.values()];
  }

  async put(value: T): Promise<void> {
    this.#items.set(value.id, value);
  }

  async delete(id: string): Promise<void> {
    this.#items.delete(id);
  }
}

/**
 * Default backend. Nothing survives the host process, which is the right behavior for a library
 * embedded in an application: the app owns its own lifecycle (spec 20.2).
 */
export class MemoryStorage<
  TSession extends Identified = Identified,
  TMcp extends Identified = Identified,
  TRule extends Identified = Identified,
> implements Storage<TSession, TMcp, TRule>
{
  readonly sessions = new MemoryRepository<TSession>();
  readonly mcpServers = new MemoryRepository<TMcp>();
  readonly permissionRules = new MemoryRepository<TRule>();
  readonly #approvals: AuditRecord[] = [];

  async appendApproval(record: AuditRecord): Promise<void> {
    this.#approvals.push(record);
  }

  async listApprovals(filter: { sessionId?: string; since?: string } = {}): Promise<AuditRecord[]> {
    return this.#approvals.filter(
      (record) =>
        (filter.sessionId ? record.sessionId === filter.sessionId : true) &&
        (filter.since ? (record.decidedAt ?? "") >= filter.since : true),
    );
  }
}
