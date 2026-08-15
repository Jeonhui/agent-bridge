#!/usr/bin/env node
// Prints the agent CLIs detected on this machine.
// Usage: pnpm agents [--json]

import { listAgents } from "../packages/provider/core/dist/index.js";

const asJson = process.argv.includes("--json");

const started = Date.now();
const providers = await listAgents();
const elapsedMs = Date.now() - started;

if (asJson) {
  console.log(JSON.stringify({ providers, elapsedMs }, null, 2));
  process.exit(0);
}

const rows = providers.map((p) => ({
  id: p.id,
  name: p.name,
  status: p.available ? "installed" : "missing",
  version: p.version ?? "-",
  path: p.executablePath ?? p.reason ?? "-",
}));

const width = (key) => Math.max(key.length, ...rows.map((r) => String(r[key]).length));
const widths = {
  id: width("id"),
  name: width("name"),
  status: width("status"),
  version: width("version"),
};

const line = (r) =>
  `${String(r.id).padEnd(widths.id)}  ${String(r.name).padEnd(widths.name)}  ` +
  `${String(r.status).padEnd(widths.status)}  ${String(r.version).padEnd(widths.version)}  ${r.path}`;

console.log(line({ id: "ID", name: "NAME", status: "STATUS", version: "VERSION", path: "PATH / REASON" }));
console.log("-".repeat(widths.id + widths.name + widths.status + widths.version + 20));
for (const row of rows) console.log(line(row));

const installed = rows.filter((r) => r.status === "installed").length;
console.log(`\n${installed}/${rows.length} detected in ${elapsedMs}ms`);
