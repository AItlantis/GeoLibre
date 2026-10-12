/**
 * Package discovery for the OD plugins. Two ways in, one index out:
 *   1. a manifest URL (`?aimsunPackage=<url>` or typed in the panel; a directory URL means <dir>/manifest.json);
 *   2. a folder picked with <input webkitdirectory> (the data root `<RUN>/od_before.parquet`, or one run folder).
 *
 * The delivery is multi-run (`data/<RUN>/{od_before,od_after}.parquet, centroids.geojson, groupings.parquet`),
 * so discovery is by file name, same as the detector plugins. Nothing is read here: a {@link Src} only
 * describes where the bytes are; the DuckDB layer registers them as a file handle / URL so the
 * 4.4M-row matrices are streamed by DuckDB and never become JS arrays.
 *
 * Manifest forms understood (schema_version 1): `files[{path,run?}]`, `outputs{<name>:{...}}` (aconsole
 * fragment, relative to the manifest), `outputs_sha256{"<RUN>/<name>":sha}` (tabular fragment) and
 * `runs[{run,available}]` / `run` (runs with available === false are dropped). Runs named by the
 * manifest but without explicit OD paths are probed by convention (`<manifest dir>/<RUN>/od_before.parquet`,
 * or the manifest dir itself when the manifest sits in the run folder).
 */

import { isSafePackagePath, resolveInsidePackage } from "../_shared/src/package.ts";

export type OdKind = "before" | "after" | "centroids" | "groupings";

export interface Src {
  name: string;
  kind: "url" | "file";
  url?: string;
  file?: Blob;
  sha256?: string;
}

export interface RunFiles {
  run: string;
  before: Src;
  after: Src;
  centroids: Src;
  groupings: Src | null;
}

export interface OdPackageIndex {
  label: string;
  runs: RunFiles[];
  /** Runs seen but missing a required file (od_before/od_after/centroids), with the missing kinds. */
  incomplete: Array<{ run: string; missing: OdKind[] }>;
}

export const RUN_ORDER = ["AMPK_3", "AMPK_3b", "PMPK_3"];

const NAMES: Record<string, OdKind> = {
  "od_before.parquet": "before",
  "od_after.parquet": "after",
  "centroids.geojson": "centroids",
  "centroids.json": "centroids",
  "groupings.parquet": "groupings",
};

export function classifyPath(path: string): { run: string; kind: OdKind } | null {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = segs[segs.length - 1]?.toLowerCase();
  const kind = base ? NAMES[base] : undefined;
  if (!kind) return null;
  return { run: segs.length >= 2 ? segs[segs.length - 2] : "", kind };
}

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
  src: Src;
}

/** Group items into runs; files without a run folder act as shared defaults (centroids/groupings are identical across runs). */
export function buildIndex(label: string, items: readonly RawItem[], excludeRuns: ReadonlySet<string> = new Set()): OdPackageIndex {
  const byRun = new Map<string, Partial<Record<OdKind, Src>>>();
  for (const it of items) {
    const c = classifyPath(it.path);
    if (!c) continue;
    const run = it.run ?? c.run;
    if (excludeRuns.has(run)) continue;
    const slot = byRun.get(run) ?? {};
    slot[c.kind] ??= it.src; // first file wins
    byRun.set(run, slot);
  }
  const shared = byRun.get("") ?? {};
  byRun.delete("");
  if (byRun.size === 0 && (shared.before || shared.after)) byRun.set("", shared); // one flat run folder
  const runs: RunFiles[] = [];
  const incomplete: OdPackageIndex["incomplete"] = [];
  for (const name of sortRuns([...byRun.keys()])) {
    const s = byRun.get(name)!;
    const pick = (k: OdKind): Src | undefined => s[k] ?? (name === "" ? undefined : shared[k]);
    const missing = (["before", "after", "centroids"] as const).filter((k) => !pick(k));
    if (missing.length) incomplete.push({ run: name || label, missing });
    else runs.push({ run: name || label, before: pick("before")!, after: pick("after")!, centroids: pick("centroids")!, groupings: pick("groupings") ?? null });
  }
  return { label, runs, incomplete };
}

/** Manifest paths must be relative and stay inside the package (shared helper: encoded dot segments, backslashes, schemes, UNC). */
export const isSafeRelativePath = isSafePackagePath;

/** Resolve a manifest-relative path against the manifest URL; throws when it would leave the package directory. */
export function resolveUrl(base: string, rel: string): string {
  return resolveInsidePackage(base, rel);
}

/** A directory URL (trailing slash) means `<dir>/manifest.json`. */
export function manifestUrlFor(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("empty package URL");
  return s.endsWith("/") ? `${s}manifest.json` : s;
}

interface ManifestShape {
  schema_version?: unknown;
  run?: unknown;
  files?: Array<{ path?: string; run?: string; sha256?: string }>;
  outputs?: Record<string, { sha256?: string } | string>;
  outputs_sha256?: Record<string, string>;
  runs?: Array<{ run?: string; available?: boolean }>;
}

/**
 * Manifest -> raw items + the runs to probe by convention. Pure. `exists(url)` is injected for the probe.
 */
export async function itemsFromManifest(
  manifestUrl: string,
  manifest: unknown,
  exists: (url: string) => Promise<boolean>,
): Promise<{ items: RawItem[]; exclude: Set<string> }> {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest: not an object");
  const m = manifest as ManifestShape;
  if (m.schema_version !== 1) throw new Error(`manifest: unsupported schema_version ${String(m.schema_version)} (expected 1)`);
  const entries: Array<{ path: string; run?: string; sha256?: string }> = [];
  for (const [i, f] of (m.files ?? []).entries()) {
    if (!isSafeRelativePath(f?.path)) throw new Error(`manifest.files[${i}]: path must be relative, no '..'`);
    entries.push({ path: f.path, run: f.run, sha256: f.sha256 });
  }
  for (const [path, v] of Object.entries(m.outputs ?? {})) {
    if (!isSafeRelativePath(path)) throw new Error(`manifest.outputs: unsafe path '${path}'`);
    entries.push({ path, sha256: typeof v === "object" ? v?.sha256 : undefined });
  }
  for (const [path, sha] of Object.entries(m.outputs_sha256 ?? {})) {
    if (!isSafeRelativePath(path)) throw new Error(`manifest.outputs_sha256: unsafe path '${path}'`);
    entries.push({ path, sha256: sha });
  }
  const available = (m.runs ?? []).filter((r) => typeof r.run === "string");
  const exclude = new Set(available.filter((r) => r.available === false).map((r) => r.run as string));
  const single = typeof m.run === "string" ? m.run : undefined;
  const mk = (path: string, run: string | undefined, sha?: string): RawItem => {
    const url = resolveUrl(manifestUrl, path);
    return { path, run, src: { name: path, kind: "url", url, sha256: sha } };
  };
  const items: RawItem[] = [];
  for (const e of entries) {
    const c = classifyPath(e.path);
    if (!c) continue;
    items.push(mk(e.path, e.run ?? (c.run ? c.run : single), e.sha256));
  }
  // convention probe for runs without explicit OD paths
  const have = new Set(items.filter((i) => classifyPath(i.path)?.kind === "before").map((i) => i.run));
  const wanted = new Set<string>([...available.filter((r) => r.available !== false).map((r) => r.run as string), ...(single ? [single] : [])]);
  for (const run of wanted) {
    if (!isSafePackagePath(run) || run.includes("/")) throw new Error(`manifest: unsafe run name '${run}'`);
    if (have.has(run) || exclude.has(run)) continue;
    for (const dir of [`${run}/`, ""]) {
      if (await exists(resolveUrl(manifestUrl, `${dir}od_before.parquet`))) {
        for (const name of ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"]) {
          const url = resolveUrl(manifestUrl, `${dir}${name}`);
          if (name === "od_before.parquet" || (await exists(url))) items.push({ path: `${dir}${name}`, run, src: { name: `${dir}${name}`, kind: "url", url } });
        }
        break;
      }
    }
  }
  // files that sit next to the data root (centroids.geojson at the root) stay shared via run ""
  return { items, exclude };
}

export async function urlExists(url: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(url, { method: "HEAD", cache: "no-cache" });
    return r.ok;
  } catch {
    return false;
  }
}

export async function indexFromManifestUrl(input: string, f: typeof fetch = fetch): Promise<OdPackageIndex> {
  const url = manifestUrlFor(input);
  const res = await f(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch manifest ${url}: HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  const { items, exclude } = await itemsFromManifest(url, json, (u) => urlExists(u, f));
  return buildIndex(url.replace(/[#?].*$/, "").split("/").slice(-2, -1)[0] || url, items, exclude);
}

/** `webkitRelativePath` is "<picked folder>/<sub>/<file>"; keep it, fall back to the bare name. */
export function indexFromFiles(label: string, list: ArrayLike<File>): OdPackageIndex {
  const items: RawItem[] = Array.from(list).map((f) => {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    return { path, src: { name: path, kind: "file", file: f } };
  });
  const label2 = Array.from(list)[0] ? ((list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || "").split("/")[0] || label : label;
  return buildIndex(label2 || label, items);
}
