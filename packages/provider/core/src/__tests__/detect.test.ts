import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectExecutable, parseVersion, resolveExecutable } from "../detect.js";
import { BUILTIN_PROVIDERS, listAgents } from "../builtin.js";

describe("parseVersion", () => {
  it("pulls the version out of noisy CLI output", () => {
    assert.equal(parseVersion("claude 1.2.3 (build 99)"), "1.2.3");
    assert.equal(parseVersion("v0.10.0-beta.2\n"), "0.10.0-beta.2");
    assert.equal(parseVersion("no version here"), undefined);
  });
});

describe("resolveExecutable", () => {
  it("finds a binary that exists on PATH", async () => {
    assert.ok(await resolveExecutable("node"));
  });

  it("returns undefined for a binary that does not exist", async () => {
    assert.equal(await resolveExecutable("definitely-not-a-real-binary-xyz"), undefined);
  });
});

describe("detectExecutable", () => {
  it("reports an installed binary with its version and path", async () => {
    const detection = await detectExecutable({ command: "node" });
    assert.equal(detection.available, true);
    assert.match(detection.version ?? "", /^\d+\.\d+\.\d+/);
    assert.ok(detection.executablePath);
  });

  it("reports a missing binary instead of throwing", async () => {
    const detection = await detectExecutable({ command: "definitely-not-a-real-binary-xyz" });
    assert.equal(detection.available, false);
    assert.match(detection.reason ?? "", /not found on PATH/);
  });

  it("reports a failing version probe instead of throwing", async () => {
    const detection = await detectExecutable({ command: "node", versionArgs: ["--not-a-flag"] });
    assert.equal(detection.available, false);
    assert.ok(detection.executablePath, "the path was still resolved");
    assert.match(detection.reason ?? "", /failed/);
  });
});

describe("listAgents (spec chapter 8)", () => {
  it("covers the agent CLIs AgentBridge can actually run", () => {
    assert.deepEqual(
      BUILTIN_PROVIDERS.map((spec) => spec.id),
      ["claude", "codex"],
    );
  });

  it("reports every CLI, installed or not, and never throws", async () => {
    for (const agent of await listAgents()) {
      assert.equal(typeof agent.available, "boolean");
      if (!agent.available) assert.ok(agent.reason, `${agent.id} needs a reason`);
      assert.equal(typeof agent.capabilities.mcp, "boolean");
    }
  });

  it("reports a CLI that does not exist as unavailable with a reason", async () => {
    const [agent] = await listAgents([
      {
        id: "ghost",
        name: "Ghost",
        command: "definitely-not-a-real-binary-xyz",
        capabilities: BUILTIN_PROVIDERS[0]!.capabilities,
      },
    ]);

    assert.equal(agent?.available, false);
    assert.match(agent?.reason ?? "", /not found on PATH/);
  });

  it("does not advertise a CLI without a working adapter", () => {
    // Listing a provider implies AgentBridge can drive it; Gemini currently cannot be driven.
    assert.equal(
      BUILTIN_PROVIDERS.some((spec) => spec.id === "gemini"),
      false,
    );
  });
});
