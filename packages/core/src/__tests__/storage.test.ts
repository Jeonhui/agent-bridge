import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileStorage } from "../storage/FileStorage.js";
import { MemoryStorage } from "../storage/MemoryStorage.js";
import type { Storage } from "../storage/Storage.js";

interface Row {
  id: string;
  value?: string;
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentbridge-storage-"));
}

function contract(name: string, create: () => Promise<Storage<Row, Row, Row>>) {
  describe(`${name} (spec 20.2)`, () => {
    it("round-trips a record", async () => {
      const storage = await create();
      await storage.sessions.put({ id: "a", value: "one" });

      assert.deepEqual(await storage.sessions.get("a"), { id: "a", value: "one" });
      assert.deepEqual(await storage.sessions.list(), [{ id: "a", value: "one" }]);
    });

    it("overwrites on put and removes on delete", async () => {
      const storage = await create();
      await storage.sessions.put({ id: "a", value: "one" });
      await storage.sessions.put({ id: "a", value: "two" });
      assert.equal((await storage.sessions.get("a"))?.value, "two");

      await storage.sessions.delete("a");
      assert.equal(await storage.sessions.get("a"), undefined);
      assert.deepEqual(await storage.sessions.list(), []);
    });

    it("keeps repositories independent", async () => {
      const storage = await create();
      await storage.sessions.put({ id: "a" });
      await storage.mcpServers.put({ id: "b" });
      await storage.permissionRules.put({ id: "c" });

      assert.deepEqual((await storage.sessions.list()).map((r) => r.id), ["a"]);
      assert.deepEqual((await storage.mcpServers.list()).map((r) => r.id), ["b"]);
      assert.deepEqual((await storage.permissionRules.list()).map((r) => r.id), ["c"]);
    });

    it("returns undefined for an unknown id rather than throwing", async () => {
      assert.equal(await (await create()).sessions.get("nope"), undefined);
    });

    it("appends approvals and filters them by session", async () => {
      const storage = await create();
      await storage.appendApproval({ id: "r1", sessionId: "s1", decidedAt: "2026-08-15T00:00:00.000Z" });
      await storage.appendApproval({ id: "r2", sessionId: "s2", decidedAt: "2026-08-15T00:00:01.000Z" });

      assert.equal((await storage.listApprovals()).length, 2);
      assert.deepEqual((await storage.listApprovals({ sessionId: "s1" })).map((r) => r.id), ["r1"]);
    });
  });
}

contract("MemoryStorage", async () => new MemoryStorage<Row, Row, Row>());
contract("FileStorage", async () => new FileStorage<Row, Row, Row>({ dataDir: await scratch() }));

describe("FileStorage durability (spec 20.5)", () => {
  it("survives a reopen", async () => {
    const dataDir = await scratch();
    const first = new FileStorage<Row, Row, Row>({ dataDir });
    await first.sessions.put({ id: "a", value: "kept" });

    const second = new FileStorage<Row, Row, Row>({ dataDir });
    assert.equal((await second.sessions.get("a"))?.value, "kept");
  });

  it("writes state documents owner-only", async () => {
    const dataDir = await scratch();
    const storage = new FileStorage<Row, Row, Row>({ dataDir });
    await storage.sessions.put({ id: "a" });

    const mode = (await stat(join(dataDir, "state", "sessions.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("leaves no temp file behind after an atomic write", async () => {
    const dataDir = await scratch();
    const storage = new FileStorage<Row, Row, Row>({ dataDir });
    await storage.sessions.put({ id: "a" });

    const files = await readdir(join(dataDir, "state"));
    assert.deepEqual(files, ["sessions.json"]);
  });

  it("quarantines a corrupt document instead of refusing to start", async () => {
    const dataDir = await scratch();
    const path = join(dataDir, "state", "sessions.json");
    const pre = new FileStorage<Row, Row, Row>({ dataDir });
    await pre.sessions.put({ id: "a" });
    await writeFile(path, "{ this is not json", "utf8");

    const quarantined: string[] = [];
    const storage = new FileStorage<Row, Row, Row>({
      dataDir,
      onCorrupt: (_path, to) => quarantined.push(to),
    });

    assert.deepEqual(await storage.sessions.list(), [], "starts from empty");
    assert.equal(quarantined.length, 1);
    assert.match(await readFile(quarantined[0]!, "utf8"), /this is not json/);
  });

  it("serializes concurrent writes so none are lost", async () => {
    const dataDir = await scratch();
    const storage = new FileStorage<Row, Row, Row>({ dataDir });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => storage.sessions.put({ id: `s${i}` })),
    );

    assert.equal((await storage.sessions.list()).length, 20);
  });

  it("rotates the approval log monthly", async () => {
    const dataDir = await scratch();
    const storage = new FileStorage<Row, Row, Row>({ dataDir });

    await storage.appendApproval({ id: "r1", sessionId: "s1", decidedAt: "2026-07-31T23:59:59.000Z" });
    await storage.appendApproval({ id: "r2", sessionId: "s1", decidedAt: "2026-08-01T00:00:00.000Z" });

    const files = (await readdir(join(dataDir, "audit"))).sort();
    assert.deepEqual(files, ["approvals-2026-07.jsonl", "approvals-2026-08.jsonl"]);
    assert.equal((await storage.listApprovals()).length, 2);
  });

  it("skips an unreadable audit line instead of losing the whole trail", async () => {
    const dataDir = await scratch();
    const storage = new FileStorage<Row, Row, Row>({ dataDir });
    await storage.appendApproval({ id: "r1", sessionId: "s1", decidedAt: "2026-08-15T00:00:00.000Z" });

    const path = join(dataDir, "audit", "approvals-2026-08.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}broken line\n`, "utf8");

    assert.deepEqual((await storage.listApprovals()).map((r) => r.id), ["r1"]);
  });
});
