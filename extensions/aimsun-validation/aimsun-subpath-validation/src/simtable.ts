/**
 * Contract of the OPTIONAL simulated journey-time table `subpath_sim_jt` (workstream A, when the data exists):
 *   route VARCHAR, direction_norm VARCHAR, ts_bucket (TIMESTAMP | TIME | VARCHAR 'HH:MM[:SS]' | numeric minutes since midnight),
 *   seconds DOUBLE   (several rows per bucket, e.g. replications, are averaged).
 * Route/direction vocabulary is normalised exactly like the observed side (case, whitespace, In->IB, Out->OB).
 */
export const SIM_COLUMNS = ["route", "direction_norm", "ts_bucket", "seconds"] as const;

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
  return SIM_COLUMNS.filter((c) => !have.has(c));
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
export function buildSimSql(bucketMinutes: number, kind: TsKind): string {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0 || 1440 % bucketMinutes !== 0) throw new Error("bucketMinutes must be a positive divisor of 1440");
  return `
CREATE OR REPLACE VIEW v_sp_sim AS
SELECT route, direction_norm, bucket_start_min, AVG(seconds) AS sim_s, COUNT(*) AS n
FROM (SELECT route, direction_norm, seconds, ${bucketExpr(kind, bucketMinutes)} AS bucket_start_min FROM subpath_sim_jt WHERE seconds IS NOT NULL AND seconds > 0)
WHERE bucket_start_min IS NOT NULL
GROUP BY 1, 2, 3;
`;
}
