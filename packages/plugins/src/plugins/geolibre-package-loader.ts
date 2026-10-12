/** Shared loader for the new geolibre.package.v1 envelope and legacy manifests. */

export interface GeolibreCapability { state: "available" | "unavailable" | string; reason?: string }
export interface GeolibreReplication { did: number; didname?: string; xid?: number; xname?: string }
export interface GeolibreAnimation { name?: string; manifestPath?: string; scid?: number | string; did?: number | string }
export interface GeolibreScenario { name?: string; scid: number | string; replications: GeolibreReplication[]; animations?: GeolibreAnimation[] }
export interface GeolibreViewMode { id: "results" | "comparison" | "environment" | "animation" | "paths"; table: string; column: string; unit: string; style: { type: "ramp" | "extrusion"; id?: string; column?: string; max?: number; stops?: string[]; colors?: string[] }; domains: { sid?: { min?: number; max?: number }; ent?: { min?: number; max?: number }; intervalSeconds?: number }; alternates?: Array<{ table: string; column: string; unit: string; style: GeolibreViewMode["style"] }>; scenarioDidPair?: Array<{ scid: number; did: number }> }
export interface GeolibrePackage { schemaVersion?: string; capabilities: Record<string, GeolibreCapability>; scenarios: GeolibreScenario[]; resultsPath: string | null; resultsChecksum: { algorithm?: string; value?: string } | null; resultsCatalogRelative: string | null; resultsFormat: string | null; resultsTableSelection: string[]; dataContracts: Record<string, unknown>; legacyManifestPath: string | null; pathIndicesByScid: Record<string, string>; viewModes: Partial<Record<GeolibreViewMode["id"], GeolibreViewMode>>; environmentScenarioDidPair: { declared: boolean; valid: boolean; pairs: Array<{ scid: number; did: number }> }; timeAxis: { fromTime: number; intervalMs: number; intervals: number } | null }

export interface EnvironmentScenarioCoverage {
  status: "available" | "unavailable" | "unknown";
  dids: number[];
  /** Safe replication candidates to verify when inventory completeness is unknown. */
  candidateDids?: number[];
}

export interface EnvironmentScenarioCoverageResult {
  byScid: Record<string, EnvironmentScenarioCoverage>;
  packageEligible: boolean;
}

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
  const pathIndices = record(root.pathIndicesByScid);
  const rawViewModes = record(results.viewModes);
  const rawEnvironmentMode = record(rawViewModes.environment);
  const explicitEnvironmentPairs = rawEnvironmentMode.scenarioDidPair;
  const environmentScenarioDidPair = {
    declared: Object.prototype.hasOwnProperty.call(rawEnvironmentMode, "scenarioDidPair"),
    valid: !Object.prototype.hasOwnProperty.call(rawEnvironmentMode, "scenarioDidPair")
      || Array.isArray(explicitEnvironmentPairs) && explicitEnvironmentPairs.length > 0 && explicitEnvironmentPairs.every(value => {
        const pair = record(value);
        return Number.isSafeInteger(pair.scid) && Number(pair.scid) >= 0 && Number.isSafeInteger(pair.did) && Number(pair.did) >= 0;
      }),
    pairs: Array.isArray(explicitEnvironmentPairs) ? explicitEnvironmentPairs.map(value => record(value))
      .filter(value => Number.isSafeInteger(value.scid) && Number.isSafeInteger(value.did))
      .map(value => ({ scid: Number(value.scid), did: Number(value.did) })) : [],
  };
  const viewModes: GeolibrePackage["viewModes"] = {};
  for (const [key, value] of Object.entries(rawViewModes)) {
    if (!["results", "comparison", "environment", "animation", "paths"].includes(key)) continue;
    const mode = record(value); const style = record(mode.style); const domains = record(mode.domains);
    if (typeof mode.table !== "string" || typeof mode.column !== "string" || typeof mode.unit !== "string"
      || (style.type !== "ramp" && style.type !== "extrusion")) continue;
    const normalizeStyle = (candidate: unknown): GeolibreViewMode["style"] | null => {
      const x = record(candidate); if (x.type !== "ramp" && x.type !== "extrusion") return null;
      return { type: x.type, ...(typeof x.id === "string" ? { id: x.id } : {}), ...(typeof x.column === "string" ? { column: x.column } : {}), ...(Number.isFinite(x.max) ? { max: Number(x.max) } : {}), ...(Array.isArray(x.stops) ? { stops: x.stops.filter((item): item is string => typeof item === "string") } : {}), ...(Array.isArray(x.colors) ? { colors: x.colors.filter((item): item is string => typeof item === "string") } : {}) };
    };
    const normalized = normalizeStyle(style); if (!normalized) continue;
    const pair = Array.isArray(mode.scenarioDidPair) ? mode.scenarioDidPair.map(item => record(item)).filter(item => Number.isSafeInteger(item.scid) && Number.isSafeInteger(item.did)).map(item => ({ scid: Number(item.scid), did: Number(item.did) })) : undefined;
    const bounds = (candidate: unknown) => { const x = record(candidate); return { ...(Number.isFinite(x.min) ? { min: Number(x.min) } : {}), ...(Number.isFinite(x.max) ? { max: Number(x.max) } : {}) }; };
    const alternates = Array.isArray(mode.alternates) ? mode.alternates.map(item => record(item)).flatMap(item => { const alternateStyle = normalizeStyle(item.style); return typeof item.table === "string" && typeof item.column === "string" && typeof item.unit === "string" && alternateStyle ? [{ table: item.table, column: item.column, unit: item.unit, style: alternateStyle }] : []; }) : undefined;
    viewModes[key as GeolibreViewMode["id"]] = { id: key as GeolibreViewMode["id"], table: mode.table, column: mode.column, unit: mode.unit, style: normalized, domains: { ...(domains.sid ? { sid: bounds(domains.sid) } : {}), ...(domains.ent ? { ent: bounds(domains.ent) } : {}), ...(Number.isFinite(domains.intervalSeconds) ? { intervalSeconds: Number(domains.intervalSeconds) } : {}) }, ...(alternates?.length ? { alternates } : {}), ...(pair?.length ? { scenarioDidPair: pair } : {}) };
  }
  const axis = record(results.timeAxis);
  const timeAxis = Number.isFinite(axis.fromTime) && Number.isFinite(axis.intervalMs) && Number(axis.intervalMs) > 0
    && Number.isSafeInteger(axis.intervals) && Number(axis.intervals) >= 0
    ? { fromTime: Number(axis.fromTime), intervalMs: Number(axis.intervalMs), intervals: Number(axis.intervals) } : null;
  return { schemaVersion: typeof root.schemaVersion === "string" ? root.schemaVersion : undefined, capabilities: record(root.capabilities) as Record<string, GeolibreCapability>, scenarios, resultsPath: typeof results.path === "string" ? results.path : null, resultsChecksum: results.checksum && typeof results.checksum === "object" ? results.checksum as GeolibrePackage["resultsChecksum"] : null, resultsCatalogRelative: catalogPath, resultsFormat: typeof results.format === "string" ? results.format : typeof environment.results_format === "string" ? environment.results_format : null, resultsTableSelection: Array.isArray(environment.results_table_selection) ? environment.results_table_selection.filter((x): x is string => typeof x === "string") : [], dataContracts, legacyManifestPath: typeof root.legacyManifestPath === "string" ? root.legacyManifestPath : null, pathIndicesByScid: Object.fromEntries(Object.entries(pathIndices).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))), viewModes, environmentScenarioDidPair, timeAxis };
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

/**
 * Resolve Environment coverage without relying on scenario order or a
 * package-wide DID guess. An explicit scenarioDidPair is authoritative when
 * present; otherwise the emissions actual_dids inventory is joined exactly
 * to each scenario's declared replications.
 */
export function resolveEnvironmentScenarioCoverage(pkg: GeolibrePackage | null, rawManifest?: unknown): EnvironmentScenarioCoverageResult {
  if (!pkg) return { byScid: {}, packageEligible: true };
  const scenarios = pkg.scenarios;
  const safeCandidates = (scenario: GeolibreScenario) => [...new Set((scenario.replications ?? [])
    .map(replication => replication.did)
    .filter(did => Number.isSafeInteger(did) && did >= 0))].sort((a, b) => a - b);
  const byScid = Object.fromEntries(scenarios.map(scenario => [String(scenario.scid), { status: "unknown", dids: [], candidateDids: safeCandidates(scenario) } as EnvironmentScenarioCoverage]));
  const root = record(rawManifest);
  const results = record(root.results);
  const viewModes = record(results.viewModes);
  const environmentMode = record(viewModes.environment);
  const hasRawPair = Object.prototype.hasOwnProperty.call(environmentMode, "scenarioDidPair");
  const declared = pkg.environmentScenarioDidPair?.declared ?? hasRawPair;
  const valid = pkg.environmentScenarioDidPair?.valid ?? true;
  const explicitPairs: unknown = pkg.environmentScenarioDidPair?.pairs ?? (hasRawPair ? environmentMode.scenarioDidPair : pkg.viewModes.environment?.scenarioDidPair);

  let explicitPairsValid = declared && valid && Array.isArray(explicitPairs) && explicitPairs.length > 0;
  if (explicitPairsValid) {
    const normalized: Array<{ scid: string; did: number }> = [];
    for (const value of explicitPairs as unknown[]) {
      const pair = record(value);
      if (!Number.isSafeInteger(pair.scid) || Number(pair.scid) < 0 || !Number.isSafeInteger(pair.did) || Number(pair.did) < 0) { explicitPairsValid = false; break; }
      const scid = String(pair.scid);
      const scenario = scenarios.find(item => String(item.scid) === scid);
      const did = Number(pair.did);
      if (!scenario || !(scenario.replications ?? []).some(replication => Number.isSafeInteger(replication.did) && replication.did >= 0 && replication.did === did)) { explicitPairsValid = false; break; }
      normalized.push({ scid, did });
    }
    if (explicitPairsValid) {
    for (const scenario of scenarios) {
      const dids = [...new Set(normalized.filter(pair => pair.scid === String(scenario.scid)).map(pair => pair.did))].sort((a, b) => a - b);
      byScid[String(scenario.scid)] = { status: dids.length ? "available" : "unavailable", dids };
    }
    }
  }
  if (!explicitPairsValid) {
    const emissions = record(pkg.dataContracts.emissions);
    const actualDids = emissions.actual_dids;
    const complete = emissions.actual_dids_truncated === false;
    if (!Array.isArray(actualDids) || actualDids.some(did => !Number.isSafeInteger(did) || Number(did) < 0)) return { byScid, packageEligible: true };
    const inventory = new Set((actualDids as unknown[]).map(Number));
    for (const scenario of scenarios) {
      const dids = [...new Set((scenario.replications ?? [])
        .map(replication => replication.did)
        .filter(did => Number.isSafeInteger(did) && did >= 0 && inventory.has(did)))].sort((a, b) => a - b);
      byScid[String(scenario.scid)] = dids.length
        ? { status: "available", dids }
        : complete
          ? { status: "unavailable", dids: [] }
          : { status: "unknown", dids: [], candidateDids: safeCandidates(scenario) };
    }
  }
  return { byScid, packageEligible: !scenarios.length || Object.values(byScid).some(value => value.status !== "unavailable") };
}

/** Try safe replications for an unknown-coverage scenario without converting a failed probe into known absence. */
export async function verifyEnvironmentScenarioCandidates<T>(
  candidateDids: number[],
  loadAndVerify: (did: number) => Promise<T>,
  clearUnverified: () => void,
  assertCurrent: () => void = () => undefined,
): Promise<{ did: number; value: T } | null> {
  const candidates = [...new Set(candidateDids.filter(did => Number.isSafeInteger(did) && did >= 0))].sort((a, b) => a - b);
  for (const did of candidates) {
    assertCurrent();
    try {
      const value = await loadAndVerify(did);
      assertCurrent();
      return { did, value };
    } catch {
      assertCurrent();
    }
  }
  assertCurrent();
  clearUnverified();
  assertCurrent();
  return null;
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
