import type { ProviderCapabilities, ProviderDetection } from "./AgentProvider.js";
import { detectExecutable } from "./detect.js";

export interface BuiltinProviderSpec {
  id: string;
  name: string;
  command: string;
  /** The surface the real adapter implements, from spec 12.3. */
  capabilities: ProviderCapabilities;
}

/**
 * Descriptors for the agent CLIs AgentBridge can run.
 *
 * Detection lives here because it needs nothing but the executable name, which keeps
 * `listAgents()` free of any dependency on the adapter packages. Running a session needs the
 * adapter itself: `@agentbridge/provider-claude` or `-codex`.
 *
 * Gemini is deliberately absent: reporting a CLI as detected implies AgentBridge can drive it,
 * and it currently cannot. See the README.
 */
export const BUILTIN_PROVIDERS: readonly BuiltinProviderSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    capabilities: {
      streaming: true,
      mcp: true,
      resume: true,
      interrupt: true,
      workingDirectory: true,
      permissionHook: false,
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    capabilities: {
      streaming: true,
      mcp: true,
      resume: true,
      interrupt: true,
      workingDirectory: true,
      permissionHook: false,
    },
  },
];

export interface DetectedAgent extends ProviderDetection {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
}

/**
 * Reports which agent CLIs are installed locally.
 *
 * Detection runs in parallel and never throws: a missing or broken CLI comes back as
 * `available: false` with a reason (spec chapter 8).
 */
export async function listAgents(
  specs: readonly BuiltinProviderSpec[] = BUILTIN_PROVIDERS,
): Promise<DetectedAgent[]> {
  return Promise.all(
    specs.map(async (spec) => ({
      id: spec.id,
      name: spec.name,
      capabilities: spec.capabilities,
      ...(await detectExecutable({ command: spec.command })),
    })),
  );
}
