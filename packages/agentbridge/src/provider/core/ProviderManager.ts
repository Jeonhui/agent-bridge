import { AgentBridgeError } from "../../core/index.js";

import type { AgentProvider, ProviderDetection, ProviderInfo } from "./AgentProvider.js";

export interface ProviderManagerOptions {
  /** TTL for cached successful detection. Defaults to 60s (spec chapter 8). */
  detectionTtlMs?: number;
  /**
   * TTL for cached failed detection. Defaults to 5s.
   * Kept short so installing a CLI mid-session is picked up quickly.
   */
  failedDetectionTtlMs?: number;
  /** Timeout for an individual adapter's detect(). Defaults to 3s (spec 28.1). */
  detectTimeoutMs?: number;
}

interface CacheEntry {
  detection: ProviderDetection;
  at: number;
}

/**
 * Owns adapter registration and local installation discovery (spec 10.2).
 * Detection runs in parallel and a single adapter failure never aborts the sweep.
 */
export class ProviderManager {
  readonly #providers = new Map<string, AgentProvider>();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<ProviderDetection>>();
  readonly #ttlMs: number;
  readonly #failedTtlMs: number;
  readonly #timeoutMs: number;

  constructor(options: ProviderManagerOptions = {}) {
    this.#ttlMs = options.detectionTtlMs ?? 60_000;
    this.#failedTtlMs = options.failedDetectionTtlMs ?? 5_000;
    this.#timeoutMs = options.detectTimeoutMs ?? 3_000;
  }

  register(provider: AgentProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new AgentBridgeError("AB-1007", {
        message: `Duplicate provider id: ${provider.id}`,
        details: { providerId: provider.id },
      });
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): AgentProvider {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new AgentBridgeError("AB-1001", { details: { providerId: id } });
    }
    return provider;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  /** Providers that are not installed are still listed, with available:false and a reason (spec chapter 8). */
  async list(options: { refresh?: boolean } = {}): Promise<ProviderInfo[]> {
    return Promise.all(
      [...this.#providers.values()].map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        capabilities: provider.capabilities,
        ...(await this.detect(provider.id, options)),
      })),
    );
  }

  async detect(id: string, options: { refresh?: boolean } = {}): Promise<ProviderDetection> {
    const provider = this.get(id);

    if (!options.refresh) {
      const cached = this.#cache.get(id);
      if (cached && Date.now() - cached.at < this.#ttlFor(cached.detection)) {
        return cached.detection;
      }

      // Collapse concurrent detections so real adapters do not spawn duplicate processes.
      const running = this.#inFlight.get(id);
      if (running) return running;
    }

    const run = this.#detectWithTimeout(provider)
      .then((detection) => {
        this.#cache.set(id, { detection, at: Date.now() });
        return detection;
      })
      .finally(() => {
        this.#inFlight.delete(id);
      });

    this.#inFlight.set(id, run);
    return run;
  }

  invalidate(id?: string): void {
    if (id === undefined) this.#cache.clear();
    else this.#cache.delete(id);
  }

  #ttlFor(detection: ProviderDetection): number {
    return detection.available ? this.#ttlMs : this.#failedTtlMs;
  }

  async #detectWithTimeout(provider: AgentProvider): Promise<ProviderDetection> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<ProviderDetection>((resolve) => {
      timer = setTimeout(
        () => resolve({ available: false, reason: `Detection timed out after ${this.#timeoutMs}ms` }),
        this.#timeoutMs,
      );
      // Not unref'd: an adapter that hangs without I/O leaves this timer as the only way
      // detection ever returns.
    });

    try {
      return await Promise.race([provider.detect(), timeout]);
    } catch (error) {
      // A single adapter failure must not abort the whole detection sweep.
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
