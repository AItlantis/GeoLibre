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
 * Outputs:
 *   v_sim_norm(oid, eid, t_start_min, dur_min, flow)
 *   v_obs_norm(detector_id, t_start_min, dur_min, flow)
 * t_start_min = minutes since midnight of the reference day. Simulated rows are
 * interval_start_s / 60. Observed rows are placed relative to `obsRefDay` (default
 * 2025-01-01, the yearly reference pattern); rows outside that day are dropped.
 */
import { ident } from "./views.sql.ts";

export interface AdapterOptions {
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
WHERE duration_s > 0 ${cls === null ? "" : `AND sid = ${cls}`};

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
