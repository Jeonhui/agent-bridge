import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "../../../core/index.js";

import type { AgentProvider, ProviderCapabilities, ProviderDetection } from "../AgentProvider.js";
import { ProviderManager } from "../ProviderManager.js";

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  mcp: true,
  resume: true,
  interrupt: true,
  workingDirectory: true,
  permissionHook: false,
};

function fakeProvider(id: string, detect: () => Promise<ProviderDetection>): AgentProvider {
  return {
    id,
    name: id,
    capabilities: CAPABILITIES,
    detect,
    start: async () => ({ sessionId: "s", providerId: id }),
    send: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  };
}

describe("ProviderManager (spec 10.2 / chapter 8)", () => {
  it("looking up an unknown id is AB-1001", () => {
    const manager = new ProviderManager();
    assert.throws(
      () => manager.get("nope"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-1001",
    );
  });

  it("lists uninstalled providers with available:false and a reason", async () => {
    const manager = new ProviderManager();
    manager.register(fakeProvider("claude", async () => ({ available: true, version: "1.2.3" })));
    manager.register(
      fakeProvider("gemini", async () => ({ available: false, reason: "not on PATH" })),
    );

    const list = await manager.list();
    assert.deepEqual(
      list.map((p) => [p.id, p.available, p.reason ?? null]),
      [
        ["claude", true, null],
        ["gemini", false, "not on PATH"],
      ],
    );
  });

  it("an adapter throwing in detect() does not abort the sweep", async () => {
    const manager = new ProviderManager();
    manager.register(
      fakeProvider("broken", async () => {
        throw new Error("executable is corrupt");
      }),
    );
    manager.register(fakeProvider("ok", async () => ({ available: true })));

    const list = await manager.list();
    assert.equal(list.length, 2);
    assert.equal(list.find((p) => p.id === "broken")?.available, false);
    assert.equal(list.find((p) => p.id === "broken")?.reason, "executable is corrupt");
    assert.equal(list.find((p) => p.id === "ok")?.available, true);
  });

  it("an adapter that hangs is resolved by the timeout", async () => {
    const manager = new ProviderManager({ detectTimeoutMs: 20 });
    manager.register(fakeProvider("hang", () => new Promise<ProviderDetection>(() => {})));

    const detection = await manager.detect("hang");
    assert.equal(detection.available, false);
    assert.match(detection.reason ?? "", /timed out/);
  });

  it("caches detection for the TTL and invalidate clears it", async () => {
    let calls = 0;
    const manager = new ProviderManager();
    manager.register(
      fakeProvider("counted", async () => {
        calls += 1;
        return { available: true };
      }),
    );

    await manager.detect("counted");
    await manager.detect("counted");
    assert.equal(calls, 1, "no re-detection within the TTL");

    manager.invalidate("counted");
    await manager.detect("counted");
    assert.equal(calls, 2);

    await manager.detect("counted", { refresh: true });
    assert.equal(calls, 3, "refresh bypasses the cache");
  });
});

describe("ProviderManager regressions", () => {
  it("reports a duplicate registration as AB-1007, not AB-1001", () => {
    const manager = new ProviderManager();
    manager.register(fakeProvider("claude", async () => ({ available: true })));

    assert.throws(
      () => manager.register(fakeProvider("claude", async () => ({ available: true }))),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-1007",
    );
  });

  it("collapses concurrent detections into one adapter call", async () => {
    let calls = 0;
    const manager = new ProviderManager();
    manager.register(
      fakeProvider("p", async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { available: true };
      }),
    );

    await Promise.all([manager.detect("p"), manager.detect("p"), manager.detect("p")]);
    assert.equal(calls, 1);
  });

  it("expires a failed detection quickly so a freshly installed CLI is seen", async () => {
    let installed = false;
    const manager = new ProviderManager({ failedDetectionTtlMs: 10 });
    manager.register(
      fakeProvider("q", async () =>
        installed ? { available: true } : { available: false, reason: "not yet" },
      ),
    );

    assert.equal((await manager.detect("q")).available, false);
    installed = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.detect("q")).available, true);
  });

  it("keeps a successful detection cached for the full TTL", async () => {
    let calls = 0;
    const manager = new ProviderManager({ failedDetectionTtlMs: 10 });
    manager.register(
      fakeProvider("r", async () => {
        calls += 1;
        return { available: true };
      }),
    );

    await manager.detect("r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.detect("r");
    assert.equal(calls, 1);
  });
});
