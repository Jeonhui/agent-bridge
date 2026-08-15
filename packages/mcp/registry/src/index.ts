import { AgentBridgeError } from "@agentbridge/core";

export type Permission = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "SYSTEM";

export interface ToolSource {
  type: "mcp" | "builtin" | "system";
  server?: string;
}

export interface AgentTool {
  /** `{sourceType}:{server}:{name}`, globally unique (spec 24.2). */
  id: string;
  /** Name exposed to the agent, unique within its server. */
  name: string;
  description: string;
  source: ToolSource;
  inputSchema: unknown;
  permissions: Permission[];
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
  discoveredAt: string;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
  };
}

export interface RegistryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function toolId(source: ToolSource, name: string): string {
  return `${source.type}:${source.server ?? ""}:${name}`;
}

/**
 * Derives permissions for a tool (spec 25.2), in priority order:
 *   1. MCP annotations
 *   2. explicit overrides
 *   3. name heuristics
 *   4. WRITE, because an unclassified tool must not be assumed harmless
 */
export function inferPermissions(
  tool: DiscoveredTool,
  overrides: Record<string, Permission[]> = {},
): Permission[] {
  const override = overrides[tool.name];
  if (override) return override;

  if (tool.annotations?.readOnlyHint === true) return ["READ"];
  if (tool.annotations?.destructiveHint === true) return ["WRITE"];

  const name = tool.name.toLowerCase();
  if (/(^|[._-])(exec|run|spawn|shell|command)/.test(name)) return ["EXECUTE"];
  if (/(^|[._-])(fetch|http|request|download|upload)/.test(name)) return ["NETWORK"];
  if (/(^|[._-])(write|create|update|delete|remove|move|rename)/.test(name)) return ["WRITE"];
  if (/(^|[._-])(read|get|list|search|query|find)/.test(name)) return ["READ"];

  return ["WRITE"];
}

export interface ToolRegistryOptions {
  /** Explicit tool name to permission mapping, applied before the heuristics. */
  permissionOverrides?: Record<string, Permission[]>;
}

/**
 * Single index of every tool regardless of origin (spec 24).
 * The agent never needs to know where a tool came from.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>();
  readonly #overrides: Record<string, Permission[]>;

  constructor(options: ToolRegistryOptions = {}) {
    this.#overrides = options.permissionOverrides ?? {};
  }

  /** Replaces every tool belonging to one server and reports what changed (spec 22.3). */
  replaceServerTools(serverId: string, discovered: DiscoveredTool[], prefix?: string): RegistryDiff {
    const source: ToolSource = { type: "mcp", server: serverId };
    const previous = new Map(
      [...this.#tools.values()]
        .filter((tool) => tool.source.server === serverId)
        .map((tool) => [tool.id, tool]),
    );

    const diff: RegistryDiff = { added: [], removed: [], changed: [] };
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const tool of discovered) {
      const name = prefix ? `${prefix}${tool.name}` : tool.name;
      const id = toolId(source, name);

      if (seen.has(id)) {
        throw new AgentBridgeError("AB-2205", {
          message: `duplicate tool name from server ${serverId}: ${name}`,
          details: { serverId, name },
        });
      }
      seen.add(id);

      const entry: AgentTool = {
        id,
        name,
        description: tool.description ?? "",
        source,
        inputSchema: tool.inputSchema ?? { type: "object" },
        permissions: inferPermissions({ ...tool, name }, this.#overrides),
        discoveredAt: now,
        ...(tool.annotations
          ? {
              annotations: {
                ...(tool.annotations.readOnlyHint !== undefined
                  ? { readOnly: tool.annotations.readOnlyHint }
                  : {}),
                ...(tool.annotations.destructiveHint !== undefined
                  ? { destructive: tool.annotations.destructiveHint }
                  : {}),
                ...(tool.annotations.idempotentHint !== undefined
                  ? { idempotent: tool.annotations.idempotentHint }
                  : {}),
              },
            }
          : {}),
      };

      const before = previous.get(id);
      if (!before) diff.added.push(id);
      else if (!sameShape(before, entry)) diff.changed.push(id);

      this.#tools.set(id, entry);
      previous.delete(id);
    }

    for (const [id] of previous) {
      this.#tools.delete(id);
      diff.removed.push(id);
    }

    return diff;
  }

  registerBuiltin(tool: DiscoveredTool): AgentTool {
    const source: ToolSource = { type: "builtin" };
    const entry: AgentTool = {
      id: toolId(source, tool.name),
      name: tool.name,
      description: tool.description ?? "",
      source,
      inputSchema: tool.inputSchema ?? { type: "object" },
      permissions: inferPermissions(tool, this.#overrides),
      discoveredAt: new Date().toISOString(),
    };
    this.#tools.set(entry.id, entry);
    return entry;
  }

  removeServer(serverId: string): string[] {
    const removed: string[] = [];
    for (const [id, tool] of this.#tools) {
      if (tool.source.server === serverId) {
        this.#tools.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get(id: string): AgentTool {
    const tool = this.#tools.get(id);
    if (!tool) throw new AgentBridgeError("AB-2201", { details: { toolId: id } });
    return tool;
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  list(filter: { server?: string; source?: ToolSource["type"] } = {}): AgentTool[] {
    return [...this.#tools.values()]
      .filter((tool) => (filter.server ? tool.source.server === filter.server : true))
      .filter((tool) => (filter.source ? tool.source.type === filter.source : true));
  }

  /** Tools visible to a session: its bound servers plus everything built in (spec 24.3). */
  listForSession(serverIds: string[]): AgentTool[] {
    const bound = new Set(serverIds);
    return [...this.#tools.values()].filter(
      (tool) => tool.source.type !== "mcp" || bound.has(tool.source.server ?? ""),
    );
  }
}

function sameShape(a: AgentTool, b: AgentTool): boolean {
  return (
    a.description === b.description &&
    JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) &&
    a.permissions.join(",") === b.permissions.join(",")
  );
}
