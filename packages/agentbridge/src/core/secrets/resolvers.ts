import { execFile } from "node:child_process";

import type { SecretReference, SecretResolver } from "./SecretResolver.js";

/** Reads secrets from the environment. Useful in CI and development. */
export class EnvSecretResolver implements SecretResolver {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  async resolve(reference: SecretReference): Promise<string | undefined> {
    const key = reference.account
      ? `${reference.service}_${reference.account}`.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()
      : reference.service.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

    return this.#env[key];
  }
}

/** Resolves from an in-memory map. Intended for tests and for hosts that manage secrets themselves. */
export class MapSecretResolver implements SecretResolver {
  readonly #entries: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.#entries = new Map(Object.entries(entries));
  }

  set(reference: string, value: string): void {
    this.#entries.set(reference, value);
  }

  async resolve(reference: SecretReference): Promise<string | undefined> {
    return this.#entries.get(reference.raw) ?? this.#entries.get(reference.service);
  }
}

/**
 * Reads from the operating system's credential store (spec 26.3).
 *
 * Shelling out to the platform tool keeps this free of a native dependency, and it means the
 * secret never lands in a config file that a backup or a repository could pick up.
 */
export class KeychainSecretResolver implements SecretResolver {
  // Typed as string rather than NodeJS.Platform so the published .d.ts compiles for consumers
  // who do not have @types/node — the switch below narrows to the platforms we support anyway.
  readonly #platform: string;

  constructor(platform: string = process.platform) {
    this.#platform = platform;
  }

  async resolve(reference: SecretReference): Promise<string | undefined> {
    const command = this.#command(reference);
    if (!command) return undefined;

    return new Promise((resolve) => {
      execFile(command.file, command.args, { timeout: 5_000 }, (error, stdout) => {
        // A miss is not a failure: the caller decides whether an unresolved reference is fatal.
        resolve(error ? undefined : stdout.toString().replace(/\n$/, "") || undefined);
      });
    });
  }

  #command(reference: SecretReference): { file: string; args: string[] } | undefined {
    const { service, account } = reference;

    if (this.#platform === "darwin") {
      return {
        file: "security",
        args: [
          "find-generic-password",
          "-s",
          service,
          ...(account ? ["-a", account] : []),
          "-w",
        ],
      };
    }

    if (this.#platform === "linux") {
      return {
        file: "secret-tool",
        args: ["lookup", "service", service, ...(account ? ["account", account] : [])],
      };
    }

    if (this.#platform === "win32") {
      const target = account ? `${service}/${account}` : service;
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          `(Get-StoredCredential -Target '${target}').GetNetworkCredential().Password`,
        ],
      };
    }

    return undefined;
  }
}

/** Tries each resolver in order and returns the first hit. */
export class ChainSecretResolver implements SecretResolver {
  readonly #resolvers: SecretResolver[];

  constructor(...resolvers: SecretResolver[]) {
    this.#resolvers = resolvers;
  }

  async resolve(reference: SecretReference): Promise<string | undefined> {
    for (const resolver of this.#resolvers) {
      const value = await resolver.resolve(reference);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
