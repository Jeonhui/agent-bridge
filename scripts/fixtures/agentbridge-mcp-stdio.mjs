#!/usr/bin/env node
// Runs AgentBridge as an MCP server over stdio, so an external agent can drive it (spec 23.2).

import { AgentBridge } from "../../packages/core/dist/index.js";
import { ClaudeProvider } from "../../packages/provider/claude/dist/index.js";
import { AgentBridgeMcpServer } from "../../packages/mcp/server/dist/index.js";

const agent = new AgentBridge();
agent.registerProvider(new ClaudeProvider());
await agent.start();

await new AgentBridgeMcpServer({ agent }).serveStdio();
