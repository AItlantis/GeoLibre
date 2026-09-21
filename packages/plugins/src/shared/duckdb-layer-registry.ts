/**
 * DuckDB layer registry.
 *
 * Several GeoLibre plugins (network-kpi, emissions-h3, vehicle-playback,
 * path-analysis, scenario-comparison) each open their own DuckDB-wasm
 * instance/connection when their panel loads a package. DuckDB-wasm is heavy
 * (a Wasm module plus a dedicated worker per instance), and this repo has
 * confirmed real leaks where closing a panel did not release its instance
 * (see maplibre-path-analysis.ts and maplibre-scenario-comparison.ts).
 *
 * This module is a small, DuckDB-free, framework-free registry: it tracks
 * which plugin currently "owns" a live DuckDB-backed layer and enforces a
 * concurrency cap (default 1 — confirmed product decision) by disposing the
 * least-recently-registered layer(s) when the cap would otherwise be
 * exceeded. It holds no DuckDB import and no React dependency, so it is
 * plain-`node --test`-able and usable from any module-level plugin singleton.
 */

export interface DuckDbLayerHandle {
  /** Stable id for the owning plugin, e.g. "network-kpi". */
  pluginId: string;
  /** Tear down this plugin's DuckDB-backed resources (connection/db/worker). */
  dispose(): void | Promise<void>;
}

export interface DuckDbLayerRegistryOptions {
  /** Maximum number of DuckDB-backed layers allowed live at once. Default 1. */
  maxConcurrent?: number;
}

interface RegistryEntry {
  handle: DuckDbLayerHandle;
  /** Monotonic registration order, used to find the least-recently-registered entry. */
  seq: number;
}

const DEFAULT_MAX_CONCURRENT = 1;

let maxConcurrent = DEFAULT_MAX_CONCURRENT;
let seqCounter = 0;
// Order of keys reflects registration order (Map preserves insertion order),
// which is what "least-recently-registered" reads off of.
const active = new Map<string, RegistryEntry>();

/**
 * Configure the registry's concurrency cap. Optional — the default (1) is the
 * confirmed product behavior, so most callers never need this.
 */
export function configureDuckDbLayerRegistry(options: DuckDbLayerRegistryOptions): void {
  if (typeof options.maxConcurrent === "number" && options.maxConcurrent > 0) {
    maxConcurrent = Math.trunc(options.maxConcurrent);
  }
}

/**
 * Register a plugin's live DuckDB-backed layer.
 *
 * If the plugin already has a registered layer, the previous handle for that
 * same plugin is replaced (disposed) first — a same-plugin re-register/reload
 * must never trigger the concurrency-cap eviction logic below, since that
 * logic is about DIFFERENT plugins competing for the single DuckDB slot.
 *
 * When registering would exceed `maxConcurrent`, the least-recently-registered
 * OTHER plugin's handle is evicted (disposed) — but only AFTER the new handle
 * has been added to the registry, so a same-plugin re-register (which removes
 * and re-adds under the same key) never counts as, or is subject to, eviction.
 */
export function registerDuckDbLayer(handle: DuckDbLayerHandle): void {
  const previousForSamePlugin = active.get(handle.pluginId);
  if (previousForSamePlugin) {
    active.delete(handle.pluginId);
    if (previousForSamePlugin.handle !== handle) {
      void previousForSamePlugin.handle.dispose();
    }
  }

  active.set(handle.pluginId, { handle, seq: seqCounter++ });

  // Evict oldest entries until we're back at/under the cap. Runs only after
  // the new handle is already registered, so the just-registered plugin is
  // never itself a candidate for eviction from its own registration call.
  while (active.size > maxConcurrent) {
    let oldestKey: string | null = null;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [key, entry] of active) {
      if (entry.seq < oldestSeq) {
        oldestSeq = entry.seq;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    const evicted = active.get(oldestKey);
    active.delete(oldestKey);
    if (evicted) void evicted.handle.dispose();
  }
}

/**
 * Release a plugin's registered layer without disposing anyone else's.
 *
 * Idempotent: calling this twice for the same `pluginId` (e.g. once from the
 * plugin's own close path and once from a registry eviction that already ran)
 * is safe — the second call simply finds nothing registered and no-ops. Does
 * NOT call `dispose()` itself: the caller is expected to already be mid-close
 * (this just clears the registry's bookkeeping so a later registration is not
 * confused about which layers are live).
 */
export function releaseDuckDbLayer(pluginId: string): void {
  active.delete(pluginId);
}

/** Ids of plugins with a currently registered (live) DuckDB layer. */
export function getActiveDuckDbLayers(): readonly string[] {
  return [...active.keys()];
}

/** Test-only: reset all registry state, including the concurrency cap. */
export function __resetDuckDbLayerRegistryForTests(): void {
  active.clear();
  seqCounter = 0;
  maxConcurrent = DEFAULT_MAX_CONCURRENT;
}
