/**
 * v_sp_obs: observed subpath / route journey time.
 *
 * Input table (workstream A: subpath_obs_jt.parquet):
 *   subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR)
 * source = 'monthly_15min' (3 Feb - 30 Apr 2025, 15 route/dir pairs, 15-min grid) or
 *          'subnetwork_may2025' (5 - 9 May 2025, 25 route/dir pairs).
 * UNIT WARNING: for 'monthly_15min' the `seconds` column is the raw Avg_traveltime whose unit is
 * NOT verified in the source file. Magnitudes are consistent with seconds (see README), but
 * treat it as unverified until confirmed with the data owner.
 *
 * Views:
 *   v_sp_obs_day(route, direction_norm, source, day, bucket_start_min, jt_s, n_obs)
 *       one value per route/dir/source/day/bucket (mean of the raw rows in the bucket)
 *   v_sp_obs(route, direction_norm, source, bucket_start_min, n_days, mean_s, median_s, min_s, max_s)
 *       aggregated across days (typical profile). Sources are never mixed.
 * Options: bucket (15 default, 60 for hourly), source filter.
 */
import { ident } from "./views.sql.ts";

export interface SubpathOptions {
  /** Time-of-day bucket in minutes, divisor of 1440. Default 15. */
  bucketMinutes?: number;
  /** Restrict to one source, e.g. 'monthly_15min'. Default: all (kept separate in the output). */
  source?: string;
  /** Input table name. Default subpath_obs_jt. */
  table?: string;
}

export function buildSubpathSql(o: SubpathOptions = {}): string {
  const b = o.bucketMinutes ?? 15;
  if (!Number.isInteger(b) || b <= 0 || 1440 % b !== 0) throw new Error("bucketMinutes must be a positive divisor of 1440");
  const table = ident(o.table ?? "subpath_obs_jt", "table");
  const src = o.source === undefined ? "" : `AND source = '${o.source.replace(/'/g, "''")}'`;
  return `
-- ===== Observed journey time per route/dir/source/day/bucket =============
CREATE OR REPLACE VIEW v_sp_obs_day AS
SELECT route, direction_norm, source,
       CAST(ts AS DATE) AS day,
       CAST(floor((hour(ts) * 60 + minute(ts)) / ${b}) AS INTEGER) * ${b} AS bucket_start_min,
       AVG(seconds) AS jt_s,
       COUNT(*) AS n_obs
FROM ${table}
WHERE seconds IS NOT NULL AND seconds > 0 ${src}
GROUP BY 1, 2, 3, 4, 5;

-- ===== Typical profile across days (mean and median) ====================
CREATE OR REPLACE VIEW v_sp_obs AS
SELECT route, direction_norm, source, bucket_start_min,
       COUNT(*) AS n_days,
       AVG(jt_s) AS mean_s,
       MEDIAN(jt_s) AS median_s,
       MIN(jt_s) AS min_s,
       MAX(jt_s) AS max_s
FROM v_sp_obs_day
GROUP BY 1, 2, 3, 4;
`;
}
