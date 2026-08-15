import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StreamParser } from "../process/StreamParser.js";

describe("StreamParser", () => {
  it("parses whole lines", () => {
    const parser = new StreamParser();
    const lines = parser.push('{"a":1}\n{"b":2}\n');
    assert.deepEqual(
      lines.map((l) => (l.ok ? l.value : l.error)),
      [{ a: 1 }, { b: 2 }],
    );
  });

  it("holds a partial line until the rest arrives", () => {
    const parser = new StreamParser();
    assert.deepEqual(parser.push('{"a":'), []);
    assert.equal(parser.pending, '{"a":');
    const lines = parser.push('1}\n');
    assert.deepEqual(lines[0]?.ok ? lines[0].value : undefined, { a: 1 });
  });

  it("survives a chunk boundary in the middle of a multi-byte payload", () => {
    const parser = new StreamParser();
    parser.push('{"text":"caf\u00e9 ');
    const lines = parser.push('\ud83d\ude42"}\n');
    assert.deepEqual(lines[0]?.ok ? lines[0].value : undefined, { text: "caf\u00e9 \ud83d\ude42" });
  });

  it("skips blank lines", () => {
    assert.deepEqual(new StreamParser().push("\n\n  \n"), []);
  });

  it("reports malformed JSON instead of dropping it", () => {
    const [line] = new StreamParser().push("not json\n");
    assert.equal(line?.ok, false);
    assert.equal(line?.ok === false ? line.raw : undefined, "not json");
  });

  it("rejects a bare JSON array or scalar as a line", () => {
    const [line] = new StreamParser().push("[1,2]\n");
    assert.equal(line?.ok, false);
    assert.match(line?.ok === false ? line.error : "", /expected a JSON object/);
  });

  it("flush emits a trailing line that never got a newline", () => {
    const parser = new StreamParser();
    parser.push('{"a":1}');
    const flushed = parser.flush();
    assert.deepEqual(flushed[0]?.ok ? flushed[0].value : undefined, { a: 1 });
    assert.deepEqual(parser.flush(), []);
  });
});
