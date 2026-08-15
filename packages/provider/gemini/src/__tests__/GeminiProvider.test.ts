import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AgentBridgeError, type AgentEventPayload } from "@agentbridge/core";

import { GeminiProvider, buildPrompt, toGeminiMcpConfig } from "../GeminiProvider.js";

// dist/__tests__ -> dist -> package root
const FAKE = new URL("../../fixtures/fake-gemini.mjs", import.meta.url).pathname;

function provider(mode: string, argsFile?: string): GeminiProvider {
  process.env["FAKE_GEMINI_MODE"] = mode;
  if (argsFile) process.env["FAKE_GEMINI_ARGS_FILE"] = argsFile;
  else delete process.env["FAKE_GEMINI_ARGS_FILE"];

  return new GeminiProvider({ command: FAKE, executablePath: FAKE });
}

/**
 * The real CLI is not installed here, so the fake stands in. What this verifies is the adapter's
 * own behaviour - argument assembly, output handling, history replay, settings injection - not the
 * CLI's flag names, which still need confirming against a live install.
 */
async function turn(
  p: GeminiProvider,
  message: string,
  handle: { sessionId: string; providerId: string },
): Promise<AgentEventPayload[]> {
  const events: AgentEventPayload[] = [];
  await p.send(handle, message, { emit: (event) => events.push(event) });
  return events;
}

describe("buildPrompt (spec 12.3.2 fallback)", () => {
  it("sends the message alone on the first turn", () => {
    assert.equal(buildPrompt({ history: [] }, "hello"), "hello");
  });

  it("replays history on later turns, since the CLI has no resume here", () => {
    assert.equal(
      buildPrompt({ history: ["User: a", "Assistant: b"] }, "c"),
      "User: a\nAssistant: b\nUser: c",
    );
  });
});

describe("toGeminiMcpConfig", () => {
  it("maps a stdio server", () => {
    assert.deepEqual(
      toGeminiMcpConfig([
        { id: "fs", transport: "stdio", command: "node", args: ["fs.js"], env: { A: "1" } },
      ]),
      { fs: { command: "node", args: ["fs.js"], env: { A: "1" } } },
    );
  });

  it("distinguishes sse from streamable http", () => {
    assert.deepEqual(toGeminiMcpConfig([{ id: "a", transport: "sse", url: "https://x/sse" }]), {
      a: { url: "https://x/sse" },
    });
    assert.deepEqual(
      toGeminiMcpConfig([{ id: "b", transport: "streamable-http", url: "https://x/mcp" }]),
      { b: { httpUrl: "https://x/mcp" } },
    );
  });
});

describe("GeminiProvider", () => {
  it("declares the limits of the text-mode path rather than overstating them", () => {
    const capabilities = new GeminiProvider().capabilities;
    assert.equal(capabilities.streaming, false);
    assert.equal(capabilities.resume, false);
    assert.equal(capabilities.mcp, true);
  });

  it("returns the CLI output as one completed message", async () => {
    const p = provider("reply");
    const handle = await p.start({ sessionId: "s1" });
    const events = await turn(p, "hello", handle);

    assert.deepEqual(events, [
      { type: "message", role: "assistant", content: "answer to: hello", delta: false, done: true },
    ]);
    await p.stop(handle);
  });

  it("replays history so a second turn carries the first", async () => {
    const argsFile = join(await mkdtemp(join(tmpdir(), "gemini-args-")), "args.json");
    const p = provider("reply", argsFile);
    const handle = await p.start({ sessionId: "s2" });

    await turn(p, "first", handle);
    await turn(p, "second", handle);

    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    const prompt = args[args.indexOf("-p") + 1]!;
    assert.match(prompt, /User: first/);
    assert.match(prompt, /Assistant: answer to: first/);
    assert.ok(prompt.endsWith("User: second"));
    await p.stop(handle);
  });

  it("passes the model through", async () => {
    const argsFile = join(await mkdtemp(join(tmpdir(), "gemini-args-")), "args.json");
    const p = provider("reply", argsFile);
    const handle = await p.start({ sessionId: "s3", model: "gemini-2.5-pro" });
    await turn(p, "hi", handle);

    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 2), ["-m", "gemini-2.5-pro"]);
    await p.stop(handle);
  });

  it("writes a session-scoped settings file limited to the bound servers", async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), "gemini-settings-"));
    process.env["FAKE_GEMINI_MODE"] = "reply";
    delete process.env["FAKE_GEMINI_ARGS_FILE"];

    const p = new GeminiProvider({ command: FAKE, executablePath: FAKE, settingsDir });
    const handle = await p.start({
      sessionId: "s4",
      mcpServers: [{ id: "fs", transport: "stdio", command: "node", args: ["fs.js"] }],
    });
    await turn(p, "hi", handle);

    const settings = JSON.parse(
      await readFile(join(settingsDir, "settings.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown>; allowMCPServers: string[] };

    assert.deepEqual(Object.keys(settings.mcpServers), ["fs"]);
    assert.deepEqual(settings.allowMCPServers, ["fs"]);
    await p.stop(handle);
  });

  it("writes no settings file when the session binds no MCP servers", async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), "gemini-settings-"));
    process.env["FAKE_GEMINI_MODE"] = "reply";

    const p = new GeminiProvider({ command: FAKE, executablePath: FAKE, settingsDir });
    const handle = await p.start({ sessionId: "s5" });
    await turn(p, "hi", handle);

    assert.deepEqual(await readdir(settingsDir), []);
    await p.stop(handle);
  });

  it("reports a non-zero exit as AB-1006 carrying the stderr tail", async () => {
    const p = provider("fail");
    const handle = await p.start({ sessionId: "s6" });

    await assert.rejects(
      () => turn(p, "hi", handle),
      (error: unknown) =>
        error instanceof AgentBridgeError &&
        error.code === "AB-1006" &&
        /upstream refused/.test(JSON.stringify(error.details)),
    );
    await p.stop(handle);
  });

  it("reports empty output as AB-1004 instead of an empty message", async () => {
    const p = provider("empty");
    const handle = await p.start({ sessionId: "s7" });

    await assert.rejects(
      () => turn(p, "hi", handle),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-1004",
    );
    await p.stop(handle);
  });

  it("interrupt ends a hanging turn without emitting a message", async () => {
    const p = provider("hang");
    const handle = await p.start({ sessionId: "s8" });

    const controller = new AbortController();
    const events: AgentEventPayload[] = [];
    const pending = p.send(handle, "hi", { emit: (e) => events.push(e), signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await pending;

    assert.deepEqual(events, []);
    await p.stop(handle);
  });

  it("interrupt with no running turn is AB-3006", async () => {
    const p = provider("reply");
    const handle = await p.start({ sessionId: "s9" });

    await assert.rejects(
      () => p.interrupt(handle),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3006",
    );
    await p.stop(handle);
  });

  it("sending to an unknown session is AB-3004", async () => {
    const p = provider("reply");
    await assert.rejects(
      () => turn(p, "hi", { sessionId: "missing", providerId: "gemini" }),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-3004",
    );
  });
});
