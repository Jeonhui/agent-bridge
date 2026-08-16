import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import type { PermissionMode } from "../session/types.js";

/**
 * A named, reusable agent configuration (spec 12.6).
 *
 * Instead of assembling provider, model, role, and tool bindings at every `sessions.create`,
 * the host declares them once under a name. Definitions live in code, like provider
 * registrations: the host re-declares them at startup, so there is nothing to persist and
 * nothing to drift from the code that owns them.
 */
export interface AgentDefinition {
  /** Stable identifier, e.g. "reviewer". Also names the tool other agents call. */
  id: string;
  /** Display name, e.g. "Code Reviewer". Becomes the session title. */
  name: string;
  /** One line other agents read when deciding whether to call this one. */
  description: string;
  /** The role, injected as the system prompt. As detailed as the host wants. */
  role?: string;
  provider: string;
  model?: string;
  mcp?: string[];
  permissionMode?: PermissionMode;
  workingDirectory?: string;
  env?: Record<string, string>;
  /**
   * "oneshot" (default): every call starts a fresh conversation and the session is stopped
   * after the reply. "persistent": one session per definition, so the conversation
   * accumulates across calls until the runtime stops.
   */
  memory?: "oneshot" | "persistent";
  /** Expose this definition as a tool other agents can call. Defaults to true. */
  callable?: boolean;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** In-memory index of agent definitions. Owned by AgentBridge; not persisted by design. */
export class AgentDirectory {
  readonly #definitions = new Map<string, AgentDefinition>();

  /** Adds or replaces a definition. Replacement is deliberate: startup code is the source of truth. */
  define(definition: AgentDefinition): AgentDefinition {
    if (!ID_PATTERN.test(definition.id)) {
      throw new AgentBridgeError("AB-1008", {
        message: `agent id "${definition.id}" must match ${ID_PATTERN} (it becomes a tool name)`,
        details: { agentId: definition.id },
      });
    }
    if (!definition.name || !definition.description || !definition.provider) {
      throw new AgentBridgeError("AB-1008", {
        message: "an agent definition requires id, name, description, and provider",
        details: { agentId: definition.id },
      });
    }
    const entry = { ...definition };
    this.#definitions.set(entry.id, entry);
    return entry;
  }

  get(id: string): AgentDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new AgentBridgeError("AB-1008", {
        message: `Unknown agent "${id}". Defined agents: ${[...this.#definitions.keys()].join(", ") || "(none)"}.`,
        details: { agentId: id, defined: [...this.#definitions.keys()] },
      });
    }
    return definition;
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  list(): AgentDefinition[] {
    return [...this.#definitions.values()];
  }

  remove(id: string): void {
    this.get(id);
    this.#definitions.delete(id);
  }

  get size(): number {
    return this.#definitions.size;
  }
}
