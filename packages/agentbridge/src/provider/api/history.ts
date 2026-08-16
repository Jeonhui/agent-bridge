import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiMessage } from "./base.js";

/**
 * Where an API provider keeps each session's replay history (spec 12.5).
 *
 * This is provider-internal state - the exact wire conversation the next turn replays,
 * tool calls and results included - not a transcript for the host's UI: hosts get their
 * transcript from the event stream. Configuring a store is what turns `capabilities.resume`
 * on, because with one the conversation survives a process restart.
 */
export interface ApiHistoryStore {
  load(sessionId: string): Promise<ApiMessage[] | undefined>;
  save(sessionId: string, history: ApiMessage[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface FileHistoryStoreOptions {
  /** Directory for the history files, e.g. `~/.agentbridge/api-history`. Created on demand. */
  directory: string;
}

/** One JSON file per session, written atomically (temp + rename). */
export class FileHistoryStore implements ApiHistoryStore {
  readonly #directory: string;

  constructor(options: FileHistoryStoreOptions) {
    this.#directory = options.directory;
  }

  async load(sessionId: string): Promise<ApiMessage[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#path(sessionId), "utf8");
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as { messages?: ApiMessage[] };
      return Array.isArray(parsed.messages) ? parsed.messages : undefined;
    } catch {
      // A corrupt file is quarantined rather than fatal (spec 28.3): the session resumes
      // fresh, and the bytes stay on disk for diagnosis.
      await rename(this.#path(sessionId), `${this.#path(sessionId)}.corrupt`).catch(() => undefined);
      return undefined;
    }
  }

  async save(sessionId: string, history: ApiMessage[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const path = this.#path(sessionId);
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, messages: history }), "utf8");
    await rename(temp, path);
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.#path(sessionId), { force: true });
  }

  #path(sessionId: string): string {
    // Session ids are UUIDs the core mints, but sanitize anyway: a file name is an interface.
    return join(this.#directory, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }
}
