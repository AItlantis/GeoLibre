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
 *
 * Extended observed contract (C9, all nullable, old rows valid): subpath_oid, match_method, seconds_min,
 * seconds_max (SUPPLIED bounds), window_start_s, window_end_s, dateKind ('actual'|'typical'), source_id.
 * Pass `columns` (e.g. from DESCRIBE) to use them; without it the legacy views are produced unchanged.
 * Extended views also add t_s (v_sp_obs; obs_t_s in v_sp_obs_day): mean clock time of the rows in the bucket in
 * seconds since midnight, so a time-only observation keeps its exact time (C11 period matching).
 * Extended views add: subpath_oid, match_method, source_id, date_kind (identity, part of the grouping) and
 *   sup_min_s / sup_max_s = SUPPLIED bounds (min of seconds_min / max of seconds_max), window_start_s / window_end_s.
 * `min_s` / `max_s` stay the ACROSS-DAY band (min/max of the daily means): a separate statistic from the supplied
 * bounds, which are never recomputed from or collapsed into it.
 */
import { ident } from "./views.sql.ts";

export interface SubpathOptions {
  /** Time-of-day bucket in minutes, divisor of 1440. Default 15. */
  bucketMinutes?: number;
  /** Restrict to one source, e.g. 'monthly_15min'. Default: all (kept separate in the output). */
  source?: string;
  /** Input table name. Default subpath_obs_jt. */
  table?: string;
  /** Columns present in the input table (case-insensitive). Omitted = legacy five columns only. */
  columns?: readonly string[];
}

export function buildSubpathSql(o: SubpathOptions = {}): string {
  const b = o.bucketMinutes ?? 15;
  if (!Number.isInteger(b) || b <= 0 || 1440 % b !== 0) throw new Error("bucketMinutes must be a positive divisor of 1440");
  const table = ident(o.table ?? "subpath_obs_jt", "table");
  const src = o.source === undefined ? "" : `AND source = '${o.source.replace(/'/g, "''")}'`;
  const have = new Set((o.columns ?? []).map((c) => c.toLowerCase()));
  const col = (name: string, cast: string, alias: string): string => (have.has(name.toLowerCase()) ? `CAST(${name} AS ${cast})` : `CAST(NULL AS ${cast})`) + ` AS ${alias}`;
  const ext = have.size > 0;
  // Identity columns (grouping keys) in the extended views.
  const idDay = ext
    ? `,
       ${have.has("subpath_oid") ? "CAST(subpath_oid AS VARCHAR)" : "CAST(NULL AS VARCHAR)"} AS subpath_oid,
       ${col("match_method", "VARCHAR", "match_method")},
       ${col("source_id", "VARCHAR", "source_id")},
       ${col("dateKind", "VARCHAR", "date_kind")}`
    : "";
  const supDay = ext
    ? `,
       ${have.has("seconds_min") ? "MIN(CASE WHEN seconds_min > 0 THEN seconds_min END)" : "CAST(NULL AS DOUBLE)"} AS sup_min_s,
       ${have.has("seconds_max") ? "MAX(CASE WHEN seconds_max > 0 THEN seconds_max END)" : "CAST(NULL AS DOUBLE)"} AS sup_max_s,
       ${have.has("window_start_s") ? "MIN(window_start_s)" : "CAST(NULL AS DOUBLE)"} AS window_start_s,
       ${have.has("window_end_s") ? "MAX(window_end_s)" : "CAST(NULL AS DOUBLE)"} AS window_end_s,
       AVG(hour(ts) * 3600 + minute(ts) * 60 + second(ts)) AS obs_t_s`
    : "";
  const idNames = ext ? ", subpath_oid, match_method, source_id, date_kind" : "";
  const dayGroup = ext ? "GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9" : "GROUP BY 1, 2, 3, 4, 5";
  // Column positions: route, direction_norm, source, [oid, mm, sid, dk], day, bucket
  const dayCols = ext
    ? `SELECT route, direction_norm, source${idDay},
       CAST(ts AS DATE) AS day,
       CAST(floor((hour(ts) * 60 + minute(ts)) / ${b}) AS INTEGER) * ${b} AS bucket_start_min,
       AVG(seconds) AS jt_s,
       COUNT(*) AS n_obs${supDay}`
    : `SELECT route, direction_norm, source,
       CAST(ts AS DATE) AS day,
       CAST(floor((hour(ts) * 60 + minute(ts)) / ${b}) AS INTEGER) * ${b} AS bucket_start_min,
       AVG(seconds) AS jt_s,
       COUNT(*) AS n_obs`;
  const supAgg = ext
    ? `,
       MIN(sup_min_s) AS sup_min_s,
       MAX(sup_max_s) AS sup_max_s,
       MIN(window_start_s) AS window_start_s,
       MAX(window_end_s) AS window_end_s,
       AVG(obs_t_s) AS t_s`
    : "";
  const aggGroup = ext ? "GROUP BY 1, 2, 3, 4, 5, 6, 7, 8" : "GROUP BY 1, 2, 3, 4";
  return `
-- ===== Observed journey time per route/dir/source/day/bucket =============
CREATE OR REPLACE VIEW v_sp_obs_day AS
${dayCols}
FROM ${table}
WHERE seconds IS NOT NULL AND seconds > 0 ${src}
${dayGroup};

-- ===== Typical profile across days (mean and median) ====================
-- min_s / max_s = ACROSS-DAY band; sup_min_s / sup_max_s (extended) = bounds SUPPLIED by the source.
CREATE OR REPLACE VIEW v_sp_obs AS
SELECT route, direction_norm, source${idNames}, bucket_start_min,
       COUNT(*) AS n_days,
       AVG(jt_s) AS mean_s,
       MEDIAN(jt_s) AS median_s,
       MIN(jt_s) AS min_s,
       MAX(jt_s) AS max_s${supAgg}
FROM v_sp_obs_day
${aggGroup};
`;
}
