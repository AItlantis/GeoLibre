/**
 * Pure helpers for reading a Testudo Parquet results `catalog.json`, kept
 * free of any DuckDB-WASM import so they can be unit-tested under plain
 * Node without pulling in browser-only `?url` worker/wasm assets.
 */

export type CatalogEntry = { table?: string; partition?: string; path?: string; did?: number; row_count?: number };

export function catalogDid(e: CatalogEntry): number {
  return Number(e.did ?? String(e.partition ?? "").match(/did=([^/]+)/)?.[1]);
}

/**
 * Choose which replication (`did`) a package opens on when the caller
 * doesn't ask for one explicitly.
 *
 * A replication whose MISECT partition has zero rows is a real, observed
 * case (the exporter still writes an empty file for a replication that
 * never produced section results), and would otherwise become the silent
 * default whenever it happens to sort first numerically — rendering the
 * network geometry with no KPI data and no error. Prefer the first
 * replication actually known to carry rows; fall back to the naive first
 * `did` only when the catalog gives no row-count signal at all (older
 * exports without `row_count`).
 */
export function pickDefaultDid(catalog: CatalogEntry[]): number | null {
  const dids = [...new Set(catalog.map(catalogDid).filter(Number.isFinite))].sort((a, b) => a - b);
  const rowCountByDid = new Map<number, number>();
  for (const e of catalog) {
    if (e.table !== "MISECT" || typeof e.row_count !== "number") continue;
    const d = catalogDid(e);
    if (Number.isFinite(d)) rowCountByDid.set(d, (rowCountByDid.get(d) ?? 0) + e.row_count);
  }
  if (!rowCountByDid.size) return dids[0] ?? null;
  return dids.find((d) => (rowCountByDid.get(d) ?? 0) > 0) ?? dids[0] ?? null;
}
