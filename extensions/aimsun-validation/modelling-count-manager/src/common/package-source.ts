/**
 * Package discovery for the detector plugins. Three ways in, one index out:
 *   1. a manifest URL (`?aimsunPackage=<url>` or typed in the panel);
 *   2. a folder chosen with <input webkitdirectory> (the data root `<RUN>/detectors_*.parquet`, or one run folder);
 *   3. (tests) any list of {path, read}.
 *
 * The delivery is multi-run (`data/<RUN>/detectors_sim.parquet`, ...), which the shared
 * `loadPackage` (one table per name) cannot express, so discovery is by file name and the
 * bytes are registered by the controller with the shared `registerTable`.
 *
 * Manifest forms understood (schema_version 1):
 *   - `files: [{ table?, path, run?, sha256? }]`          (shared loadPackage style)
 *   - `outputs_sha256: { "<RUN>/detectors_sim.parquet": "<sha>" }` (manifest_tabular.json)
 *   - `runs: [{ run, available }]`  runs with available === false are dropped.
 * `path` is relative to the manifest URL; the run is the entry's `run`, else the parent
 * directory name, else the manifest `run`.
 */
import { isSafePackagePath, resolveInsidePackage, sha256Hex } from "../../../_shared/src/package.ts";
import type { ObservedMeta } from "./sql.ts";

export type { ObservedMeta };
export type FileKind = "sim" | "obs" | "geo" | "meta";

/**
 * Validate the `observed` block of a run/analysis manifest (contract C3). Returns undefined when
 * absent (legacy: 2025-01-01, 5-minute grid, interval-end); throws a descriptive Error when present
 * but unusable, so a wrong grid or unit is never silently validated against.
 */
export function parseObserved(v: unknown, where = "observed"): ObservedMeta | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new Error(`${where}: must be an object`);
  const o = v as Record<string, unknown>;
  const day = o.referenceDay;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`${where}.referenceDay must be YYYY-MM-DD`);
  }
  const grid = o.gridSeconds;
  if (typeof grid !== "number" || !Number.isInteger(grid) || grid <= 0 || grid % 60 !== 0) {
    throw new Error(`${where}.gridSeconds must be a positive whole number of minutes (in seconds)`);
  }
  const units = o.units ?? "veh/h";
  if (units !== "veh/h") throw new Error(`${where}.units '${String(units)}' is not supported (expected veh/h)`);
  const conv = o.timestampConvention ?? "interval-end";
  if (conv !== "interval-end" && conv !== "interval-start") {
    throw new Error(`${where}.timestampConvention must be interval-end or interval-start`);
  }
  return { referenceDay: day, gridSeconds: grid, units: "veh/h", timestampConvention: conv, source: typeof o.source === "string" ? o.source : undefined };
}

export interface PkgFile {
  path: string;
  run: string;
  kind: FileKind;
  read(): Promise<Uint8Array>;
  sha256?: string;
}

export interface RunEntry {
  run: string;
  sim: PkgFile;
  obs?: PkgFile;
  geo: PkgFile | null;
  /** From the manifest (`observed`, top level or per run); wins over `meta`. */
  observed?: ObservedMeta;
  /** analysis_manifest.json (run folder) / analysis.json (shared) carrying `observed`. */
  meta?: PkgFile | null;
}

export interface PackageIndex {
  label: string;
  runs: RunEntry[];
  /** Runs that exist but lack simulated or observed detectors. */
  incomplete: string[];
}

export const RUN_ORDER = ["AMPK_3", "AMPK_3b", "PMPK_3"];

const NAMES: Record<string, FileKind> = {
  "detectors_sim.parquet": "sim",
  "detectors_obs.parquet": "obs",
  "detectors.geojson": "geo",
  "detectors.json": "geo",
  "analysis_manifest.json": "meta",
  "analysis.json": "meta",
};

export function classifyPath(path: string): { run: string; kind: FileKind } | null {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = segs[segs.length - 1]?.toLowerCase();
  const kind = base ? NAMES[base] : undefined;
  if (!kind) return null;
  return { run: segs.length >= 2 ? segs[segs.length - 2] : "", kind };
}

/** Manifest `table` names that identify a detector file whose path does not (e.g. a content-addressed or renamed file). */
const TABLE_KINDS: Record<string, FileKind> = { detectors_sim: "sim", detectors_obs: "obs", detectors_geo: "geo" };

export function sortRuns(runs: string[]): string[] {
  const rank = (r: string): number => {
    const i = RUN_ORDER.indexOf(r);
    return i < 0 ? RUN_ORDER.length : i;
  };
  return [...runs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface RawItem {
  path: string;
  run?: string;
  read: () => Promise<Uint8Array>;
  sha256?: string;
  /** Manifest `table` name: classifies the file when its path is not a recognised detector file name. */
  table?: string;
}

/** Group items into runs. Files with no run directory ("") are shared defaults for runs lacking that kind. */
export function buildIndex(
  label: string,
  items: readonly RawItem[],
  excludeRuns: ReadonlySet<string> = new Set(),
  observed?: { shared?: ObservedMeta; byRun?: ReadonlyMap<string, ObservedMeta> },
): PackageIndex {
  const byRun = new Map<string, Partial<Record<FileKind, PkgFile>>>();
  for (const it of items) {
    const c = classifyPath(it.path);
    const kind = c?.kind ?? (it.table ? TABLE_KINDS[it.table] : undefined);
    if (!kind) continue;
    const run = it.run ?? c?.run ?? "";
    if (excludeRuns.has(run)) continue;
    const slot = byRun.get(run) ?? {};
    // First file wins, so a shallower duplicate does not silently replace a deeper one.
    slot[kind] ??= { path: it.path, run, kind, read: it.read, sha256: it.sha256 };
    byRun.set(run, slot);
  }
  const shared = byRun.get("") ?? {};
  byRun.delete("");
  if (byRun.size === 0 && (shared.sim || shared.obs)) byRun.set("", shared); // a single flat run folder
  const runs: RunEntry[] = [];
  const incomplete: string[] = [];
  for (const name of sortRuns([...byRun.keys()])) {
    const s = byRun.get(name)!;
    const sim = s.sim ?? (name === "" ? undefined : shared.sim);
    const obs = s.obs ?? (name === "" ? undefined : shared.obs);
    const geo = s.geo ?? shared.geo ?? null;
    const meta = s.meta ?? shared.meta ?? null;
    const declared = observed?.byRun?.get(name) ?? observed?.shared;
    if (sim) runs.push({ run: name || label, sim, obs, geo, ...(declared ? { observed: declared } : {}), ...(meta ? { meta } : {}) });
    else incomplete.push(name || label);
  }
  return { label, runs, incomplete };
}

/** Manifest path rules (relative, no '..', no encoded/double-encoded dot segments, no scheme/UNC): the shared helper. */
export const isSafeRelativePath = isSafePackagePath;

/** Resolve a manifest path against the manifest URL and require it to stay inside the package directory. */
export const resolveUrl = resolveInsidePackage;

/** A directory URL (trailing slash) means `<dir>/manifest.json`. */
export function manifestUrlFor(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("empty package URL");
  return s.endsWith("/") ? `${s}manifest.json` : s;
}

/** A declared sha256 must be 64 hex digits (lower-cased); undefined when not declared. */
function checkSha(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${where}: sha256 must be 64 hex digits`);
  return v.toLowerCase();
}

interface ManifestShape {
  schema_version?: unknown;
  run?: unknown;
  files?: Array<{ table?: string; path?: string; run?: string; sha256?: string }>;
  outputs_sha256?: Record<string, string>;
  runs?: Array<{ run?: string; available?: boolean; observed?: unknown }>;
  observed?: unknown;
}

/** Turn a parsed manifest into raw items (pure; `fetchBytes` is injected). */
export function itemsFromManifest(
  manifestUrl: string,
  manifest: unknown,
  fetchBytes: (url: string, path: string, sha256: string | undefined) => Promise<Uint8Array>,
): { items: RawItem[]; exclude: Set<string>; observed: { shared?: ObservedMeta; byRun: Map<string, ObservedMeta> } } {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest: not an object");
  const m = manifest as ManifestShape;
  if (m.schema_version !== 1) throw new Error(`manifest: unsupported schema_version ${String(m.schema_version)} (expected 1)`);
  const entries: Array<{ path: string; run?: string; sha256?: string; table?: string }> = [];
  for (const [i, f] of (m.files ?? []).entries()) {
    if (!isSafeRelativePath(f?.path)) throw new Error(`manifest.files[${i}]: path must be relative, no '..'`);
    entries.push({ path: f.path, run: f.run, table: typeof f.table === "string" ? f.table : undefined, sha256: checkSha(f.sha256, `manifest.files[${i}]`) });
  }
  for (const [path, sha] of Object.entries(m.outputs_sha256 ?? {})) {
    if (!isSafeRelativePath(path)) throw new Error(`manifest.outputs_sha256: unsafe path '${path}'`);
    const known = entries.find((e) => e.path === path);
    const checked = checkSha(sha, `manifest.outputs_sha256['${path}']`);
    if (known) {
      if (known.sha256 && checked && known.sha256 !== checked) throw new Error(`manifest: conflicting sha256 for ${path}`);
      known.sha256 ??= checked;
    } else entries.push({ path, sha256: checked });
  }
  const exclude = new Set((m.runs ?? []).filter((r) => r.available === false && typeof r.run === "string").map((r) => r.run as string));
  const single = typeof m.run === "string" ? m.run : undefined;
  const items: RawItem[] = entries.map((e) => {
    const url = resolveUrl(manifestUrl, e.path);
    const c = classifyPath(e.path);
    return {
      path: e.path,
      run: e.run ?? (c && c.run ? c.run : single),
      sha256: e.sha256,
      table: e.table,
      read: () => fetchBytes(url, e.path, e.sha256),
    };
  });
  const byRun = new Map<string, ObservedMeta>();
  for (const [i, r] of (m.runs ?? []).entries()) {
    if (typeof r?.run !== "string") continue;
    const ob = parseObserved(r.observed, `manifest.runs[${i}].observed`);
    if (ob) byRun.set(r.run, ob);
  }
  return { items, exclude, observed: { shared: parseObserved(m.observed, "manifest.observed"), byRun } };
}

export async function fetchChecked(url: string, path: string, sha256: string | undefined, f: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await f(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch ${path}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256) {
    const got = await sha256Hex(bytes);
    if (got !== sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${path}: expected ${sha256}, got ${got}`);
  }
  return bytes;
}

export async function indexFromManifestUrl(input: string, f: typeof fetch = fetch): Promise<PackageIndex> {
  const url = manifestUrlFor(input);
  const res = await f(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch manifest ${url}: HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  const { items, exclude, observed } = itemsFromManifest(url, json, (u, p, sha) => fetchChecked(u, p, sha, f));
  const idx = buildIndex(url.replace(/[#?].*$/, "").split("/").slice(-2, -1)[0] || url, items, exclude, observed);
  return idx;
}

/** A File (or any Blob with a path) from a folder pick; `webkitRelativePath` carries the layout. */
export interface FileLikeItem {
  path: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

export function indexFromFiles(label: string, files: readonly FileLikeItem[]): PackageIndex {
  const items: RawItem[] = files.map((f) => ({ path: f.path, read: async () => new Uint8Array(await f.arrayBuffer()) }));
  return buildIndex(label, items);
}

/** `webkitRelativePath` is "<picked folder>/<sub>/<file>"; keep it, fall back to the bare name. */
export function filesFromInput(list: ArrayLike<File>): FileLikeItem[] {
  return Array.from(list).map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    arrayBuffer: () => f.arrayBuffer(),
  }));
}
