#!/usr/bin/env node
// A tiny filesystem MCP server, dependency-free, scoped to the directory in argv[2].
// It exists so the chat example is self-contained; real apps would point at their own servers.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? process.cwd());

function safe(path) {
  const target = resolve(join(ROOT, path));
  const rel = relative(ROOT, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes the sandbox: " + path);
  return target;
}

const TOOLS = [
  { name: "list_files", description: "List files in the sandbox directory.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "read_file", description: "Read a file from the sandbox.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true } },
  { name: "write_file", description: "Write a file inside the sandbox.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    annotations: { destructiveHint: true } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

async function call(name, args) {
  if (name === "list_files") return (await readdir(ROOT)).join("\n") || "(empty)";
  if (name === "read_file") return readFile(safe(args.path), "utf8");
  if (name === "write_file") { await writeFile(safe(args.path), args.content, "utf8"); return "wrote " + args.path; }
  throw new Error("unknown tool: " + name);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "chat-example-fs", version: "0.1.0" },
      } });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const text = await call(params.name, params.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }] } });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error.message ?? error) }], isError: true } });
  }
}
