/**
 * DuckDB SQL views for the Aimsun validation plugins.
 *
 * Input TABLE CONTRACT (what package.ts registers; workstream A must emit it):
 *
 *   od_before(origin, destination, trips DOUBLE)        -- matrix before adjustment
 *   od_after (origin, destination, trips DOUBLE)        -- matrix after adjustment
 *   centroids(id, name, grp, lon DOUBLE, lat DOUBLE)    -- EPSG:4326; grp = OD group label
 *   detectors_sim(oid, eid, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE)
 *   detectors_obs(detector_id, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE)
 *
 *   `flow` is by default an HOURLY RATE (veh/h) valid over [t_start_min, t_start_min + dur_min)
 *   (`flowKind: 'rate'`, the real Aimsun MADET + observed pattern data). With `flowKind:
 *   'count'` it is a vehicle count over that interval instead. Set per side with
 *   simFlowKind / obsFlowKind. Hourly flow of a bucket is the duration-weighted mean of the
 *   rates, SUM(flow*dur)/SUM(dur), or for counts SUM(flow)*60/SUM(dur).
 *   Real extractor tables are mapped onto this contract by the adapter views, see adapter.sql.ts.
 *   Join key: detectors_sim.eid = detectors_obs.detector_id (compared as VARCHAR; the
 *   simulated oid is carried through for map joins). Simulated rows whose eid is NULL / empty
 *   cannot be matched to an observed detector: they are EXCLUDED from v_det_validation and listed
 *   in v_det_unmatched_sim (oid, flow) / v_det_unmatched_sim_summary so panels can warn.
 *   C8: several oids may share one eid (Jumeira: 292 oids, 255 eids). They are pooled per (eid,
 *   interval) with the MEAN of their flow rates and the coverage is the UNION of covered intervals;
 *   v_det_validation.n_sim_oids says how many oids were pooled (MIN(oid) is the render id).
 *
 * The SQL is plain DuckDB (no spatial extension). Views cannot take parameters, so the
 * aggregation parameters are baked in by {@link buildViewsSql}; call it again with new
 * options to re-create the views.
 */

export interface ViewOptions {
  /** Bucket the detector intervals are aggregated to, in minutes. Default 60. */
  bucketMinutes?: number;
  /** Minute-of-day the bucket grid starts at (default 0 = midnight). A whole-period bucket starts at the window start. */
  bucketOriginMin?: number;
  /**
   * Keep only buckets whose simulated AND observed coverage (sum of dur_min) reaches the
   * bucket length. Default true: a partial bucket would understate the hourly flow.
   */
  requireFullBuckets?: boolean;
  /** GEH < gehPass => "pass". Default 5. */
  gehPass?: number;
  /** GEH <= gehWarn => "warn", above => "fail". Default 10. */
  gehWarn?: number;
  /** Trip-length histogram bin width in km. Default 1. */
  binKm?: number;
  /** Drop origin = destination pairs from the trip-length views. Default true. */
  excludeIntrazonal?: boolean;
  /** Mean earth radius in km (haversine). Default 6371.0088. */
  earthRadiusKm?: number;
  /**
   * Which view groups to create. Views bind their tables at creation, so a plugin that only
   * has detector tables must pass ["det"]. od = v_od_diff/v_od_group_agg (od_before, od_after,
   * centroids); trip = v_trip_length* (same tables); det = v_det_* (detectors_sim/obs).
   * Default: all.
   */
  only?: Array<"od" | "trip" | "det">;
  /** Meaning of detectors_sim.flow: 'rate' (veh/h, default) or 'count' (vehicles per interval). */
  simFlowKind?: FlowKind;
  /** Meaning of detectors_obs.flow: 'rate' (veh/h, default) or 'count'. */
  obsFlowKind?: FlowKind;
  /** Relation the det views read simulated rows from. Default "detectors_sim". */
  simRelation?: string;
  /** Relation the det views read observed rows from. Default "detectors_obs". */
  obsRelation?: string;
}

export type FlowKind = "rate" | "count";

export const ident = (v: string, name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`${name} must be a plain SQL identifier`);
  return v;
};

/** SQL expression for the bucket hourly flow (veh/h) of a group of intervals. */
export function hourlyExpr(kind: FlowKind): string {
  if (kind === "rate") return "SUM(flow * dur_min) / SUM(dur_min)";
  if (kind === "count") return "SUM(flow) * 60.0 / SUM(dur_min)";
  throw new Error(`flowKind must be 'rate' or 'count', got ${String(kind)}`);
}

const num = (v: number, name: string): number => {
  if (!Number.isFinite(v)) throw new Error(`views option ${name} must be a finite number`);
  return v;
};

export function buildViewsSql(options: ViewOptions = {}): string {
  const sections = buildAllSql(options);
  const only = options.only ?? ["od", "trip", "det"];
  return sections.filter((x) => only.includes(x.group)).map((x) => x.sql).join("\n");
}

function buildAllSql(options: ViewOptions): Array<{ group: "od" | "trip" | "det"; sql: string }> {
  const bucket = num(options.bucketMinutes ?? 60, "bucketMinutes");
  if (!Number.isInteger(bucket) || bucket <= 0) throw new Error("bucketMinutes must be a positive integer");
  const origin = num(options.bucketOriginMin ?? 0, "bucketOriginMin");
  if (!Number.isInteger(origin) || origin < 0) throw new Error("bucketOriginMin must be a non-negative integer");
  const bstart = origin === 0 ? `CAST(floor(t_start_min / ${bucket}) AS INTEGER) * ${bucket}` : `CAST(floor((t_start_min - ${origin}) / ${bucket}) AS INTEGER) * ${bucket} + ${origin}`;
  const full = options.requireFullBuckets ?? true;
  const gehPass = num(options.gehPass ?? 5, "gehPass");
  const gehWarn = num(options.gehWarn ?? 10, "gehWarn");
  const binKm = num(options.binKm ?? 1, "binKm");
  if (binKm <= 0) throw new Error("binKm must be > 0");
  const intra = options.excludeIntrazonal ?? true;
  const R = num(options.earthRadiusKm ?? 6371.0088, "earthRadiusKm");
  const simH = hourlyExpr(options.simFlowKind ?? "rate");
  const obsH = hourlyExpr(options.obsFlowKind ?? "rate");
  const simRel = ident(options.simRelation ?? "detectors_sim", "simRelation");
  const obsRel = ident(options.obsRelation ?? "detectors_obs", "obsRelation");

  const all = `
-- ===== OD difference =====================================================
-- before/after over the union of OD pairs; a pair missing on one side counts as 0 trips.
-- deviation_ratio = delta / before. Zero denominator: NULL (undefined) when after > 0,
-- 0 when both are 0. is_new_flow flags before = 0 AND after > 0.
CREATE OR REPLACE VIEW v_od_diff AS
SELECT
  COALESCE(b.origin, a.origin)           AS origin,
  COALESCE(b.destination, a.destination) AS destination,
  COALESCE(b.trips, 0.0)                 AS before,
  COALESCE(a.trips, 0.0)                 AS after,
  COALESCE(a.trips, 0.0) - COALESCE(b.trips, 0.0) AS delta,
  CASE
    WHEN COALESCE(b.trips, 0.0) <> 0 THEN (COALESCE(a.trips, 0.0) - b.trips) / b.trips
    WHEN COALESCE(a.trips, 0.0) = 0 THEN 0.0
    ELSE NULL
  END AS deviation_ratio,
  (COALESCE(b.trips, 0.0) = 0 AND COALESCE(a.trips, 0.0) <> 0) AS is_new_flow
FROM od_before b
FULL OUTER JOIN od_after a
  ON CAST(b.origin AS VARCHAR) = CAST(a.origin AS VARCHAR)
 AND CAST(b.destination AS VARCHAR) = CAST(a.destination AS VARCHAR);

-- ===== OD aggregated by origin group x destination group =================
CREATE OR REPLACE VIEW v_od_group_agg AS
SELECT
  COALESCE(co.grp, '(none)') AS origin_group,
  COALESCE(cd.grp, '(none)') AS destination_group,
  SUM(d.before) AS before,
  SUM(d.after)  AS after,
  SUM(d.delta)  AS delta,
  CASE
    WHEN SUM(d.before) <> 0 THEN SUM(d.delta) / SUM(d.before)
    WHEN SUM(d.after) = 0 THEN 0.0
    ELSE NULL
  END AS deviation_ratio,
  COUNT(*) AS n_pairs
FROM v_od_diff d
LEFT JOIN centroids co ON CAST(co.id AS VARCHAR) = CAST(d.origin AS VARCHAR)
LEFT JOIN centroids cd ON CAST(cd.id AS VARCHAR) = CAST(d.destination AS VARCHAR)
GROUP BY 1, 2;

-- ===== Trip length (STRAIGHT-LINE centroid-to-centroid haversine, km) =====
-- Not a network path length. One row per OD pair per scenario.
CREATE OR REPLACE VIEW v_trip_length_od AS
WITH t AS (
  SELECT 'before' AS scenario, origin, destination, trips FROM od_before
  UNION ALL
  SELECT 'after'  AS scenario, origin, destination, trips FROM od_after
)
SELECT
  t.scenario, t.origin, t.destination, t.trips,
  2 * ${R} * asin(sqrt(least(1.0,
        pow(sin(radians(cd.lat - co.lat) / 2), 2)
      + cos(radians(co.lat)) * cos(radians(cd.lat)) * pow(sin(radians(cd.lon - co.lon) / 2), 2)
  ))) AS dist_km
FROM t
JOIN centroids co ON CAST(co.id AS VARCHAR) = CAST(t.origin AS VARCHAR)
JOIN centroids cd ON CAST(cd.id AS VARCHAR) = CAST(t.destination AS VARCHAR)
WHERE co.lon IS NOT NULL AND co.lat IS NOT NULL AND cd.lon IS NOT NULL AND cd.lat IS NOT NULL
  AND t.trips IS NOT NULL AND t.trips > 0
  ${intra ? "AND CAST(t.origin AS VARCHAR) <> CAST(t.destination AS VARCHAR)" : ""};

-- Trip-weighted histogram, bin width ${binKm} km. bin_idx = floor(dist / width).
CREATE OR REPLACE VIEW v_trip_length AS
SELECT
  scenario,
  CAST(floor(dist_km / ${binKm}) AS INTEGER) AS bin_idx,
  CAST(floor(dist_km / ${binKm}) AS INTEGER) * ${binKm}::DOUBLE       AS bin_start_km,
  (CAST(floor(dist_km / ${binKm}) AS INTEGER) + 1) * ${binKm}::DOUBLE AS bin_end_km,
  SUM(trips) AS trips,
  SUM(trips) / SUM(SUM(trips)) OVER (PARTITION BY scenario) AS share
FROM v_trip_length_od
GROUP BY scenario, bin_idx;

CREATE OR REPLACE VIEW v_trip_length_stats AS
SELECT scenario,
       SUM(trips * dist_km) / SUM(trips) AS mean_km,
       SUM(trips) AS trips,
       MAX(dist_km) AS max_km
FROM v_trip_length_od
GROUP BY scenario;

-- ===== Detector validation: per detector x ${bucket}-minute bucket ========
-- Hourly flow (veh/h): rate -> SUM(flow*dur)/SUM(dur) (duration-weighted mean); count ->
-- SUM(flow)*60/SUM(dur). m = simulated, c = observed. Rows are per eid (one detector); sim rows
-- with NULL/empty eid are excluded here (see v_det_unmatched_sim), never pooled into one row.
-- Oids sharing an eid are pooled per interval by the MEAN of their flows first (see simp), so each
-- eid counts once in every statistic and its coverage is the union of the covered intervals.
-- GEH = sqrt(2 (m-c)^2 / (m+c)); m = c = 0 => GEH 0 (perfect agreement; the Python
-- reference returns None there). rel_error = (m-c)/c, NULL when c = 0.
CREATE OR REPLACE VIEW v_det_validation AS
WITH simp AS (
  -- C8 pooling: several simulated oids can share one eid (they observe the same physical detector).
  -- Pool them per (eid, interval) with the documented rule MEAN of the oids' flows; each interval is
  -- then counted ONCE, so temporal coverage is the UNION of the covered intervals (never summed
  -- across oids). oid = MIN(oid) is the representative render id; n_sim_oids (CTE shared) = oids that share the eid.
  SELECT CAST(eid AS VARCHAR) AS eid, MIN(oid) AS oid, t_start_min, dur_min,
         AVG(flow) AS flow
  FROM ${simRel}
  WHERE flow IS NOT NULL AND dur_min > 0 AND eid IS NOT NULL AND TRIM(CAST(eid AS VARCHAR)) <> ''
  GROUP BY 1, 3, 4
), sim AS (
  SELECT eid, MIN(oid) AS oid,
         ${bstart} AS bucket_start_min,
         ${simH} AS m, SUM(dur_min) AS cover_min
  FROM simp
  GROUP BY 1, 3
), shared AS (
  SELECT CAST(eid AS VARCHAR) AS eid, COUNT(DISTINCT oid) AS n_sim_oids
  FROM ${simRel}
  WHERE eid IS NOT NULL AND TRIM(CAST(eid AS VARCHAR)) <> ''
  GROUP BY 1
), obs AS (
  SELECT CAST(detector_id AS VARCHAR) AS eid,
         ${bstart} AS bucket_start_min,
         ${obsH} AS c, SUM(dur_min) AS cover_min
  FROM ${obsRel}
  WHERE flow IS NOT NULL AND dur_min > 0 AND detector_id IS NOT NULL AND TRIM(CAST(detector_id AS VARCHAR)) <> ''
  GROUP BY 1, 2
), j AS (
  SELECT s.eid AS detector_id, s.oid, s.bucket_start_min,
         s.m AS sim_flow_h, o.c AS obs_flow_h, h.n_sim_oids
  FROM sim s JOIN obs o ON o.eid = s.eid AND o.bucket_start_min = s.bucket_start_min
  JOIN shared h ON h.eid = s.eid
  ${full ? `WHERE s.cover_min >= ${bucket} AND o.cover_min >= ${bucket}` : ""}
)
SELECT detector_id, oid, bucket_start_min, sim_flow_h, obs_flow_h, n_sim_oids,
       sim_flow_h - obs_flow_h AS diff,
       CASE WHEN obs_flow_h <> 0 THEN (sim_flow_h - obs_flow_h) / obs_flow_h ELSE NULL END AS rel_error,
       geh,
       CASE WHEN geh < ${gehPass} THEN 'pass' WHEN geh <= ${gehWarn} THEN 'warn' ELSE 'fail' END AS status
FROM (
  SELECT *, CASE WHEN sim_flow_h + obs_flow_h <= 0 THEN 0.0
                 ELSE sqrt(2.0 * pow(sim_flow_h - obs_flow_h, 2) / (sim_flow_h + obs_flow_h)) END AS geh
  FROM j
);

-- ===== Simulated detectors that cannot be validated (NULL / empty eid) ====
-- One row per oid: flow = pooled hourly flow (veh/h, same flowKind rule as above) over its
-- intervals with a flow value, NULL when it has none; n_intervals = those intervals.
CREATE OR REPLACE VIEW v_det_unmatched_sim AS
WITH u AS (
  SELECT oid, flow, dur_min FROM ${simRel}
  WHERE eid IS NULL OR TRIM(CAST(eid AS VARCHAR)) = ''
), f AS (
  SELECT oid, ${simH} AS flow, COUNT(*) AS n_intervals
  FROM u WHERE flow IS NOT NULL AND dur_min > 0
  GROUP BY oid
)
SELECT o.oid, f.flow, COALESCE(f.n_intervals, 0) AS n_intervals
FROM (SELECT DISTINCT oid FROM u) o LEFT JOIN f ON f.oid = o.oid;

-- n_oids = simulated detectors without eid, n_with_flow = those that carry a positive flow.
CREATE OR REPLACE VIEW v_det_unmatched_sim_summary AS
SELECT COUNT(*) AS n_oids, COALESCE(SUM(CASE WHEN flow > 0 THEN 1 ELSE 0 END), 0) AS n_with_flow
FROM v_det_unmatched_sim;

-- ===== Detector summary, pooled over all detector x bucket rows ===========
-- r2/slope/intercept: OLS of sim (y) on obs (x), as linear_regression_stats in
-- validation_analytics.py. r2_identity = 1 - SSres/SStot about the y = x line, with SStot
-- taken around the observed mean. pct_geh_lt5 uses the fixed GEH < 5 threshold.
CREATE OR REPLACE VIEW v_det_summary AS
SELECT
  COUNT(*)                                   AS n,
  sqrt(AVG(pow(sim_flow_h - obs_flow_h, 2))) AS rmse,
  AVG(abs(sim_flow_h - obs_flow_h))          AS mae,
  AVG(sim_flow_h - obs_flow_h)               AS bias,
  regr_r2(sim_flow_h, obs_flow_h)            AS r2,
  regr_slope(sim_flow_h, obs_flow_h)         AS slope,
  regr_intercept(sim_flow_h, obs_flow_h)     AS intercept,
  CASE WHEN var_pop(obs_flow_h) > 0
       THEN 1.0 - SUM(pow(sim_flow_h - obs_flow_h, 2)) / (var_pop(obs_flow_h) * COUNT(*))
       ELSE NULL END                         AS r2_identity,
  100.0 * AVG(CASE WHEN geh < 5 THEN 1.0 ELSE 0.0 END) AS pct_geh_lt5,
  SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS n_pass,
  SUM(CASE WHEN status = 'warn' THEN 1 ELSE 0 END) AS n_warn,
  SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS n_fail
FROM v_det_validation;
`;
  return all
    .split(/(?=^-- ===== )/m)
    .filter((x) => x.trim())
    .map((sql) => ({
      group: /^-- ===== (OD)/.test(sql) ? ("od" as const) : /^-- ===== Trip/.test(sql) ? ("trip" as const) : ("det" as const),
      sql,
    }));
}

/** Default-parameter script (1 h buckets, GEH 5/10, 1 km bins). */
export const VIEWS_SQL = buildViewsSql();

/** Names of the views the script defines, in dependency order. */
export const VIEW_NAMES = [
  "v_od_diff",
  "v_od_group_agg",
  "v_trip_length_od",
  "v_trip_length",
  "v_trip_length_stats",
  "v_det_validation",
  "v_det_unmatched_sim",
  "v_det_unmatched_sim_summary",
  "v_det_summary",
] as const;
