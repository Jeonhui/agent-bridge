import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProcessRunner } from "../process/ProcessRunner.js";

const NODE = process.execPath;

describe("ProcessRunner", () => {
  it("streams stdout and reports a clean exit", async () => {
    const chunks: string[] = [];
    const runner = new ProcessRunner({
      command: NODE,
      args: ["-e", "process.stdout.write('hello\\n')"],
      onStdout: (chunk) => chunks.push(chunk),
    });

    runner.start();
    const exit = await runner.wait();

    assert.equal(exit.code, 0);
    assert.equal(chunks.join(""), "hello\n");
  });

  it("captures stderr and a non-zero exit code", async () => {
    const runner = new ProcessRunner({
      command: NODE,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
    });

    runner.start();
    const exit = await runner.wait();

    assert.equal(exit.code, 3);
    assert.match(exit.stderr, /boom/);
  });

  it("reports a spawn failure instead of hanging", async () => {
    const runner = new ProcessRunner({ command: "definitely-not-a-real-binary-xyz", args: [] });

    runner.start();
    const exit = await runner.wait();

    assert.equal(exit.code, null);
    assert.match(exit.stderr, /ENOENT/);
  });

  it("writes to stdin and sees the echo", async () => {
    const chunks: string[] = [];
    const runner = new ProcessRunner({
      command: NODE,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      onStdout: (chunk) => chunks.push(chunk),
    });

    runner.start();
    runner.write("ping\n");
    runner.closeStdin();
    await runner.wait();

    assert.equal(chunks.join(""), "ping\n");
  });

  it("stop() terminates a long-running process", async () => {
    const runner = new ProcessRunner({
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    runner.start();
    assert.equal(runner.running, true);
    const exit = await runner.stop();

    assert.equal(runner.running, false);
    assert.ok(exit.signal !== null || exit.code !== null);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    let ready: () => void;
    const armed = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const runner = new ProcessRunner({
      command: NODE,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('armed\\n'); setInterval(() => {}, 1000)",
      ],
      killGraceMs: 50,
      onStdout: () => ready(),
    });

    runner.start();
    await armed; // stop() before the handler is installed would race and die to SIGTERM

    const exit = await runner.stop();
    assert.equal(exit.signal, "SIGKILL");
  });

  it("caps retained stderr", async () => {
    const runner = new ProcessRunner({
      command: NODE,
      args: ["-e", "process.stderr.write('x'.repeat(5000))"],
      stderrLimit: 100,
    });

    runner.start();
    const exit = await runner.wait();
    assert.equal(exit.stderr.length, 100);
  });

  it("refuses to start twice", () => {
    const runner = new ProcessRunner({ command: NODE, args: ["-e", ""] });
    runner.start();
    assert.throws(() => runner.start(), /already been started/);
  });
});
