/**
 * Contract of the OPTIONAL simulated journey-time table `subpath_sim_jt` (workstream A, when the data exists):
 *   route VARCHAR, direction_norm VARCHAR, ts_bucket (TIMESTAMP | TIME | VARCHAR 'HH:MM[:SS]' | numeric minutes since midnight),
 *   seconds DOUBLE   (several rows per bucket, e.g. replications, are averaged).
 * Route/direction vocabulary is normalised exactly like the observed side (case, whitespace, In->IB, Out->OB).
 */
export const SIM_COLUMNS = ["route", "direction_norm", "seconds"] as const;

export type TsKind = "temporal" | "numeric" | "text";

export function classifyTsType(type: string): TsKind | null {
  const t = type.toUpperCase();
  if (/^(TIMESTAMP|TIME|DATETIME)/.test(t)) return "temporal";
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL)/.test(t)) return "numeric";
  if (/^(VARCHAR|STRING|TEXT)/.test(t)) return "text";
  return null;
}

/** Returns the missing required column names (case-insensitive). */
export function missingSimColumns(columns: readonly string[]): string[] {
  const have = new Set(columns.map((c) => c.toLowerCase()));
  const segmented = have.has("interval_start_s") && have.has("duration_s");
  const missing = ["route", "direction_norm", "seconds"].filter((c) => !have.has(c));
  if (!segmented && !have.has("ts_bucket")) missing.push("ts_bucket");
  return missing;
}

function bucketExpr(kind: TsKind, b: number): string {
  const floor = (minutes: string): string => `CAST(floor((${minutes}) / ${b}) AS INTEGER) * ${b}`;
  switch (kind) {
    case "temporal":
      return floor("hour(ts_bucket) * 60 + minute(ts_bucket)");
    case "numeric":
      return floor("ts_bucket");
    case "text":
      return floor(
        "COALESCE(hour(try_cast(ts_bucket AS TIME)) * 60 + minute(try_cast(ts_bucket AS TIME)), hour(try_cast(ts_bucket AS TIMESTAMP)) * 60 + minute(try_cast(ts_bucket AS TIMESTAMP)))",
      );
  }
}

/** `v_sp_sim(route, direction_norm, bucket_start_min, sim_s, n)`; rows with a null/unparsable bucket or seconds <= 0 are dropped. */
export function buildSimSql(bucketMinutes: number, kind: TsKind, columns: readonly string[] = []): string {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0 || 1440 % bucketMinutes !== 0) throw new Error("bucketMinutes must be a positive divisor of 1440");
  const have = new Set(columns.map((c) => c.toLowerCase()));
  if (have.has("interval_start_s") && have.has("duration_s")) return `
CREATE OR REPLACE VIEW v_sp_sim AS
SELECT route, direction_norm,
       CAST(floor(interval_start_s / 60) AS INTEGER) AS bucket_start_min,
       CAST(interval_start_s AS DOUBLE) AS interval_start_s,
       CAST(duration_s AS DOUBLE) AS duration_s,
       AVG(seconds) AS sim_s, COUNT(*) AS n,
       ${have.has("run") ? "CAST(run AS VARCHAR)" : "'default'"} AS run
FROM subpath_sim_jt
WHERE seconds IS NOT NULL AND seconds > 0 AND interval_start_s IS NOT NULL AND duration_s > 0
GROUP BY route, direction_norm, interval_start_s, duration_s${have.has("run") ? ", run" : ""};`;
  if (columns.length && !have.has("ts_bucket")) throw new Error("subpath_sim_jt requires interval_start_s/duration_s or ts_bucket");
  const run = have.has("run") ? "CAST(run AS VARCHAR)" : "'default'";
  return `
CREATE OR REPLACE VIEW v_sp_sim AS
SELECT route, direction_norm, bucket_start_min, bucket_start_min * 60 AS interval_start_s, ${bucketMinutes} * 60 AS duration_s, AVG(seconds) AS sim_s, COUNT(*) AS n, run
FROM (SELECT route, direction_norm, seconds, ${bucketExpr(kind, bucketMinutes)} AS bucket_start_min, ${run} AS run FROM subpath_sim_jt WHERE seconds IS NOT NULL AND seconds > 0)
WHERE bucket_start_min IS NOT NULL
GROUP BY 1, 2, 3, 8;
`;
}
