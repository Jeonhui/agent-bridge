#!/usr/bin/env node
// Stands in for the gemini CLI so the adapter's mechanics can be tested without the real binary.
// FAKE_GEMINI_MODE controls the behaviour: reply (default), empty, fail, hang, echo-args.

import { writeFile } from "node:fs/promises";

const mode = process.env.FAKE_GEMINI_MODE ?? "reply";
const args = process.argv.slice(2);

// A real CLI answers --version whatever else is failing, and the adapter probes it before every
// session. Applying the failure mode here too would break detection instead of the turn.
if (args.includes("--version")) {
  process.stdout.write("gemini 0.9.1\n");
  process.exit(0);
}

if (process.env.FAKE_GEMINI_ARGS_FILE) {
  await writeFile(process.env.FAKE_GEMINI_ARGS_FILE, JSON.stringify(args), "utf8");
}
if (mode === "empty") process.exit(0);
if (mode === "fail") {
  process.stderr.write("upstream refused\n");
  process.exit(2);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  process.stdout.write(`answer to: ${prompt.split("\n").at(-1)}\n`);
}
