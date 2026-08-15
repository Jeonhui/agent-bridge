export interface Identified {
  id: string;
}

export interface Repository<T extends Identified> {
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  put(value: T): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface AuditRecord extends Identified {
  sessionId: string;
  decidedAt?: string;
  [key: string]: unknown;
}

/**
 * Persistence seam (spec 20.2).
 *
 * Managers depend on this interface rather than a backend, so swapping storage stays local.
 * The MVP ships memory and file backends; a database would slot in here unchanged.
 */
export interface Storage<
  TSession extends Identified = Identified,
  TMcp extends Identified = Identified,
  TRule extends Identified = Identified,
> {
  sessions: Repository<TSession>;
  mcpServers: Repository<TMcp>;
  permissionRules: Repository<TRule>;
  appendApproval(record: AuditRecord): Promise<void>;
  listApprovals(filter?: { sessionId?: string; since?: string }): Promise<AuditRecord[]>;
  close?(): Promise<void>;
}
