import type { Database, SqlJsStatic } from "sql.js";
import {
  createDirectoryPackageSource,
  createHttpPackageSource,
  loadVehicleGeometry,
  type VehicleDirectoryHandle,
  type VehicleGeometryLayers,
  type VehiclePackageSource,
} from "./vehicle-playback-data";
import type { KpiRamp, NetworkKpiMetric } from "./network-kpi-ramps";
import { attachGeolibrePackage, getGeolibrePackage, type GeolibrePackage } from "./geolibre-package-loader";
import { loadCachedHttpPackageManifests } from "./geolibre-package-cache";

/**
 * Data layer for the network-kpi plugin: manifest parsing for the results
 * database, gunzipping and opening it through sql.js, and the two aggregate
 * queries that produce a per-section and a per-lane KPI table.
 *
 * Where vehicle-playback streams a time series of individual vehicles, this
 * module reads STATIC aggregates: one flow/density/speed triple per section (or
 * per lane) for a chosen interval. That fits in memory whole, so there is no
 * chunking, no coverage window and no replay — the whole results table is read
 * once at load and then only re-sliced in JS when the user changes interval.
 *
 * ## Reuse of vehicle-playback's loaders
 *
 * The package layout is the same `manifest.json` vehicle-playback already reads,
 * so this module deliberately imports that plugin's exported loaders rather than
 * re-implementing them: {@link createHttpPackageSource} /
 * {@link createDirectoryPackageSource} for byte access (HTTP or a picked local
 * folder), and {@link loadVehicleGeometry} for the sections/lanes GeoJSON. Those
 * were already exported with no vehicle-specific coupling, so this needed no
 * refactor of `vehicle-playback-data.ts` at all and no duplicated fetch/parse
 * code. Only the `environment` block (the results database, which playback has
 * no use for) is parsed here.
 */

// ---------------------------------------------------------------------------
// Manifest: the environment block pointing at the results database.
// ---------------------------------------------------------------------------

/** The parts of a package manifest this plugin needs, beyond the geometry. */
export interface NetworkKpiManifest {
  /**
   * Package-relative path (or absolute URL) of the gzipped results SQLite, or
   * null when the manifest declares no results database.
   */
  sqlitePath: string | null;
  resultsCatalogRelative: string | null;
  resultsFormat: string | null;
  resultsTableSelection: string[];
  /** The manifest's geometry block, resolved the same way playback resolves it. */
  geometry: NetworkKpiGeometrySources;
  /** Package extent in WGS84, when the manifest declares one. */
  bounds: [number, number, number, number] | null;
  /** Manifest-provided ramps, keyed by metric, when available. */
  ramps: Partial<Record<NetworkKpiMetric, KpiRamp>>;
  package: GeolibrePackage | null;
}

/**
 * Geometry paths this plugin consumes.
 *
 * Turns and nodes are loaded as plain backdrop geometry. They carry no KPI
 * result rows and are never KPI-coloured.
 */
export interface NetworkKpiGeometrySources {
  sections: string | null;
  lanes: string | null;
  turns: string | null;
  nodes: string | null;
  /** Optional v2 scenario geometry manifest (the richer base/additions contract). */
  scenarioManifest?: string | null;
}

function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Resolve one manifest path against the manifest's own URL.
 *
 * A local directory package has no base URL, so `base` is null there and the
 * declared relative path is kept verbatim for the directory reader to walk —
 * exactly the convention `parseGeometrySources` uses in vehicle-playback-data.
 */
function resolvePath(value: unknown, base: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = value.trim();
  if (!base) return path;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

/**
 * Parse the results-database and geometry pointers out of a package manifest.
 *
 * The results database is declared in the manifest's `environment` block.
 * Confirmed on real packages as `environment.sqlite_relative`, with
 * `environment.sqlite_path` carrying the same value; both spellings are accepted
 * (relative first) so a package that only writes one still loads.
 *
 * Geometry can be declared per-scenario or once at the package root, matching
 * `parseVehicleManifest`'s own precedence.
 *
 * @param raw - The parsed manifest JSON
 * @param manifestUrl - Absolute URL it was fetched from, or null for a local folder
 * @param scenarioIndex - Which `animations[]` entry's geometry to prefer
 */
export function parseNetworkKpiManifest(
  raw: unknown,
  manifestUrl: string | null,
  scenarioIndex = 0,
): NetworkKpiManifest {
  const root = (raw ?? {}) as Record<string, unknown>;
  const animations = Array.isArray(root.animations)
    ? (root.animations as Record<string, unknown>[])
    : [];
  const flat = Array.isArray(root.chunks) || animations.length === 0;
  const selectedIndex = flat
    ? 0
    : Math.min(Math.max(0, Math.trunc(scenarioIndex) || 0), animations.length - 1);
  const scope = flat ? root : animations[selectedIndex];

  const environment = (root.environment ?? scope.environment ?? {}) as Record<string, unknown>;
  const pkg = getGeolibrePackage(raw);
  const sqlitePath = (pkg?.resultsPath ? resolvePath(pkg.resultsPath, manifestUrl) : null) ??
    resolvePath(environment.sqlite_relative, manifestUrl) ??
    resolvePath(environment.sqlite_path, manifestUrl);
  // A per-scenario `environment.results_catalog_relative` (resolved from
  // `scope` above, i.e. `animations[scenarioIndex]`) must win over the
  // package envelope's `pkg.resultsCatalogRelative`, which is parsed ONCE
  // from the manifest ROOT by parseGeolibrePackage() and is therefore the
  // same value for every scenario. Preferring `pkg` unconditionally (the
  // previous `pkg?.resultsCatalogRelative ?? environment...` order) pinned
  // every scenario to the package's single default results catalog, so
  // switching scenarios in Network KPI mode never changed the displayed
  // statistics (GitHub #277) even though the geometry did reload correctly.
  const resultsCatalogRelative = resolvePath(environment.results_catalog_relative ?? pkg?.resultsCatalogRelative, manifestUrl);
  const resultsFormat = typeof (pkg?.resultsFormat ?? environment.results_format) === "string" ? String(pkg?.resultsFormat ?? environment.results_format) : null;
  const resultsTableSelection = pkg?.resultsTableSelection ?? (Array.isArray(environment.results_table_selection) ? environment.results_table_selection.filter((x): x is string => typeof x === "string") : []);

  const rootGeometry = (root.geometry ?? {}) as Record<string, unknown>;
  const scenarioGeometry = Array.isArray(rootGeometry.scenarios)
    ? (rootGeometry.scenarios as Record<string, unknown>[])
    : [];
  const selectedScenario = scenarioGeometry[
    Math.min(Math.max(0, Math.trunc(scenarioIndex) || 0), Math.max(0, scenarioGeometry.length - 1))
  ];
  // Scenario-specific geometry blocks are often partial (notably Micro SRC
  // packages). Keep the root geometry as a fallback per field instead of
  // replacing it wholesale with an incomplete scenario block.
  const scenarioBlock = (selectedScenario?.sc_geometry ?? {}) as Record<string, unknown>;
  const geometryBlock = { ...rootGeometry, ...(scope.geometry as Record<string, unknown> | undefined), ...scenarioBlock };
  const scenarioId = selectedScenario && (selectedScenario.scid ?? selectedScenario.scenario_id);
  const metadata = { ...((root.metadata ?? {}) as Record<string, unknown>), ...((scope.metadata ?? {}) as Record<string, unknown>) };
  const rawBounds = (metadata.bounds ?? null) as Record<string, unknown> | null;
  const bounds: [number, number, number, number] | null = rawBounds
    ? [
        safeNumber(rawBounds.min_lon, Number.NaN),
        safeNumber(rawBounds.min_lat, Number.NaN),
        safeNumber(rawBounds.max_lon, Number.NaN),
        safeNumber(rawBounds.max_lat, Number.NaN),
      ]
    : null;

  return {
    sqlitePath,
    resultsCatalogRelative,
    resultsFormat,
    resultsTableSelection,
    geometry: {
      sections: resolvePath(geometryBlock.sections, manifestUrl),
      lanes: resolvePath(geometryBlock.lanes, manifestUrl),
      turns: resolvePath(geometryBlock.turns, manifestUrl),
      nodes: resolvePath(geometryBlock.nodes ?? geometryBlock.junctions, manifestUrl),
      // Prefer the richer base-network + scenario-additions contract whenever
      // a scenario id is declared. Older packages may not contain this file;
      // loadScenarioNetworkKpiGeometry() then returns null and the inline/root
      // geometry paths remain the compatible fallback. Scenario `sc_geometry`
      // paths are additions, not necessarily a complete network.
      scenarioManifest: scenarioId !== undefined && scenarioId !== null
        ? resolvePath(`geometry/${String(scenarioId)}/manifest.json`, manifestUrl)
        : null,
    },
    bounds: bounds && bounds.every(Number.isFinite) ? bounds : null,
    ramps: parseManifestRamps(root.default_ramps),
    package: pkg,
  };
}

function parseManifestRamps(value: unknown): Partial<Record<NetworkKpiMetric, KpiRamp>> {
  const root = (value ?? {}) as Record<string, unknown>;
  const out: Partial<Record<NetworkKpiMetric, KpiRamp>> = {};
  for (const metric of ["flow", "density", "speed"] as const) {
    const raw = root[metric] as Record<string, unknown> | undefined;
    if (!raw || !Array.isArray(raw.stops) || !Array.isArray(raw.colors)) continue;
    const stops = raw.stops.map(Number);
    const colors = raw.colors.filter((color): color is string => typeof color === "string");
    if (stops.length < 2 || stops.length !== colors.length || stops.some((n) => !Number.isFinite(n))) continue;
    out[metric] = {
      stops,
      colors,
      unit: typeof raw.units === "string" ? raw.units : typeof raw.unit === "string" ? raw.unit : "",
      label: typeof raw.title === "string" ? raw.title : metric,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Package sources (reused wholesale from vehicle-playback).
// ---------------------------------------------------------------------------

export type {
  VehicleDirectoryHandle as NetworkKpiDirectoryHandle,
  VehiclePackageSource as NetworkKpiPackageSource,
};

/** Fetch and parse a package manifest over HTTP. */
export async function fetchNetworkKpiManifestJson(manifestUrl: string): Promise<unknown> {
  return loadCachedHttpPackageManifests(manifestUrl);
}

/** Read a package manifest out of a folder the user picked. */
export async function readLocalNetworkKpiManifestJson(
  root: VehicleDirectoryHandle,
): Promise<unknown> {
  const source = createDirectoryPackageSource(root);
  const bytes = await source.read("manifest.json");
  const legacy = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  try { const pkg = JSON.parse(new TextDecoder().decode(await source.read("geolibre/package.json"))); return attachGeolibrePackage(legacy, pkg); } catch { return legacy; }
}

/** Byte source for a package served over HTTP. */
export function createNetworkKpiHttpSource(manifestUrl: string): VehiclePackageSource {
  return createHttpPackageSource(manifestUrl);
}

/** Byte source for a package read from a picked local folder. */
export function createNetworkKpiDirectorySource(
  root: VehicleDirectoryHandle,
): VehiclePackageSource {
  return createDirectoryPackageSource(root);
}

/**
 * Load the sections and lanes GeoJSON for a package.
 *
 * Delegates to vehicle-playback's own geometry loader (which is already
 * best-effort per file and package-source agnostic) and drops the turns/nodes
 * slots this plugin has no KPI rows for.
 */
export async function loadNetworkKpiGeometry(
  source: VehiclePackageSource,
  sources: NetworkKpiGeometrySources,
): Promise<NetworkKpiGeometry> {
  if (sources.scenarioManifest) {
    const richer = await loadScenarioNetworkKpiGeometry(source, sources.scenarioManifest);
    if (richer) return richer;
  }
  const layers: VehicleGeometryLayers = await loadVehicleGeometry(source, {
    sections: sources.sections,
    lanes: sources.lanes,
    turns: sources.turns,
    nodes: sources.nodes,
  });
  return {
    sections: asFeatureCollection(layers.sections),
    lanes: asFeatureCollection(layers.lanes),
    turns: asFeatureCollection(layers.turns),
    nodes: asFeatureCollection(layers.nodes),
  };
}

type GeometryKind = "sections" | "lanes" | "turns" | "nodes";

interface ScenarioGeometryManifest {
  geometry?: {
    base_networks?: Record<string, unknown>;
    sc_geometry?: Record<string, unknown>;
    sc_non_existent?: unknown;
  };
}

const baseNetworkGeometryCache = new Map<string, Promise<NetworkFeatureCollection | null>>();

export function clearNetworkKpiGeometryCache(): void {
  baseNetworkGeometryCache.clear();
}

/**
 * Load the richer per-scenario geometry contract. A missing scenario manifest
 * deliberately returns null so older packages use the existing loader.
 */
async function loadScenarioNetworkKpiGeometry(
  source: VehiclePackageSource,
  manifestPath: string,
): Promise<NetworkKpiGeometry | null> {
  let manifest: ScenarioGeometryManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await source.read(manifestPath))) as ScenarioGeometryManifest;
  } catch {
    return null;
  }
  const geometry = manifest.geometry ?? {};
  const base = geometry.base_networks ?? {};
  const additions = geometry.sc_geometry ?? {};
  const manifestDir = manifestPath.replace(/[^/\\]+$/, "");
  const resolveContractPath = (value: unknown): string | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    if (source.baseUrl) {
      try { return new URL(value, new URL(manifestPath, source.baseUrl)).toString(); } catch { return null; }
    }
    const parts = `${manifestDir}${value}`.split(/[\\/]+/);
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") { if (out.length) out.pop(); else return null; }
      else out.push(part);
    }
    return out.join("/");
  };
  const parse = async (path: string | null): Promise<NetworkFeatureCollection | null> => {
    if (!path) return null;
    try {
      return asFeatureCollection(JSON.parse(new TextDecoder().decode(await source.read(path))));
    } catch { return null; }
  };
  const parseBase = (path: string | null): Promise<NetworkFeatureCollection | null> => {
    if (!path) return Promise.resolve(null);
    const cached = baseNetworkGeometryCache.get(path);
    if (cached) return cached;
    const request = parse(path);
    baseNetworkGeometryCache.set(path, request);
    return request;
  };
  let removed: Record<string, unknown> = {};
  const removedPath = resolveContractPath(geometry.sc_non_existent);
  if (removedPath) {
    try {
      const raw = JSON.parse(new TextDecoder().decode(await source.read(removedPath))) as Record<string, unknown>;
      removed = (raw.removed_ids ?? {}) as Record<string, unknown>;
    } catch { /* missing optional removal file means no removals */ }
  }
  const declarations: Record<GeometryKind, [string, string]> = {
    sections: ["centerlines", "centerlines"],
    lanes: ["lanes", "lanes"],
    turns: ["turns", "turns"],
    nodes: ["nodes", "nodes"],
  };
  const merge = async (kind: GeometryKind): Promise<NetworkFeatureCollection | null> => {
    const [baseKey, additionKey] = declarations[kind];
    const [baseFeatures, additionFeatures] = await Promise.all([
      parseBase(resolveContractPath(base[baseKey])),
      parse(resolveContractPath(additions[additionKey])),
    ]);
    if (!baseFeatures && !additionFeatures) return null;
    const blocked = new Set((Array.isArray(removed[kind]) ? removed[kind] : [])
      .map((id) => String(id)));
    const stableId = (feature: NetworkFeature): string | null => {
      const props = feature.properties ?? {};
      for (const key of ["section_id", "node_id", "turn_id", "building_id", "oid", "id"]) {
        if (props[key] !== undefined && props[key] !== null) return String(props[key]);
      }
      return null;
    };
    const features = (baseFeatures?.features ?? []).filter((feature) => {
      const id = stableId(feature);
      return id === null || !blocked.has(id);
    });
    features.push(...(additionFeatures?.features ?? []));
    return { type: "FeatureCollection", features };
  };
  const [sections, lanes, turns, nodes] = await Promise.all([
    merge("sections"), merge("lanes"), merge("turns"), merge("nodes"),
  ]);
  return { sections, lanes, turns, nodes };
}

// ---------------------------------------------------------------------------
// Geometry, narrowed to the shape the renderer joins against.
// ---------------------------------------------------------------------------

/** A network geometry feature carrying the join keys this plugin needs. */
export interface NetworkFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

export interface NetworkFeatureCollection {
  type: "FeatureCollection";
  features: NetworkFeature[];
}

export interface NetworkKpiGeometry {
  sections: NetworkFeatureCollection | null;
  lanes: NetworkFeatureCollection | null;
  turns: NetworkFeatureCollection | null;
  nodes: NetworkFeatureCollection | null;
}

/** Narrow a parsed GeoJSON blob to a feature collection, or null if it is not one. */
function asFeatureCollection(value: unknown): NetworkFeatureCollection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; features?: unknown };
  if (candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) return null;
  return value as NetworkFeatureCollection;
}

/**
 * The section id a feature joins to `MISECT.oid` / `MILANE.oid` by.
 *
 * Testudo's exporter writes `section_id` on both sections and lanes (confirmed
 * on real exports); `oid` and `id` are accepted as fallbacks so a package from
 * an older or hand-built exporter still joins.
 */
export function featureSectionId(feature: NetworkFeature): number | null {
  const props = feature.properties;
  if (!props) return null;
  for (const key of ["section_id", "oid", "id"]) {
    const value = Number(props[key]);
    if (Number.isFinite(value)) return Math.trunc(value);
  }
  return null;
}

/**
 * The 0-indexed lane number of a lane feature.
 *
 * The geometry exporter writes `lane_index` starting at 0, while Aimsun's
 * `MILANE.lane` column starts at 1 — see {@link laneKey} for where that
 * off-by-one is reconciled.
 */
export function featureLaneIndex(feature: NetworkFeature): number | null {
  const props = feature.properties;
  if (!props) return null;
  for (const key of ["lane_index", "lane", "index"]) {
    if (!(key in props)) continue;
    const value = Number(props[key]);
    if (Number.isFinite(value)) return Math.trunc(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Results database.
// ---------------------------------------------------------------------------

/** One section's or one lane's KPI triple. */
export interface KpiRow {
  flow: number | null;
  density: number | null;
  speed: number | null;
  /** Not yet queried from the results database; always null until wired up. */
  delay: number | null;
}

/** A section's values at one persisted simulation interval (`ent`). */
export interface NetworkKpiSectionSample extends KpiRow {
  interval: number;
}

/**
 * A loaded results slice: KPI values keyed for O(1) lookup during rendering.
 *
 * Sections are keyed by their raw `oid`. Lanes are keyed by
 * {@link laneKey}, i.e. `oid:laneIndex` with the lane index already converted to
 * the geometry's 0-indexed convention, so the renderer joins without redoing
 * the off-by-one each frame.
 */
export interface NetworkKpiResults {
  sections: Map<number, KpiRow>;
  lanes: Map<string, KpiRow>;
  /** Every interval (`ent`) the database offers, ascending; 0 is the aggregate. */
  intervals: number[];
  /** Every statistic slice (`sid`) present; 0 is "all vehicle types". */
  sids: number[];
  /** Every replication/database id (`did`) present. */
  dids: number[];
  /** The slice these maps were built for. */
  did: number | null;
  sid: number;
  interval: number;
}

/**
 * Composite key joining a `MILANE` row to a lane geometry feature.
 *
 * `laneIndex` is the GEOMETRY-side 0-indexed value. Aimsun's `MILANE.lane`
 * column is 1-indexed, so the query subtracts one before this is called; the
 * same off-by-one was already found and fixed on the Python export path, and
 * this is the same correction applied on the client side.
 */
export function laneKey(oid: number, laneIndex: number): string {
  return `${oid}:${laneIndex}`;
}

/**
 * Whether a raw result value means "no data for this interval".
 *
 * Aimsun writes -1 (and other negatives) into result columns that have no
 * measurement for the interval — most visibly `speed` on a section no vehicle
 * entered. Rendering those as a real 0 would paint empty roads as
 * maximum-congestion red, so they are filtered to null here and skipped by the
 * renderer entirely.
 */
function usableValue(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num < 0 ? null : num;
}

/**
 * Load the sql.js (SQLite/WASM) factory once and memoize it.
 *
 * Mirrors `loadSqlJs` in the desktop app's `gpkg-ogr-contents.ts`, which is the
 * established WASM-loading convention in this repo: the `.wasm` is imported
 * through Vite's `?url` so it is bundled locally and works offline and inside
 * the Tauri webview, rather than being fetched from a CDN at runtime. That
 * helper lives in the app package and this is the plugins package, so it is
 * re-stated here rather than imported across the dependency direction.
 *
 * The promise is cleared on failure so a later attempt retries instead of
 * permanently caching a rejection.
 */
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

export async function loadNetworkKpiSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= (async () => {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      import("sql.js/dist/sql-wasm.wasm?url"),
    ]);
    return initSqlJs({ locateFile: () => wasmUrl });
  })();
  try {
    return await sqlJsPromise;
  } catch (error) {
    sqlJsPromise = null;
    throw error;
  }
}

/** Pick one metric out of a KPI row. */
export function kpiValue(row: KpiRow | undefined, metric: NetworkKpiMetric): number | null {
  if (!row) return null;
  return row[metric];
}
