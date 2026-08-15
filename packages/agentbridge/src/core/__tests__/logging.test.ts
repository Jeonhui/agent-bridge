import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import { Logger, type LogRecord } from "../logging/Logger.js";
import {
  REDACTED,
  abbreviatePath,
  digest,
  redact,
  summarizeArguments,
  summarizeContent,
} from "../logging/redaction.js";

describe("redaction (spec 27.3)", () => {
  it("masks secret-looking keys wherever they appear", () => {
    const masked = redact({
      apiKey: "sk-live-123",
      nested: { authorization: "Bearer x", safe: "keep" },
      list: [{ password: "hunter2" }],
    }) as {
      apiKey: string;
      nested: { authorization: string; safe: string };
      list: Array<{ password: string }>;
    };

    assert.equal(masked.apiKey, REDACTED);
    assert.equal(masked.nested.authorization, REDACTED);
    assert.equal(masked.nested.safe, "keep");
    assert.equal(masked.list[0]?.password, REDACTED);
  });

  it("matches the documented key patterns case-insensitively", () => {
    for (const key of ["token", "TOKEN", "api_key", "API-KEY", "Cookie", "credential", "secret"]) {
      const masked = redact({ [key]: "x" }) as Record<string, unknown>;
      assert.equal(masked[key], REDACTED, `${key} should be redacted`);
    }
  });

  it("abbreviates the home directory", () => {
    assert.equal(abbreviatePath(`${homedir()}/projects/a`), "~/projects/a");
    assert.equal(abbreviatePath("/etc/hosts"), "/etc/hosts");
  });

  it("cuts cycles instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    assert.deepEqual(redact(cyclic), { name: "root", self: "[circular]" });
  });

  it("digests are stable and short", () => {
    assert.equal(digest("abc"), digest("abc"));
    assert.notEqual(digest("abc"), digest("abd"));
    assert.match(digest("abc"), /^sha256:[0-9a-f]{16}$/);
  });
});

describe("summaries (spec 27.3)", () => {
  it("withholds argument values by default", () => {
    const summary = summarizeArguments({ path: "/tmp/a", content: "secret body" });
    assert.deepEqual(summary.keys, ["path", "content"]);
    assert.match(summary.argsDigest, /^sha256:/);
    assert.equal("values" in summary, false);
  });

  it("includes redacted values only when asked", () => {
    const summary = summarizeArguments({ path: "/tmp/a", token: "abc" }, { includeValues: true });
    assert.deepEqual(summary.values, { path: "/tmp/a", token: REDACTED });
  });

  it("reduces message bodies to a length and a digest", () => {
    const summary = summarizeContent("hello world");
    assert.deepEqual(Object.keys(summary).sort(), ["contentDigest", "length"]);
    assert.equal(summary.length, 11);
  });
});

describe("Logger (spec 27.4)", () => {
  function capture(level?: "trace" | "debug" | "info" | "warn" | "error") {
    const records: LogRecord[] = [];
    const logger = new Logger({
      ...(level ? { level } : {}),
      sink: (record) => records.push(record),
    });
    return { logger, records };
  }

  it("emits a structured record with a timestamp", () => {
    const { logger, records } = capture();
    logger.info("session.created", { sessionId: "s1" });

    assert.equal(records[0]?.event, "session.created");
    assert.equal(records[0]?.level, "info");
    assert.equal(records[0]?.["sessionId"], "s1");
    assert.ok(Date.parse(String(records[0]?.ts)) > 0);
  });

  it("drops records below the configured level", () => {
    const { logger, records } = capture("warn");
    logger.info("ignored");
    logger.debug("ignored");
    logger.warn("kept");
    logger.error("kept");

    assert.deepEqual(records.map((r) => r.event), ["kept", "kept"]);
  });

  it("defaults to info, so trace and debug stay off", () => {
    const { logger, records } = capture();
    logger.trace("no");
    logger.debug("no");
    logger.info("yes");

    assert.deepEqual(records.map((r) => r.event), ["yes"]);
  });

  it("redacts fields even when the caller does not", () => {
    const { logger, records } = capture();
    logger.info("mcp.connected", { env: { GITHUB_TOKEN: "ghp_secret" } });

    assert.deepEqual(records[0]?.["env"], { GITHUB_TOKEN: REDACTED });
  });

  it("a child logger carries its base fields", () => {
    const { logger, records } = capture();
    logger.child({ traceId: "t1" }).info("tool.called", { toolId: "mcp:fs:read" });

    assert.equal(records[0]?.["traceId"], "t1");
    assert.equal(records[0]?.["toolId"], "mcp:fs:read");
  });
});
