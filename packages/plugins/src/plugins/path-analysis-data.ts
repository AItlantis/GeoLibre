// @ts-nocheck
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { createDirectoryPackageSource, loadVehicleGeometry, supportsLocalPackageFolders, type VehicleDirectoryHandle, type VehiclePackageSource, type VehicleGeometryLayers } from "./vehicle-playback-data";
import { attachGeolibrePackage, capabilityAvailable } from "./geolibre-package-loader";
import { normalizeSelectedPathPercentages } from "./path-analysis-ramps";
import { aggregatePathSectionVolumes, type PositionalRouteLink } from "./path-analysis-section-volumes";

export interface PathAnalysisManifest { pathIndex: string | null; geometry: { sections: string | null; lanes: string | null; turns: string | null; nodes: string | null }; bounds: [number, number, number, number] | null; available: boolean; unavailableReason: string | null; }
export interface PathAnalysisSummary { path_count?: number; route_links_count?: number; unique_sections_count?: number; total_demand?: number; [key: string]: unknown; }
export interface PathMatch { route_id: number; demand: number; percentage: number; origin: number; destination: number; vehicle: number; interval: number; }
export type PathRule = "or" | "and";
export type PathSectionVolume = { section_id: number; volume: number; percentage: number; role: "upstream" | "selected" | "downstream" };
export type PathAnalysisQueryResult = { matches: PathMatch[]; selectedVolume: number; sections: PathSectionVolume[] };
export interface PathAnalysisData { summary: PathAnalysisSummary; geometry: VehicleGeometryLayers; intervals: number[]; query(sectionIds: number[], rule: PathRule, interval?: number): Promise<PathMatch[]>; querySectionVolumes(sectionIds: number[], rule: PathRule, interval: number, selectedSection: number): Promise<PathAnalysisQueryResult>; sequence(routeId: number): Promise<number[]>; close(): void; }
let activePathInterval = 0;
export function setPathAnalysisQueryInterval(interval: number): void { activePathInterval = Number.isFinite(Number(interval)) ? Math.max(0, Math.trunc(Number(interval))) : 0; }

const resolve = (v: unknown, base: string | null) => typeof v === "string" && v ? (base ? new URL(v, base).toString() : v) : null;
const safeNumber = (value: unknown, fallback = 0) => { const num = Number(value); return Number.isFinite(num) ? num : fallback; };
export function canLoadLocalPathAnalysisPackage(): boolean { return supportsLocalPackageFolders(); }
export async function readLocalPathAnalysisManifestJson(root: VehicleDirectoryHandle): Promise<unknown> {
  const source = createDirectoryPackageSource(root);
  const legacy = JSON.parse(new TextDecoder("utf-8").decode(await source.read("manifest.json")));
  try { return attachGeolibrePackage(legacy, JSON.parse(new TextDecoder().decode(await source.read("geolibre/package.json")))); } catch { return legacy; }
}
export function createPathAnalysisDirectorySource(root: VehicleDirectoryHandle): VehiclePackageSource { return createDirectoryPackageSource(root); }
// Picks which per-scenario/per-did path index to use when the manifest
// carries several (`path_indices` / the envelope's `pathIndicesByScid`,
// e.g. Riyadh's {"0": "indexed_paths/0", "240157": "indexed_paths/240157"})
// but no single `path_index`. This plugin has no per-scenario/did selection
// UI (see PathAnalysisPanel.tsx / maplibre-path-analysis.ts — the manifest
// is loaded once for the whole package, not per active scid/did), so there
// is no "currently selected" key to match against. Key "0" — the network-
// wide / base index that every observed package exports alongside any
// scenario-specific ones — is preferred when present; otherwise the first
// entry (by ascending key) is used as a stable, deterministic default.
function pickPathIndicesEntry(indices: Record<string, unknown> | null): string | null {
  if (!indices) return null;
  if (typeof indices["0"] === "string" && indices["0"]) return indices["0"];
  const keys = Object.keys(indices).filter((k) => typeof indices[k] === "string" && indices[k]).sort();
  return keys.length ? (indices[keys[0]] as string) : null;
}

export function parsePathAnalysisManifest(raw: unknown, manifestUrl: string | null): PathAnalysisManifest {
  const root = (raw ?? {}) as Record<string, any>;
  // The parsed geolibre/package.json envelope is attached under a private key
  // by attachGeolibrePackage() (see geolibre-package-loader.ts) — `raw.geolibre`
  // is never a real property, it was always undefined here, so `available`
  // was always false and every package looked like it had no path data.
  // Fail-OPEN, matching capabilityAvailable() usage elsewhere (network-kpi,
  // vehicle-playback): a manifest that simply omits the `paths` capability
  // key is treated as available. Only an explicit non-"available" state
  // (e.g. "unavailable") should surface the error below.
  const { available, reason } = capabilityAvailable(raw, "paths");
  const animations = Array.isArray(root.animations) ? root.animations as Record<string, any>[] : [];
  const scope = animations.length ? animations[0] : root;
  const metadata = { ...((root.metadata ?? {}) as Record<string, any>), ...((scope.metadata ?? {}) as Record<string, any>) };
  const rawBounds = (metadata.bounds ?? null) as Record<string, unknown> | null;
  const bounds = rawBounds ? [safeNumber(rawBounds.min_lon, Number.NaN), safeNumber(rawBounds.min_lat, Number.NaN), safeNumber(rawBounds.max_lon, Number.NaN), safeNumber(rawBounds.max_lat, Number.NaN)] as [number, number, number, number] : null;
  const g = (root.geometry ?? {}) as Record<string, any>;
  // `path_index` (singular) is the legacy single-index field. Newer packages
  // (e.g. Riyadh's testudo-package-2026-09-20-geom) leave it `null` and
  // instead publish `path_indices` (manifest.json) / `pathIndicesByScid`
  // (geolibre/package.json) keyed by scid — only reading the singular field
  // meant `pathIndex` resolved to `null` for every such package regardless
  // of the `paths` capability state, so `loadPathAnalysis()` always threw
  // "Path data is unavailable in this package." even when `available` was
  // true and real index files existed on disk.
  const indices = (root.path_indices ?? root.pathIndicesByScid ?? null) as Record<string, unknown> | null;
  const pathIndex = root.path_index ?? pickPathIndicesEntry(indices);
  return { pathIndex: resolve(pathIndex, manifestUrl), geometry: { sections: resolve(g.sections, manifestUrl), lanes: resolve(g.lanes, manifestUrl), turns: resolve(g.turns, manifestUrl), nodes: resolve(g.nodes ?? g.junctions, manifestUrl) }, bounds: bounds && bounds.every(Number.isFinite) ? bounds : null, available, unavailableReason: reason };
}

async function makeDb(files: Record<string, ArrayBuffer>, urls: Record<string, string> = {}) {
  const bundle = await duckdb.selectBundle({ mvp: { mainModule: duckdbWasmMvp, mainWorker: mvpWorker }, eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker } });
  const worker = new Worker(bundle.mainWorker!, { type: "module" }); const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker); await db.instantiate(bundle.mainModule, bundle.pthreadWorker); await db.open({});
  const extensionConnection = await db.connect();
  try { await extensionConnection.query("LOAD parquet"); } finally { await extensionConnection.close(); }
  for (const [name, bytes] of Object.entries(files)) {
    const url = urls[name];
    if (url) await db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, true);
    else await db.registerFileBuffer(name, new Uint8Array(bytes));
  }
  return { db, worker };
}
export async function loadPathAnalysis(source: VehiclePackageSource, manifest: PathAnalysisManifest): Promise<PathAnalysisData> {
  if (!manifest.available) throw new Error(manifest.unavailableReason ?? "Path data is unavailable in this package.");
  // Distinct from the capability-level "unavailable" above: the package does
  // support paths, but neither `path_index` nor any `path_indices` /
  // `pathIndicesByScid` entry could be resolved (e.g. both fields missing or
  // empty) — a more specific condition than "this package has no path
  // feature at all".
  if (!manifest.pathIndex) throw new Error("No path index found for this package (no path_index or path_indices entry).");
  const base = manifest.pathIndex.replace(/\/$/, ""); const read = (p: string) => source.read(`${base}/${p}`);
  const meta = await read("metadata.json");
  const empty = new ArrayBuffer(0);
  const [link, routes, routeLinks] = source.baseUrl
    ? [empty, empty, empty]
    : await Promise.all([read("link_to_routes.parquet"), read("routes.parquet"), read("route_links.parquet")]);
  const urls = source.baseUrl ? {
    "link_to_routes.parquet": new URL("link_to_routes.parquet", `${base}/`).toString(),
    "routes.parquet": new URL("routes.parquet", `${base}/`).toString(),
    "route_links.parquet": new URL("route_links.parquet", `${base}/`).toString(),
  } : {};
  const { db, worker } = await makeDb({ "link_to_routes.parquet": link, "routes.parquet": routes, "route_links.parquet": routeLinks }, urls); const conn = await db.connect();
  const rows = async (sql: string) => (await conn.query(sql)).toArray() as any[];
  const geometry = await loadVehicleGeometry(source, manifest.geometry);
  const intervalRows = await rows("SELECT DISTINCT interval FROM read_parquet(['routes.parquet']) ORDER BY interval");
  const intervals = [...new Set(intervalRows.map((x) => Number(x.interval)).filter(Number.isFinite))].sort((a,b) => a-b);
  const normalizedIds = (sectionIds: number[]) => [...new Set(sectionIds.map((id) => Math.trunc(Number(id))).filter(Number.isFinite))];
  const fetchMatches = async (ids: number[], rule: PathRule, interval: number, anchor?: number): Promise<PathMatch[]> => {
    if (!ids.length) return [];
    const inClause = ids.join(",");
    const matched = rule === "and"
      ? `SELECT route_id FROM read_parquet(['link_to_routes.parquet']) WHERE section_id IN (${inClause}) GROUP BY route_id HAVING COUNT(DISTINCT section_id) = ${ids.length}`
      : `SELECT DISTINCT route_id FROM read_parquet(['link_to_routes.parquet']) WHERE section_id IN (${inClause})`;
    const anchorClause = Number.isFinite(anchor)
      ? ` AND EXISTS (SELECT 1 FROM read_parquet(['link_to_routes.parquet']) anchor WHERE anchor.route_id = r.route_id AND anchor.section_id = ${Math.trunc(anchor!)})`
      : "";
    // A malformed/duplicated routes row must not duplicate a route's demand.
    const out = await rows(`SELECT route_id, demand, percentage, origin, destination, vehicle, interval FROM (SELECT r.route_id, r.demand, r.percentage, r.origin, r.destination, r.vehicle, r.interval, ROW_NUMBER() OVER (PARTITION BY r.route_id ORDER BY r.demand DESC) AS route_rank FROM (${matched}) m JOIN read_parquet(['routes.parquet']) r USING (route_id) WHERE r.interval = ${Math.trunc(Number(interval))}${anchorClause}) ranked WHERE route_rank = 1 ORDER BY demand DESC`);
    const numeric = out.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number(v)]))) as PathMatch[];
    return normalizeSelectedPathPercentages(numeric);
  };
  return {
    summary: JSON.parse(new TextDecoder().decode(meta)), geometry, intervals,
    async query(sectionIds, rule, interval = 0) {
      return fetchMatches(normalizedIds(sectionIds), rule, interval);
    },
    async querySectionVolumes(sectionIds, rule, interval, selectedSection) {
      const ids = normalizedIds(sectionIds);
      const selected = Math.trunc(Number(selectedSection));
      if (!ids.length) return { matches: [], selectedVolume: 0, sections: [] };
      // Preserve matching paths for clients even if the reference is invalid
      // for this selection; no section values can be normalized in that case.
      if (!Number.isFinite(selected) || !ids.includes(selected)) {
        return { matches: await fetchMatches(ids, rule, interval), selectedVolume: 0, sections: [] };
      }
      // The clicked section anchors the cohort in addition to OR/AND matching
      // the selected set (notably, OR alone could otherwise admit unrelated routes).
      const matches = await fetchMatches(ids, rule, interval, selected);
      if (!matches.length) return { matches, selectedVolume: 0, sections: [] };
      const routeIds = [...new Set(matches.map((match) => match.route_id))];
      const routeIdClause = routeIds.join(",");
      const linkRows = await rows(`SELECT route_id, section_id, pos FROM read_parquet(['route_links.parquet']) WHERE route_id IN (${routeIdClause}) ORDER BY route_id, pos`);
      const routeLinks = linkRows.map((row) => ({ route_id: Number(row.route_id), section_id: Number(row.section_id), pos: Number(row.pos) })) as PositionalRouteLink[];
      const aggregate = aggregatePathSectionVolumes(matches, routeLinks, selected);
      return { matches, ...aggregate };
    },
    async sequence(routeId) {
      const out = await rows(`SELECT section_id FROM read_parquet(['route_links.parquet']) WHERE route_id = ${Math.trunc(Number(routeId))} ORDER BY pos`);
      return out.map((x) => Number(x.section_id));
    },
    close() { void conn.close(); void db.terminate(); worker.terminate(); },
  };
}
