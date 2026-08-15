import { AgentBridgeError } from "../errors/AgentBridgeError.js";

/** `secret://<service>/<account>` or `secret://<key>` (spec 26.3). */
export const SECRET_PREFIX = "secret://";

export interface SecretReference {
  raw: string;
  service: string;
  account?: string;
}

export interface SecretResolver {
  /** Returns the secret, or undefined when the store has no entry. Must not throw for a miss. */
  resolve(reference: SecretReference): Promise<string | undefined>;
}

export function isSecretReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

export function parseSecretReference(raw: string): SecretReference {
  const path = raw.slice(SECRET_PREFIX.length);
  const [service, ...rest] = path.split("/");

  if (!service) {
    throw new AgentBridgeError("AB-6004", {
      message: `malformed secret reference: ${raw}`,
      details: { reference: raw },
    });
  }

  const account = rest.join("/");
  return { raw, service, ...(account ? { account } : {}) };
}

/**
 * Replaces every `secret://` reference in a string map.
 *
 * An unresolved reference is an error rather than a passthrough: handing the literal
 * `secret://...` to a child process looks like a real value and surfaces later as a confusing
 * authentication failure somewhere else entirely.
 */
export async function resolveSecrets(
  values: Record<string, string> | undefined,
  resolver: SecretResolver | undefined,
): Promise<Record<string, string> | undefined> {
  if (!values) return undefined;

  const entries = Object.entries(values);
  if (!entries.some(([, value]) => isSecretReference(value))) return values;

  if (!resolver) {
    throw new AgentBridgeError("AB-6004", {
      message: "a secret:// reference was used but no secret resolver is configured",
      details: { keys: entries.filter(([, v]) => isSecretReference(v)).map(([k]) => k) },
    });
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!isSecretReference(value)) {
      resolved[key] = value;
      continue;
    }

    const reference = parseSecretReference(value);
    const secret = await resolver.resolve(reference);
    if (secret === undefined) {
      throw new AgentBridgeError("AB-6004", {
        message: `no secret found for ${value}`,
        details: { key, service: reference.service },
      });
    }
    resolved[key] = secret;
  }

  return resolved;
}
