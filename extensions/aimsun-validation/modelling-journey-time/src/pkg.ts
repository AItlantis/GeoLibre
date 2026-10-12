/**
 * Package loading for the subpath plugins: only the tables these plugins use are read.
 *   subpath_obs_jt (parquet)  route, direction_norm, ts, seconds, source        (required)
 *   subpath_sim_jt (parquet)  route, direction_norm, ts_bucket, seconds         (optional; validation plugin)
 *   subpaths       (geojson)  LineString EPSG:4326, properties name, group_label, section_ids,
 *                             exists_in_run_scenario (optional; map layer + name matching)
 * Sources: a manifest URL (schema_version 1, see _shared/src/package.ts) or a list of picked files
 * (folder or multi-file picker; a manifest.json among them is honoured, else file stems are table names).
 */
import { withDuckDbLock } from "../../_shared/src/lock";
import { registerTable, resolveInsidePackage, sha256Hex, validateManifest, type PackageManifest } from "../../_shared/src/package";
import type { GeoJSONFC } from "./host";
import type { SubpathRef } from "./match";
import { type Session } from "./session";

export type CanonicalTable = "subpath_obs_jt" | "subpath_sim_jt" | "subpaths";

const ALIASES: Record<string, CanonicalTable> = {
  subpath_obs_jt: "subpath_obs_jt",
  subpath_sim_jt: "subpath_sim_jt",
  subpaths: "subpaths",
  subpaths_geo: "subpaths",
};

export function canonicalTable(name: string): CanonicalTable | null {
  return ALIASES[name.toLowerCase()] ?? null;
}

export interface PackageSummary {
  run: string | null;
  origin: string;
  tables: Array<{ table: CanonicalTable; rows: number; bytes: number }>;
  geo: GeoJSONFC | null;
  hasObs: boolean;
  hasSim: boolean;
  /** Non-fatal observations, shown in the panel. */
  notes: string[];
}

export interface LoadOptions {
  fetchImpl?: typeof fetch;
  verifyHash?: boolean;
}

/** Parse a subpaths FeatureCollection; non-line geometries are kept out of the map but listed in notes. */
export function parseSubpathGeoJson(json: unknown): { fc: GeoJSONFC; skipped: number } {
  const o = json as { type?: string; features?: unknown };
  if (!o || o.type !== "FeatureCollection" || !Array.isArray(o.features)) throw new Error("subpaths: not a GeoJSON FeatureCollection");
  const features = (o.features as GeoJSONFC["features"]).filter((f) => f && f.type === "Feature");
  const lines = features.filter((f) => f.geometry && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString"));
  return { fc: { type: "FeatureCollection", features: lines }, skipped: features.length - lines.length };
}

/** Subpath references (name/group/exists flag) from the geometry file's properties. */
export function subpathRefs(fc: GeoJSONFC | null): SubpathRef[] {
  if (!fc) return [];
  return fc.features.map((f, i) => {
    const p = f.properties ?? {};
    const exists = typeof p.exists_in_run_scenario === "boolean" ? (p.exists_in_run_scenario as boolean) : null;
    return {
      id: (p.id as string | number | undefined) ?? f.id ?? i,
      name: String(p.name ?? ""),
      group: p.group_label === undefined || p.group_label === null ? null : String(p.group_label),
      exists,
    };
  });
}

const WANTED: CanonicalTable[] = ["subpath_obs_jt", "subpath_sim_jt", "subpaths"];

async function reset(s: Session): Promise<void> {
  await s.exec(
    "DROP VIEW IF EXISTS v_sp_obs; DROP VIEW IF EXISTS v_sp_obs_day; DROP VIEW IF EXISTS v_sp_sim;" +
      " DROP TABLE IF EXISTS subpath_obs_jt; DROP TABLE IF EXISTS subpath_sim_jt;",
  );
}

interface Pending {
  table: CanonicalTable;
  name: string;
  bytes: Uint8Array;
  run?: string;
  sha256?: string;
  rows?: number;
}

async function ingest(s: Session, pending: Pending[], origin: string, run: string | null, opts: LoadOptions): Promise<PackageSummary> {
  const out: PackageSummary = { run, origin, tables: [], geo: null, hasObs: false, hasSim: false, notes: [] };
  const simParts: string[] = [];
  let simIndex = 0;
  for (const p of pending) {
    if (p.sha256 && opts.verifyHash !== false) {
      const got = await sha256Hex(p.bytes);
      if (got !== p.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${p.name}: expected ${p.sha256}, got ${got}`);
    }
    let rows: number;
    if (p.table === "subpaths") {
      const { fc, skipped } = parseSubpathGeoJson(JSON.parse(new TextDecoder().decode(p.bytes)));
      out.geo = fc;
      rows = fc.features.length;
      if (skipped) out.notes.push(`${skipped} subpath feature(s) without line geometry were ignored.`);
    } else {
      const target = p.table === "subpath_sim_jt" ? `subpath_sim_jt_part_${simIndex++}` : p.table;
      rows = await registerTable(s, target, p.name, p.bytes, "parquet");
      if (p.table === "subpath_sim_jt") {
        simParts.push(target);
        if (p.run) {
          const cols = await s.query<{ column_name: string }>(`DESCRIBE ${target}`);
          if (!cols.some((c) => String(c.column_name).toLowerCase() === "run")) await s.exec(`ALTER TABLE ${target} ADD COLUMN run VARCHAR`);
          await s.exec(`UPDATE ${target} SET run = '${p.run.replace(/'/g, "''")}' WHERE run IS NULL`);
        }
      }
    }
    if (p.rows !== undefined && p.rows !== rows) throw new Error(`row count mismatch for ${p.name}: manifest ${p.rows}, loaded ${rows}`);
    out.tables.push({ table: p.table, rows, bytes: p.bytes.byteLength });
  }
  if (simParts.length) {
    const union = simParts.map((part) => `SELECT * FROM ${part}`).join(" UNION ALL BY NAME ");
    await s.exec(`CREATE OR REPLACE TABLE subpath_sim_jt AS ${union}`);
    for (const part of simParts) await s.exec(`DROP TABLE IF EXISTS ${part}`);
  }
  out.hasObs = out.tables.some((t) => t.table === "subpath_obs_jt" && t.rows > 0);
  out.hasSim = out.tables.some((t) => t.table === "subpath_sim_jt" && t.rows > 0);
  return out;
}

export async function loadFromManifestUrl(s: Session, manifestUrl: string, opts: LoadOptions = {}): Promise<PackageSummary> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(manifestUrl, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch manifest ${manifestUrl}: HTTP ${res.status}`);
  const manifest = validateManifest(await res.json());
  await reset(s);
  const pending: Pending[] = [];
  for (const e of manifest.files) {
    const table = canonicalTable(e.table);
    if (!table || !WANTED.includes(table)) continue;
    const r = await f(resolveInsidePackage(manifestUrl, e.path), { cache: "no-cache" });
    if (!r.ok) throw new Error(`Could not fetch ${e.path} (table ${e.table}): HTTP ${r.status}`);
    const parent = e.path.replace(/\\/g, "/").split("/").slice(-2, -1)[0];
    const runName = (e as typeof e & { run?: string }).run;
    pending.push({ table, name: e.path, bytes: new Uint8Array(await r.arrayBuffer()), sha256: e.sha256, rows: e.rows,
      run: runName ?? (parent && parent !== "data" ? parent : typeof manifest.run === "string" ? manifest.run : undefined) });
  }
  return withDuckDbLock(() => ingest(s, pending, manifestUrl, typeof manifest.run === "string" ? manifest.run : null, opts));
}

const baseName = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? p;
const stem = (p: string): string => baseName(p).replace(/\.[^.]+$/, "");

/** Decide which picked files feed which tables. Pure, so it is unit-tested. */
export function planFiles(
  names: readonly string[],
  manifest?: PackageManifest,
): Array<{ name: string; table: CanonicalTable; sha256?: string; rows?: number; run?: string }> {
  const plan: Array<{ name: string; table: CanonicalTable; sha256?: string; rows?: number; run?: string }> = [];
  const used = new Set<CanonicalTable>();
  const plannedNames = new Set<string>();
  if (manifest) {
    for (const e of manifest.files) {
      const table = canonicalTable(e.table);
      if (!table || !WANTED.includes(table) || (table !== "subpath_sim_jt" && used.has(table))) continue;
      const hit = names.find((n) => n.replace(/\\/g, "/").endsWith(e.path)) ?? names.find((n) => baseName(n) === baseName(e.path));
      if (hit) {
        const parent = e.path.replace(/\\/g, "/").split("/").slice(-2, -1)[0];
        const inferredRun = table === "subpath_sim_jt" && baseName(e.path).toLowerCase() === "subpath_sim_jt.parquet" && parent && parent !== "data" ? parent : undefined;
        const fileRun = (e as typeof e & { run?: string }).run ?? inferredRun;
        plan.push({ name: hit, table, sha256: e.sha256, rows: e.rows, ...(fileRun ? { run: fileRun } : {}) });
        plannedNames.add(hit);
        if (table !== "subpath_sim_jt") used.add(table);
      }
    }
  }
  for (const n of names) {
    const table = canonicalTable(stem(n));
    if (table && WANTED.includes(table) && !plannedNames.has(n) && (table === "subpath_sim_jt" || !used.has(table)) && /\.(parquet|geojson|json)$/i.test(n)) {
      const parent = n.replace(/\\/g, "/").split("/").slice(-2, -1)[0];
      const run = table === "subpath_sim_jt" && baseName(n).toLowerCase() === "subpath_sim_jt.parquet" && parent && parent !== "data" ? parent : undefined;
      plan.push({ name: n, table, ...(run ? { run } : {}) });
      if (table !== "subpath_sim_jt") used.add(table);
    }
  }
  return plan;
}

export async function loadFromFiles(s: Session, files: readonly File[], opts: LoadOptions = {}): Promise<PackageSummary> {
  const rel = (f: File): string => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const byName = new Map(files.map((f) => [rel(f), f]));
  let manifest: PackageManifest | undefined;
  let run: string | null = null;
  const mf = files.find((f) => baseName(f.name).toLowerCase() === "manifest.json");
  if (mf) {
    try {
      manifest = validateManifest(JSON.parse(await mf.text()));
      if (typeof manifest.run === "string") run = manifest.run;
    } catch {
      manifest = undefined; // not a usable manifest: fall back to file stems
    }
  }
  const plan = planFiles(
    [...byName.keys()].filter((n) => baseName(n).toLowerCase() !== "manifest.json"),
    manifest,
  );
  await reset(s);
  const pending: Pending[] = [];
  for (const p of plan) {
    const file = byName.get(p.name)!;
    pending.push({ table: p.table, name: p.name, bytes: new Uint8Array(await file.arrayBuffer()), sha256: p.sha256, rows: p.rows, run: p.run ?? (p.table === "subpath_sim_jt" ? run ?? undefined : undefined) });
  }
  const dir = files[0] ? rel(files[0]).split("/")[0] : "";
  return withDuckDbLock(() => ingest(s, pending, `picked files${dir && rel(files[0]).includes("/") ? ` (${dir})` : ""}`, run, opts));
}
