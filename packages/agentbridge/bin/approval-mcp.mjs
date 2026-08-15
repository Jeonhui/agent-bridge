#!/usr/bin/env node
// A single-tool MCP server that an agent CLI runs as its permission prompt tool.
//
// The CLI hands it {tool_name, input} and waits for {behavior, updatedInput|message}. This process
// cannot decide anything itself, so it forwards to the AgentBridge approval gateway and returns
// whatever the host answers. Configuration arrives through the environment because the CLI, not
// AgentBridge, is what launches this process.
//
//   AGENTBRIDGE_APPROVAL_URL     loopback endpoint
//   AGENTBRIDGE_APPROVAL_TOKEN   token minted for this session
//   AGENTBRIDGE_SESSION_ID       session the request belongs to

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const URL_BASE = process.env.AGENTBRIDGE_APPROVAL_URL;
const TOKEN = process.env.AGENTBRIDGE_APPROVAL_TOKEN;
const SESSION_ID = process.env.AGENTBRIDGE_SESSION_ID ?? "";
const TOOL_NAME = "permission_prompt";

const server = new Server(
  { name: "agentbridge-approval", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description: "Ask the host application whether a tool call may proceed.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          input: { type: "object" },
        },
        required: ["tool_name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { tool_name: toolName, input } = request.params.arguments ?? {};

  const decision = await ask(String(toolName ?? "unknown"), input ?? {});
  // The CLI reads the decision out of the text content, so it is returned as JSON text.
  return { content: [{ type: "text", text: JSON.stringify(decision) }] };
});

async function ask(toolName, input) {
  if (!URL_BASE || !TOKEN) {
    return { behavior: "deny", message: "the approval gateway was not configured" };
  }

  try {
    const response = await fetch(`${URL_BASE}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: SESSION_ID, toolName, input }),
    });

    const decision = await response.json();
    return decision?.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
      : { behavior: "deny", message: decision?.message ?? "denied by the host application" };
  } catch (error) {
    // Never leave the agent waiting: an unreachable host is a denial, not a hang.
    return { behavior: "deny", message: `approval gateway unreachable: ${String(error)}` };
  }
}

await server.connect(new StdioServerTransport());
