#!/usr/bin/env node
// Runs AgentBridge as an MCP server over stdio, so an external agent can drive it (spec 23.2).

import { AgentBridge } from "../../packages/agentbridge/dist/core/index.js";
import { ClaudeProvider } from "../../packages/agentbridge/dist/provider/claude/index.js";
import { AgentBridgeMcpServer } from "../../packages/agentbridge/dist/mcp/server/index.js";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

await new AgentBridgeMcpServer({ agent }).serveStdio();
