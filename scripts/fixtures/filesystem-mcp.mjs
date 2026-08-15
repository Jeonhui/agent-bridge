#!/usr/bin/env node
// A tiny filesystem MCP server used to exercise the MCP path end to end.
// Scope is pinned to the directory given as argv[2]; set EXTRA_TOOL=1 to add one more tool,
// which is how the hot reload test observes a registry diff.

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const ROOT = resolve(process.argv[2] ?? process.cwd());

function safePath(input) {
  const target = isAbsolute(input) ? resolve(input) : resolve(join(ROOT, input));
  const rel = relative(ROOT, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the allowed scope: ${input}`);
  }
  return target;
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read a UTF-8 file inside the allowed directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file inside the allowed directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: true },
  },
];

if (process.env.EXTRA_TOOL === "1") {
  TOOLS.push({
    name: "append_file",
    description: "Append text to a file inside the allowed directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  });
}

const server = new Server(
  { name: "agentbridge-test-filesystem", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "read_file") {
      const content = await readFile(safePath(args.path), "utf8");
      return { content: [{ type: "text", text: content }] };
    }
    if (name === "write_file") {
      await writeFile(safePath(args.path), args.content, "utf8");
      return { content: [{ type: "text", text: `wrote ${args.path}` }] };
    }
    if (name === "append_file") {
      const target = safePath(args.path);
      const existing = await readFile(target, "utf8").catch(() => "");
      await writeFile(target, existing + args.content, "utf8");
      return { content: [{ type: "text", text: `appended ${args.path}` }] };
    }
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
