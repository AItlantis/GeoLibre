/**
 * Adapter views: real extractor tables (build_tabular.py) -> the normalised detector contract
 * used by v_det_validation (see views.sql.ts).
 *
 * Raw inputs (registered by the package loader under the names given in AdapterOptions):
 *   detectors_sim_raw(did, run, oid, eid, ent, sid, interval_start_s, duration_s, flow, volume)
 *     flow = hourly RATE (veh/h) over [interval_start_s, +duration_s). sid = vehicle class;
 *     sid = 0 is the all-vehicle aggregate, so the other classes are dropped by default (adding
 *     them would double count).
 *   detectors_obs_raw(detector_id, ts TIMESTAMP, flow, source_file)
 *     flow = hourly RATE (veh/h) on a 5-minute grid. ts labels the END of the interval
 *     (first stamp of a day is 00:05, last is 00:00 of the next day). source_file is
 *     'validation' | 'calibration'; the two files overlap on most detectors (same
 *     detector_id + ts + flow), so rows are de-duplicated by (detector_id, ts).
 *
 * Observation contract v2 (C7, extended mode, enabled by AdapterOptions.obsSources): the raw obs
 * table may also carry duration_s, source_id, units ('veh/h'|'veh'|'unknown'), unit_confidence
 * ('declared'|'inferred'|'unknown'), eligibility ('comparable'|'profile-only'), flow_min, flow_max,
 * oid (every column nullable / optional, see obsColumns). Each row then uses ITS source's interval
 * length (row duration_s, else the source's), units and reference day instead of one global grid;
 * rows are de-duplicated by (detector_id, ts, source_id) and, across several selected sources, by
 * (detector_id, t_start_min) in the source preference order. Units: 'veh' counts are converted to
 * veh/h with the row duration ONLY when unit_confidence is 'declared' or 'inferred'; 'unknown'
 * units (or an unknown duration) make the row profile-only: it is excluded from v_obs_norm
 * (validation / comparison statistics) and kept in v_obs_profile (day profiles only).
 *
 * Outputs:
 *   v_sim_norm(oid, eid, t_start_min, dur_min, flow)
 *   v_obs_norm(detector_id, t_start_min, dur_min, flow)
 *   extended mode only: v_obs_src (selected sources), v_obs_ext (resolved rows),
 *     v_obs_profile(detector_id, t_start_min, dur_min, flow, source_id, comparable)
 * t_start_min = minutes since midnight of the reference day. Simulated rows are
 * interval_start_s / 60. Observed rows are placed relative to `obsRefDay` (default
 * 2025-01-01, the yearly reference pattern); rows outside that day are dropped.
 */
import { ident } from "./views.sql.ts";

/** One observed source as resolved by the consumer (see modelling-count-manager/src/common/sql.ts). */
export interface ObsSourceSpec {
  sourceId: string;
  /** Interval length of the source in seconds; null = unknown (row duration_s may still supply it). */
  durationSeconds: number | null;
  units: "veh/h" | "veh" | "unknown";
  unitConfidence: "declared" | "inferred" | "unknown";
  /** 'profile-only' sources appear in v_obs_profile only. */
  eligibility: "comparable" | "profile-only";
  /** Day the timestamps are placed on (YYYY-MM-DD); null = time of day only (typical day without a declared date). */
  referenceDay: string | null;
  tsLabel: "end" | "start";
}

export interface AdapterOptions {
  /**
   * Extended (C7) mode: the selected sources. Omit for the legacy single-grid behaviour (today's
   * adapter, unchanged). With it, obsSource/obsPreference/obsRefDay/obsGridMin/obsTsLabel are ignored;
   * the array order is the preference order on overlapping rows.
   */
  obsSources?: ObsSourceSpec[];
  /** Columns present in the raw obs table (extended mode); absent columns read as NULL. Default: the legacy four. */
  obsColumns?: readonly string[];
  rawSimTable?: string; // default detectors_sim_raw
  rawObsTable?: string; // default detectors_obs_raw
  /** Vehicle class kept from the simulated table. Default 0 (all vehicles). null keeps every class. */
  simClass?: number | null;
  /** Which observed file: 'validation' | 'calibration' | 'both'. Default 'both' (validation preferred on overlap). */
  obsSource?: "validation" | "calibration" | "both";
  /** Preference order on duplicate (detector_id, ts) rows when obsSource = 'both'. Default validation first. */
  obsPreference?: Array<"validation" | "calibration">;
  /** Observation day used as the reference (YYYY-MM-DD). Default 2025-01-01. */
  obsRefDay?: string;
  /** Observed grid step in minutes. Default 5. */
  obsGridMin?: number;
  /** 'end' (default, the real files) or 'start': what obs `ts` labels. */
  obsTsLabel?: "end" | "start";
  /**
   * Keep only simulated rows of this interval length (seconds). A detectors_sim table may mix micro
   * (e.g. 300 s) and macro (3600 s) rows; summing both into one bucket would double count, so the
   * caller picks the finest. Default: no filter (today's behaviour).
   */
  simDurationSeconds?: number | null;
}

const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;
const numOrNull = (v: number | null, type: string): string => (v === null ? `CAST(NULL AS ${type})` : `CAST(${v} AS ${type})`);

/** Extended-mode observed views (C7). */
function buildExtendedObsSql(rawObs: string, specs: ObsSourceSpec[], columns: readonly string[]): string {
  const has = (c: string): boolean => columns.includes(c);
  const col = (c: string, type: string): string => (has(c) ? c : `CAST(NULL AS ${type})`);
  const meta = specs.length
    ? "VALUES " +
      specs
        .map((s, i) => {
          if (s.referenceDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(s.referenceDay)) throw new Error("obsSources.referenceDay must be YYYY-MM-DD or null");
          if (s.durationSeconds !== null && !(Number.isInteger(s.durationSeconds) && s.durationSeconds > 0)) throw new Error("obsSources.durationSeconds must be a positive integer or null");
          if (!["veh/h", "veh", "unknown"].includes(s.units)) throw new Error("obsSources.units must be veh/h|veh|unknown");
          if (!["declared", "inferred", "unknown"].includes(s.unitConfidence)) throw new Error("obsSources.unitConfidence must be declared|inferred|unknown");
          if (s.eligibility !== "comparable" && s.eligibility !== "profile-only") throw new Error("obsSources.eligibility must be comparable|profile-only");
          if (s.tsLabel !== "end" && s.tsLabel !== "start") throw new Error("obsSources.tsLabel must be end|start");
          return `(CAST(${lit(s.sourceId)} AS VARCHAR), ${numOrNull(s.durationSeconds, "INTEGER")}, ${lit(s.units)}, ${lit(s.unitConfidence)}, ${lit(s.eligibility)}, ${
            s.referenceDay === null ? "CAST(NULL AS VARCHAR)" : lit(s.referenceDay)
          }, ${lit(s.tsLabel)}, ${i})`;
        })
        .join(", ")
    : "SELECT CAST(NULL AS VARCHAR), CAST(NULL AS INTEGER), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS INTEGER) WHERE false";
  const dayMin = `CAST(date_diff('minute', CAST(ref_day AS TIMESTAMP), ts) AS INTEGER)`;
  const tod = `(CAST(date_part('hour', ts) AS INTEGER) * 60 + CAST(date_part('minute', ts) AS INTEGER))`;
  const shift = `(CASE WHEN ts_label = 'end' THEN COALESCE(dur_min, 0) ELSE 0 END)`;
  return `
-- ===== Adapter (C7): selected observed sources =====
CREATE OR REPLACE VIEW v_obs_src AS
SELECT * FROM (${meta}) m(source_id, dur_s, units, unit_conf, elig, ref_day, ts_label, pref);

-- ===== Adapter (C7): observed rows resolved per source (interval, units, day), de-duplicated =====
-- Row duration_s wins over the source's; 'veh' -> veh/h only for declared/inferred units; the
-- timestamp labels the interval END (default) or START per source. Duplicates (detector_id, ts,
-- source_id) collapse to one row; overlapping sources then keep the preferred one per (detector_id, t_start_min).
CREATE OR REPLACE VIEW v_obs_ext AS
WITH j AS (
  SELECT CAST(r.detector_id AS VARCHAR) AS detector_id, r.ts, r.flow, m.source_id,
         COALESCE(r.row_dur_s, m.dur_s) AS dur_s,
         COALESCE(r.row_units, m.units) AS units_eff,
         COALESCE(r.row_conf, m.unit_conf) AS conf_eff,
         (m.elig = 'comparable' AND COALESCE(r.row_elig, 'comparable') <> 'profile-only') AS ok_elig,
         m.ref_day, m.ts_label, m.pref, r.row_dur_s
  FROM (
    SELECT detector_id, ts, flow, COALESCE(${col("source_id", "VARCHAR")}, ${col("source_file", "VARCHAR")}) AS source_id,
           ${col("duration_s", "INTEGER")} AS row_dur_s, ${col("units", "VARCHAR")} AS row_units,
           ${col("unit_confidence", "VARCHAR")} AS row_conf, ${col("eligibility", "VARCHAR")} AS row_elig
    FROM ${rawObs} WHERE flow IS NOT NULL AND ts IS NOT NULL
  ) r JOIN v_obs_src m ON m.source_id = r.source_id
), c AS (
  SELECT *,
         CASE WHEN dur_s > 0 AND dur_s % 60 = 0 THEN CAST(dur_s / 60 AS INTEGER) END AS dur_min,
         CASE WHEN units_eff IS NULL OR units_eff = 'veh/h' THEN flow
              WHEN units_eff = 'veh' AND conf_eff IN ('declared', 'inferred') AND dur_s > 0 THEN flow * 3600.0 / dur_s
              ELSE NULL END AS flow_h
  FROM j
), p AS (
  SELECT *,
         CASE WHEN ref_day IS NULL THEN CAST((${tod} - ${shift} + 1440) % 1440 AS INTEGER)
              ELSE ${dayMin} - ${shift} END AS t_start_min,
         ROW_NUMBER() OVER (PARTITION BY detector_id, ts, source_id ORDER BY row_dur_s NULLS LAST, flow) AS rn1,
         (ok_elig AND dur_min IS NOT NULL AND flow_h IS NOT NULL) AS cmp
  FROM c
), q AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY detector_id, t_start_min, cmp ORDER BY pref, source_id) AS rn2
  FROM p WHERE rn1 = 1 AND t_start_min >= 0 AND t_start_min < 1440
)
SELECT detector_id, t_start_min, dur_min, flow, flow_h, source_id, ok_elig
FROM q WHERE rn2 = 1;

-- Day profiles: every selected source, profile-only ones included (veh/h when the units allow it, else as given).
CREATE OR REPLACE VIEW v_obs_profile AS
SELECT detector_id, t_start_min, COALESCE(dur_min, 0) AS dur_min, COALESCE(flow_h, flow) AS flow, source_id,
       (ok_elig AND dur_min IS NOT NULL AND flow_h IS NOT NULL) AS comparable
FROM v_obs_ext;

-- Validation / comparison: comparable rows only (known interval, known units).
CREATE OR REPLACE VIEW v_obs_norm AS
SELECT detector_id, t_start_min, dur_min, flow_h AS flow
FROM v_obs_ext
WHERE ok_elig AND dur_min IS NOT NULL AND flow_h IS NOT NULL;
`;
}

export function buildAdapterSql(o: AdapterOptions = {}): string {
  const rawSim = ident(o.rawSimTable ?? "detectors_sim_raw", "rawSimTable");
  const rawObs = ident(o.rawObsTable ?? "detectors_obs_raw", "rawObsTable");
  const cls = o.simClass === undefined ? 0 : o.simClass;
  if (cls !== null && !Number.isInteger(cls)) throw new Error("simClass must be an integer or null");
  const src = o.obsSource ?? "both";
  if (!["validation", "calibration", "both"].includes(src)) throw new Error("obsSource must be validation|calibration|both");
  const pref = o.obsPreference ?? ["validation", "calibration"];
  for (const p of pref) if (p !== "validation" && p !== "calibration") throw new Error("obsPreference entries must be validation|calibration");
  const day = o.obsRefDay ?? "2025-01-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("obsRefDay must be YYYY-MM-DD");
  const grid = o.obsGridMin ?? 5;
  if (!Number.isInteger(grid) || grid <= 0) throw new Error("obsGridMin must be a positive integer");
  const simDur = o.simDurationSeconds ?? null;
  if (simDur !== null && (!Number.isInteger(simDur) || simDur <= 0)) throw new Error("simDurationSeconds must be a positive integer or null");
  if (o.obsSources) {
    const simSql = `
-- ===== Adapter: simulated detectors (sid filter, seconds -> minutes) =====
CREATE OR REPLACE VIEW v_sim_norm AS
SELECT oid, eid,
       CAST(interval_start_s / 60 AS INTEGER) AS t_start_min,
       CAST(duration_s / 60 AS INTEGER)       AS dur_min,
       flow
FROM ${rawSim}
WHERE duration_s > 0 ${cls === null ? "" : `AND sid = ${cls}`} ${simDur === null ? "" : `AND duration_s = ${simDur}`};
`;
    return simSql + buildExtendedObsSql(rawObs, o.obsSources, o.obsColumns ?? ["detector_id", "ts", "flow", "source_file"]);
  }
  const label = o.obsTsLabel ?? "end";
  const srcFilter = src === "both" ? "" : `AND source_file = '${src}'`;
  const order = pref.map((p, i) => `WHEN '${p}' THEN ${i}`).join(" ");
  const shift = label === "end" ? grid : 0;
  const minutes = `CAST(date_diff('minute', TIMESTAMP '${day} 00:00:00', ts) AS INTEGER) - ${shift}`;
  return `
-- ===== Adapter: simulated detectors (sid filter, seconds -> minutes) =====
CREATE OR REPLACE VIEW v_sim_norm AS
SELECT oid, eid,
       CAST(interval_start_s / 60 AS INTEGER) AS t_start_min,
       CAST(duration_s / 60 AS INTEGER)       AS dur_min,
       flow
FROM ${rawSim}
WHERE duration_s > 0 ${cls === null ? "" : `AND sid = ${cls}`} ${simDur === null ? "" : `AND duration_s = ${simDur}`};

-- ===== Adapter: observed detectors (dedup validation/calibration, ts -> minute of day) =====
-- Preference on duplicates (detector_id, ts): ${pref.join(" > ")}. Observed ts labels the interval
-- ${label === "end" ? "END, so t_start_min = minutes(ts - ref day) - grid" : "START"}.
CREATE OR REPLACE VIEW v_obs_norm AS
WITH ranked AS (
  SELECT detector_id, ts, flow,
         ROW_NUMBER() OVER (
           PARTITION BY detector_id, ts
           ORDER BY CASE source_file ${order} ELSE 99 END
         ) AS rn
  FROM ${rawObs}
  WHERE flow IS NOT NULL ${srcFilter}
)
SELECT detector_id,
       ${minutes} AS t_start_min,
       ${grid} AS dur_min,
       flow
FROM ranked
WHERE rn = 1
  AND ${minutes} >= 0
  AND ${minutes} < 1440;
`;
}

/** Relations the det views must read when the adapter is used. */
export const ADAPTED_RELATIONS = { simRelation: "v_sim_norm", obsRelation: "v_obs_norm" } as const;
