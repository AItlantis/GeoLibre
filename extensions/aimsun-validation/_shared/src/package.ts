/**
 * Package loader: reads a run package manifest.json (schema_version 1) and registers each
 * listed file as a DuckDB table.
 *
 * manifest.json (schema_version 1):
 * {
 *   "schema_version": 1,
 *   "run": "AMPK_3",                      // optional, free text
 *   "files": [
 *     { "table": "od_before", "path": "od_before.parquet", "format": "parquet",
 *       "sha256": "<hex>", "rows": 12345 },
 *     { "table": "centroids_geo", "path": "centroids.geojson", "format": "geojson" }
 *   ]
 * }
 * `path` is relative to the manifest URL and must stay inside the manifest's directory
 * (see {@link resolveInsidePackage}: no "..", encoded dot segments, backslashes, schemes, UNC). `format` defaults to
 * the file extension. `sha256` and `rows`, when present, are verified.
 * GeoJSON tables get one row per feature: the `properties` struct is flattened into
 * columns, plus `geometry` (JSON text). No spatial extension required.
 */
import type { DuckDbHandle } from "./duckdb";

export interface PackageFileEntry {
  table: string;
  path: string;
  format?: "parquet" | "geojson";
  sha256?: string;
  rows?: number;
}

export interface PackageManifest {
  schema_version: 1;
  run?: string;
  files: PackageFileEntry[];
  [k: string]: unknown;
}

export interface LoadedTable {
  table: string;
  rows: number;
  format: "parquet" | "geojson";
  bytes: number;
}

export interface LoadedPackage {
  manifest: PackageManifest;
  baseUrl: string;
  tables: LoadedTable[];
}

export interface LoadPackageOptions {
  fetchImpl?: typeof fetch;
  /** Tables that must be present, else throw. */
  requiredTables?: string[];
  /** Verify sha256 when the manifest carries it. Default true (needs crypto.subtle). */
  verifyHash?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws a descriptive Error when the manifest is not a valid schema_version 1 manifest. */
export function validateManifest(m: unknown): PackageManifest {
  if (!m || typeof m !== "object") throw new Error("manifest: not an object");
  const o = m as Record<string, unknown>;
  if (o.schema_version !== 1) throw new Error(`manifest: unsupported schema_version ${String(o.schema_version)} (expected 1)`);
  if (!Array.isArray(o.files)) throw new Error("manifest: 'files' must be an array");
  const seen = new Set<string>();
  for (const [i, f] of o.files.entries()) {
    const e = f as Partial<PackageFileEntry>;
    if (!e || typeof e.table !== "string" || !IDENT.test(e.table)) throw new Error(`manifest.files[${i}]: invalid table name`);
    if (seen.has(e.table)) throw new Error(`manifest.files[${i}]: duplicate table '${e.table}'`);
    seen.add(e.table);
    if (typeof e.path !== "string" || !e.path) throw new Error(`manifest.files[${i}]: missing path`);
    if (!isSafePackagePath(e.path)) throw new Error(`manifest.files[${i}]: path must be relative and stay inside the package`);
    if (e.format !== undefined && e.format !== "parquet" && e.format !== "geojson") throw new Error(`manifest.files[${i}]: unknown format '${String(e.format)}'`);
  }
  return o as unknown as PackageManifest;
}

function formatOf(e: PackageFileEntry): "parquet" | "geojson" {
  if (e.format) return e.format;
  return /\.(geo)?json$/i.test(e.path) ? "geojson" : "parquet";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Syntactic check of a manifest-relative path (before URL resolution). Rejects absolute paths, schemes
 * (http:, file:, C:), UNC / protocol-relative (//host, \host), backslashes, NUL/control characters and any
 * ".." / "." segment hidden behind percent-encoding (%2e%2e, %2E, %252e%252e, %5c ...): the path is decoded
 * repeatedly until stable and the decoded form is checked as well.
 */
export function isSafePackagePath(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false;
  let cur = p;
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-control-regex
    if (cur.includes("\\") || /[\u0000-\u001f\u007f]/.test(cur)) return false;
    if (cur.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cur)) return false;
    if (cur.split("/").some((seg) => seg === ".." || seg.replace(/[ .]+$/, "") === "..")) return false;
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return false; // malformed escape
    }
    if (next === cur) return true;
    cur = next;
  }
  return false; // still decoding after 6 rounds: deliberately obfuscated
}

/** Directory URL (with trailing slash) of a manifest URL; the boundary every package file must stay in. */
export function packageBaseUrl(manifestUrl: string): string {
  const abs = new URL(manifestUrl, typeof document !== "undefined" ? document.baseURI : undefined);
  abs.search = "";
  abs.hash = "";
  return new URL(".", abs).href;
}

/**
 * Resolve manifest-relative `rel` against the manifest URL (or its directory) and guarantee the result is
 * INSIDE the package directory: the resolved, normalised href must start with the package base URL.
 * Throws otherwise. Use it everywhere a manifest path becomes a URL.
 */
export function resolveInsidePackage(base: string, rel: string): string {
  if (!isSafePackagePath(rel)) throw new Error(`unsafe package path '${String(rel)}': must be relative and stay inside the package`);
  const dir = base.endsWith("/") ? new URL(base, typeof document !== "undefined" ? document.baseURI : undefined).href : packageBaseUrl(base);
  const href = new URL(rel, dir).href;
  if (!href.startsWith(dir)) throw new Error(`unsafe package path '${rel}': resolves outside the package directory`);
  return href;
}

export async function loadPackage(h: DuckDbHandle, manifestUrl: string, opts: LoadPackageOptions = {}): Promise<LoadedPackage> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(manifestUrl, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch manifest ${manifestUrl}: HTTP ${res.status}`);
  const manifest = validateManifest(await res.json());
  const tables: LoadedTable[] = [];
  for (const entry of manifest.files) {
    const url = resolveInsidePackage(manifestUrl, entry.path);
    const r = await f(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Could not fetch ${entry.path} (table ${entry.table}): HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (entry.sha256 && opts.verifyHash !== false) {
      const got = await sha256Hex(bytes);
      if (got !== entry.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${got}`);
    }
    const fmt = formatOf(entry);
    const rows = await registerTable(h, entry.table, entry.path, bytes, fmt);
    if (entry.rows !== undefined && entry.rows !== rows) {
      throw new Error(`row count mismatch for table ${entry.table}: manifest ${entry.rows}, loaded ${rows}`);
    }
    tables.push({ table: entry.table, rows, format: fmt, bytes: bytes.byteLength });
  }
  const missing = (opts.requiredTables ?? []).filter((t) => !tables.some((x) => x.table === t));
  if (missing.length) throw new Error(`Package is missing required tables: ${missing.join(", ")}`);
  return { manifest, baseUrl: packageBaseUrl(manifestUrl), tables };
}

/** Register `bytes` and materialise it as TABLE `table`. Returns the row count. */
export async function registerTable(
  h: DuckDbHandle,
  table: string,
  fileName: string,
  bytes: Uint8Array,
  format: "parquet" | "geojson",
): Promise<number> {
  if (!IDENT.test(table)) throw new Error(`invalid table name '${table}'`);
  // DuckDB file names are global to the shared instance: a per-call unique name (never a canonical
  // `pkg_<table>.parquet`) so concurrent loads in different plugins cannot read each other's bytes.
  const vname = `pkg_${table}_${uniqueSuffix()}${format === "parquet" ? ".parquet" : ".json"}`;
  void fileName;
  await h.registerBuffer(vname, bytes);
  try {
    const q = vname.replace(/'/g, "''");
    const src =
      format === "parquet"
        ? `SELECT * FROM read_parquet('${q}')`
        : `SELECT f.properties.*, to_json(f.geometry) AS geometry FROM (SELECT unnest(features) AS f FROM read_json_auto('${q}'))`;
    await h.exec(`CREATE OR REPLACE TABLE ${table} AS ${src}`);
  } finally {
    await h.dropFile(vname).catch(() => {});
  }
  const r = await h.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(r[0].n);
}

let uidCounter = 0;
/** Process-unique, filename-safe suffix (counter + random) for names registered with the shared DuckDB. */
export function uniqueSuffix(): string {
  uidCounter = (uidCounter + 1) % 0x7fffffff;
  return `${uidCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
