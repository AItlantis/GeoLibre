/**
 * Entry for plugin bundles. Import from here (not from ./duckdb directly) so the DuckDB worker
 * source is inlined by the build (scripts/build-lib.mjs resolves "virtual:duckdb-eh-worker-text").
 */
import workerSource from "virtual:duckdb-eh-worker-text";
import { getDuckDb as getDuckDbBase, type DuckDbHandle, type DuckDbInitOptions } from "./duckdb";

export * from "./duckdb";
export * from "./package";
export * from "./metrics";
export * from "./charts";
export * from "./lock";
export * from "./sha256";
export { VIEWS_SQL, VIEW_NAMES, buildViewsSql, type ViewOptions } from "./sql/views.sql";

/** Shared DuckDB instance with the inlined worker pre-wired. */
export function getDuckDbInline(opts: DuckDbInitOptions = {}): Promise<DuckDbHandle> {
  return getDuckDbBase({ workerSource, ...opts });
}

/** Create the analysis views (re-callable with new options). */
export async function installViews(h: DuckDbHandle, opts?: import("./sql/views.sql").ViewOptions): Promise<void> {
  const { buildViewsSql } = await import("./sql/views.sql");
  await h.exec(buildViewsSql(opts));
}
