/** Shared loader for the new geolibre.package.v1 envelope and legacy manifests. */

export interface GeolibreCapability { state: "available" | "unavailable" | string; reason?: string }
export interface GeolibreReplication { did: number; didname?: string; xid?: number; xname?: string }
export interface GeolibreAnimation { name?: string; manifestPath?: string; scid?: number | string; did?: number | string }
export interface GeolibreScenario { name?: string; scid: number | string; replications: GeolibreReplication[]; animations?: GeolibreAnimation[] }
export interface GeolibrePackage { schemaVersion?: string; capabilities: Record<string, GeolibreCapability>; scenarios: GeolibreScenario[]; resultsPath: string | null; resultsChecksum: { algorithm?: string; value?: string } | null; resultsCatalogRelative: string | null; resultsFormat: string | null; resultsTableSelection: string[]; dataContracts: Record<string, unknown>; legacyManifestPath: string | null }

const envelopeKey = "__geolibrePackage";
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export function parseGeolibrePackage(raw: unknown): GeolibrePackage {
  const root = record(raw);
  const results = record(root.results);
  const scenarios = Array.isArray(root.scenarios) ? root.scenarios.map((s) => {
    const x = record(s);
    const reps = Array.isArray(x.replications) ? x.replications.map((r) => {
      const y = record(r); return { did: Number(y.did), didname: typeof y.didname === "string" ? y.didname : undefined, xid: Number(y.xid), xname: typeof y.xname === "string" ? y.xname : undefined };
    }).filter((r) => Number.isFinite(r.did)) : [];
    const animations = Array.isArray(x.animations) ? x.animations.map((animation) => {
      const value = record(animation);
      return {
        name: typeof value.name === "string" ? value.name : undefined,
        manifestPath: typeof value.manifestPath === "string" ? value.manifestPath : undefined,
        scid: typeof value.scid === "string" || typeof value.scid === "number" ? value.scid : undefined,
        did: typeof value.did === "string" || typeof value.did === "number" ? value.did : undefined,
      };
    }).filter((animation) => Boolean(animation.manifestPath || animation.scid !== undefined || animation.did !== undefined)) : undefined;
    return { name: typeof x.name === "string" ? x.name : undefined, scid: typeof x.scid === "string" || typeof x.scid === "number" ? x.scid : "", replications: reps, animations };
  }).filter((s) => s.scid !== "") : [];
  const environment = record(root.environment);
  const sidecars = record(results.sidecars);
  const parquetSidecar = record(sidecars.parquet);
  const dataContracts = results.dataContracts && typeof results.dataContracts === "object"
    ? record(results.dataContracts)
    : environment.data_contracts && typeof environment.data_contracts === "object"
      ? record(environment.data_contracts)
      : {};
  const catalogPath = typeof environment.results_catalog_relative === "string"
    ? environment.results_catalog_relative
    : typeof parquetSidecar.catalogPath === "string" ? parquetSidecar.catalogPath : null;
  return { schemaVersion: typeof root.schemaVersion === "string" ? root.schemaVersion : undefined, capabilities: record(root.capabilities) as Record<string, GeolibreCapability>, scenarios, resultsPath: typeof results.path === "string" ? results.path : null, resultsChecksum: results.checksum && typeof results.checksum === "object" ? results.checksum as GeolibrePackage["resultsChecksum"] : null, resultsCatalogRelative: catalogPath, resultsFormat: typeof results.format === "string" ? results.format : typeof environment.results_format === "string" ? environment.results_format : null, resultsTableSelection: Array.isArray(environment.results_table_selection) ? environment.results_table_selection.filter((x): x is string => typeof x === "string") : [], dataContracts, legacyManifestPath: typeof root.legacyManifestPath === "string" ? root.legacyManifestPath : null };
}

export function attachGeolibrePackage(legacy: unknown, packageRaw: unknown): unknown {
  const root = { ...record(legacy) };
  root[envelopeKey] = parseGeolibrePackage(packageRaw);
  return root;
}

export function getGeolibrePackage(raw: unknown): GeolibrePackage | null {
  const value = record(raw)[envelopeKey];
  return value && typeof value === "object" ? value as GeolibrePackage : null;
}

export function packageManifestUrl(manifestUrl: string, path: string): string {
  return new URL(path, new URL(".", manifestUrl)).toString();
}

/**
 * A manifest URL is commonly reused across genuinely different package
 * deployments (a local dev server restarted against a different exported
 * package, or a proxy pointed at a new build, while keeping the same URL).
 * The browser's HTTP cache has no way to know that, and revalidation
 * heuristics can keep serving an old response body long after the server
 * has changed — confirmed by direct testing: a plain `fetch()` kept
 * returning a stale manifest even after the server was restarted with
 * fresh content and explicit `Cache-Control: no-store` response headers,
 * because the cache entry predated that server restart. `cache: "no-store"`
 * forces the browser to always go to the network for this call.
 */
export async function loadHttpPackageManifests(manifestUrl: string): Promise<unknown> {
  const legacyResponse = await fetch(manifestUrl, { cache: "no-store" });
  if (!legacyResponse.ok) throw new Error(`Failed to fetch the manifest (${legacyResponse.status}).`);
  const legacy = await legacyResponse.json();
  try {
    const response = await fetch(packageManifestUrl(manifestUrl, "geolibre/package.json"), { cache: "no-store" });
    if (!response.ok) return legacy;
    return attachGeolibrePackage(legacy, await response.json());
  } catch { return legacy; }
}

export function capabilityAvailable(raw: unknown, name: string): { available: boolean; reason: string | null } {
  const capability = getGeolibrePackage(raw)?.capabilities[name];
  return { available: !capability || capability.state === "available", reason: capability?.reason ?? null };
}
