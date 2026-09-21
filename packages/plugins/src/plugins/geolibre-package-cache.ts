import { getGeolibrePackage, loadHttpPackageManifests } from "./geolibre-package-loader";

interface CacheEntry {
  raw: unknown;
  /** Snapshot used to identify the package represented by this cached JSON. */
  identity: string;
}

// Keyed by manifest URL. A cache hit is revalidated against the live
// resultsChecksum before being trusted (see loadCachedHttpPackageManifests),
// so a URL that is reused across genuinely different deployments (e.g. a
// local dev server restarted against a different exported package while
// keeping the same manifest URL) doesn't serve stale content forever —
// confirmed as a real bug via manual testing this session (switching a
// running GeoLibre session between two local package servers both bound to
// http://127.0.0.1:8899/manifest.json silently kept rendering the first
// package's data).
const entries = new Map<string, Promise<CacheEntry>>();

function packageIdentity(raw: unknown): string {
  const pkg = getGeolibrePackage(raw);
  if (!pkg) return "legacy";
  const checksum = pkg.resultsChecksum?.value;
  return [pkg.schemaVersion ?? "", pkg.resultsChecksum?.algorithm ?? "", checksum ?? ""].join(":");
}

// If a URL was (re)loaded within this window, treat concurrent/rapid callers
// as still fresh instead of firing a redundant revalidation fetch for each
// one — the whole point of the cache is to share one fetch across concurrent
// callers, which the per-call revalidation probe would otherwise defeat.
let revalidateWindowMs = 2_000;
const loadedAt = new Map<string, number>();

/** Test-only hook: override the freshness window (e.g. to 0 to force revalidation on every call). */
export function setRevalidateWindowForTests(ms: number): void {
  revalidateWindowMs = ms;
}

// Pending revalidation probes in flight, shared across concurrent callers of
// the same URL so a burst of simultaneous callers triggers exactly one
// freshness check instead of one per caller.
const revalidating = new Map<string, Promise<string | null>>();

/**
 * Load only the two manifest JSON documents and share them by manifest URL.
 * This deliberately does not preload Parquet, SQLite, animation chunks, or
 * any other data files referenced by the manifest.
 *
 * A cache hit older than the freshness window is revalidated against the
 * live manifest's `resultsChecksum` before being trusted: if the URL now
 * serves a package with a different identity than what's cached, the stale
 * entry is evicted and refetched.
 */
export function loadCachedHttpPackageManifests(manifestUrl: string): Promise<unknown> {
  const existing = entries.get(manifestUrl);
  if (existing) return revalidate(manifestUrl, existing);
  return load(manifestUrl);
}

async function revalidate(manifestUrl: string, existing: Promise<CacheEntry>): Promise<unknown> {
  const cached = await existing;
  const age = Date.now() - (loadedAt.get(manifestUrl) ?? 0);
  if (age < revalidateWindowMs) return cached.raw;
  if (entries.get(manifestUrl) !== existing) return (await entries.get(manifestUrl)!).raw;

  let probe = revalidating.get(manifestUrl);
  if (!probe) {
    probe = peekIdentity(manifestUrl).finally(() => revalidating.delete(manifestUrl));
    revalidating.set(manifestUrl, probe);
  }
  const freshIdentity = await probe;

  if (entries.get(manifestUrl) !== existing) return (await entries.get(manifestUrl)!).raw;
  if (freshIdentity === null || freshIdentity === cached.identity) {
    loadedAt.set(manifestUrl, Date.now());
    return cached.raw;
  }
  entries.delete(manifestUrl);
  return load(manifestUrl);
}

/**
 * Cheap staleness probe: refetch just enough to compute the current
 * identity, without going through (or populating) the main cache. Returns
 * null on any failure so a transient network hiccup falls back to trusting
 * the existing cache entry rather than needlessly evicting it.
 */
async function peekIdentity(manifestUrl: string): Promise<string | null> {
  try {
    const raw = await loadHttpPackageManifests(manifestUrl);
    return packageIdentity(raw);
  } catch {
    return null;
  }
}

function load(manifestUrl: string): Promise<unknown> {
  const pending = loadHttpPackageManifests(manifestUrl)
    .then((raw) => {
      loadedAt.set(manifestUrl, Date.now());
      return { raw, identity: packageIdentity(raw) };
    })
    .catch((error) => {
      entries.delete(manifestUrl);
      loadedAt.delete(manifestUrl);
      throw error;
    });
  entries.set(manifestUrl, pending);
  return pending.then((entry) => entry.raw);
}

/** Evict one HTTP manifest or clear the complete cache, including test state. */
export function invalidateGeolibrePackageCache(manifestUrl?: string): void {
  if (manifestUrl === undefined) { entries.clear(); loadedAt.clear(); }
  else { entries.delete(manifestUrl); loadedAt.delete(manifestUrl); }
}

