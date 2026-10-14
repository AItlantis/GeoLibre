/**
 * SQL parameter building for the detector plugins. All dynamic values are validated here
 * (integers / known identifiers); nothing user-typed is ever interpolated as text.
 */
import { buildAdapterSql, ADAPTED_RELATIONS } from "../../../_shared/src/sql/adapter.sql.ts";
import { buildViewsSql } from "../../../_shared/src/sql/views.sql.ts";

export type ObsSource = "validation" | "calibration" | "both";
export const OBS_SOURCES: readonly ObsSource[] = ["validation", "calibration", "both"];

export function isObsSource(v: unknown): v is ObsSource {
  return v === "validation" || v === "calibration" || v === "both";
}

/** Throws unless v is a finite integer. */
export function intArg(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`${name} must be an integer`);
  return v;
}

const PREFIX = /^[a-z][a-z0-9_]*$/;

/** Observation metadata from the run/analysis manifest (contract C3). */
export interface ObservedMeta {
  referenceDay: string;
  gridSeconds: number;
  units: "veh/h";
  timestampConvention: "interval-end" | "interval-start";
  source?: string;
}

export interface DetViewConfig {
  /** Prefix of this plugin's private raw tables (two plugins share one DuckDB instance). */
  prefix: string;
  obsSource: ObsSource;
  bucketMinutes: number;
  /** Minute-of-day the bucket grid starts at (whole-period buckets start at the window start). Default 0. */
  bucketOriginMin?: number;
  /** From the manifest; absent = 2025-01-01, 5-minute grid, interval-end (the legacy assumption). */
  observed?: ObservedMeta;
  /** Keep only simulated rows of this length (seconds) when the table mixes micro and macro rows. */
  simDurationSeconds?: number | null;
}

export function rawTableNames(prefix: string): { sim: string; obs: string } {
  if (!PREFIX.test(prefix)) throw new Error(`invalid table prefix '${prefix}'`);
  return { sim: `${prefix}sim_raw`, obs: `${prefix}obs_raw` };
}

/** Adapter + det views for the given config (re-created before every query, see det-data.ts). */
export function detViewScript(cfg: DetViewConfig): string {
  const t = rawTableNames(cfg.prefix);
  if (!isObsSource(cfg.obsSource)) throw new Error("invalid obsSource");
  const bucket = intArg(cfg.bucketMinutes, "bucketMinutes");
  if (bucket <= 0) throw new Error("bucketMinutes must be > 0");
  const adapter: Parameters<typeof buildAdapterSql>[0] = { rawSimTable: t.sim, rawObsTable: t.obs, obsSource: cfg.obsSource };
  if (cfg.observed) {
    adapter.obsRefDay = cfg.observed.referenceDay;
    adapter.obsGridMin = obsGridMinutes(cfg.observed);
    adapter.obsTsLabel = cfg.observed.timestampConvention === "interval-start" ? "start" : "end";
  }
  if (cfg.simDurationSeconds != null) adapter.simDurationSeconds = cfg.simDurationSeconds;
  return (
    buildAdapterSql(adapter) +
    "\n" +
    buildViewsSql({ only: ["det"], bucketMinutes: bucket, ...(cfg.bucketOriginMin ? { bucketOriginMin: intArg(cfg.bucketOriginMin, "bucketOriginMin") } : {}), ...ADAPTED_RELATIONS })
  );
}

/** Rows of v_det_validation whose bucket starts in [fromMin, toMin). */
/** With `bucketMin`, a bucket must also END inside the window (a bucket overrunning To is not a complete bucket of the span). */
export function windowQuery(fromMin: number, toMin: number, bucketMin?: number): string {
  const a = intArg(fromMin, "fromMin");
  const b = intArg(toMin, "toMin");
  return (
    "SELECT detector_id, oid, bucket_start_min, sim_flow_h, obs_flow_h, geh, status FROM v_det_validation " +
    `WHERE bucket_start_min >= ${a} AND bucket_start_min < ${b}${bucketMin === undefined ? "" : ` AND bucket_start_min + ${intArg(bucketMin, "bucketMin")} <= ${b}`} ORDER BY detector_id, bucket_start_min`
  );
}

/** Observed grid in whole minutes (the views work in minutes). */
export function obsGridMinutes(o: Pick<ObservedMeta, "gridSeconds">): number {
  if (!Number.isInteger(o.gridSeconds) || o.gridSeconds <= 0 || o.gridSeconds % 60 !== 0) {
    throw new Error("observed.gridSeconds must be a positive whole number of minutes");
  }
  return o.gridSeconds / 60;
}

export const PROBE_SIM_SQL =
  "SELECT min(t_start_min) AS start_min, max(t_start_min + dur_min) AS end_min, max(dur_min) AS dur_min, " +
  "min(dur_min) AS min_dur_min, count(DISTINCT dur_min) AS n_durations, " +
  "count(DISTINCT eid) AS n_sim FROM v_sim_norm";
export const PROBE_OBS_SQL = "SELECT count(DISTINCT detector_id) AS n_obs FROM v_obs_norm";

/**
 * Simulated detectors that cannot be validated: no external id (eid NULL or empty) but they carry
 * flow. No eid is shared by two oids, so there is nothing to average; these detectors simply have
 * no per-eid observed series to compare with. Computed on the plugin's private raw table so it
 * does not depend on the shared views (sid = 0 is the all-vehicles class, as in the adapter).
 */
export function unmatchedSimSql(prefix: string): string {
  const t = rawTableNames(prefix);
  return (
    `SELECT CAST(oid AS VARCHAR) AS oid, avg(flow) AS flow FROM ${t.sim} ` +
    "WHERE sid = 0 AND duration_s > 0 AND (eid IS NULL OR trim(CAST(eid AS VARCHAR)) = '') " +
    "GROUP BY oid HAVING max(flow) > 0 ORDER BY flow DESC, oid"
  );
}

/** Names of the shared det views, dropped on dispose (every consumer re-creates them per query). */
export const DET_VIEWS = ["v_det_summary", "v_det_validation", "v_obs_norm", "v_sim_norm"] as const;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Buckets that compare like with like. v_det_validation drops buckets that are not fully covered
 * and assigns each interval to the bucket holding its start, so a bucket must be a multiple of the
 * simulated interval AND (when the observed grid is known) of the observed grid, otherwise a coarse
 * observation (15 min) could pass the coverage check of a fine bucket (5 min). It must also fit in
 * the simulated span and start on the grid. Without `obsGridMin` only the simulated interval counts.
 */
export const BUCKET_CHOICES = [5, 10, 15, 20, 30, 60] as const;
/** Bucket value meaning "the whole selected From-To period in one bucket". */
export const WHOLE_PERIOD = 0;

export function bucketOptions(simDurMin: number, simStartMin: number, simEndMin: number, obsGridMin?: number): number[] {
  if (!(simDurMin > 0)) return [60];
  const grid = obsGridMin !== undefined && obsGridMin > 0 ? obsGridMin : simDurMin;
  const step = (simDurMin * grid) / gcd(simDurMin, grid);
  const span = simEndMin - simStartMin;
  // Sub-hourly grid: the conventional 5/10/15/20/30/60-minute buckets (never 45, 105, ...). Hourly or coarser: every aligned multiple.
  const candidates: number[] = [];
  if (step < 60) candidates.push(...BUCKET_CHOICES);
  else for (let b = step; b <= Math.max(span, step); b += step) candidates.push(b);
  const out = candidates.filter((b) => b % step === 0 && b <= Math.max(span, step) && (b === step || simStartMin % b === 0));
  return out.length ? [...out] : [step];
}

/** Smallest bucket (minutes) that is a whole multiple of both the simulated interval and the observed grid. */
export function bucketStep(simDurMin: number, obsGridMin?: number): number {
  if (!(simDurMin > 0)) return 60;
  const grid = obsGridMin !== undefined && obsGridMin > 0 ? obsGridMin : simDurMin;
  return (simDurMin * grid) / gcd(simDurMin, grid);
}

/**
 * The selected window as ONE bucket: starts at the first interval boundary at or after `fromMin`,
 * lasts a whole number of `step` minutes (clamped to complete intervals), null when none fits.
 */
export function wholePeriod(fromMin: number, toMin: number, step: number): { originMin: number; minutes: number } | null {
  if (!(step > 0)) return null;
  const originMin = Math.ceil(fromMin / step) * step;
  const minutes = Math.floor((toMin - originMin) / step) * step;
  return minutes > 0 ? { originMin, minutes } : null;
}

/** "2 h 15 min", "45 min", "3 h". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") || "0 min";
}

export type ProfileScope = "mean" | "sum" | "detector";
/** Bounded full-day observed profile (maximum 1440/grid points; 288 for the legacy 5-minute grid). */
export function dayProfileObsQuery(scope: ProfileScope, detectorId?: string, gridMin = 5): string {
  const grid = intArg(gridMin, "gridMin");
  if (grid <= 0) throw new Error("gridMin must be > 0");
  const id = detectorId === undefined ? "" : detectorId.replace(/'/g, "''");
  const match = scope === "detector" ? `AND CAST(o.detector_id AS VARCHAR) = '${id}'` : "";
  const aggregate = scope === "sum" ? "SUM(o.flow)" : "AVG(o.flow)";
  return `WITH matched AS (SELECT DISTINCT CAST(eid AS VARCHAR) detector_id FROM v_sim_norm WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '')\n` +
    `SELECT CAST(o.t_start_min AS INTEGER) AS profile_minute, ${aggregate} AS profile_value FROM v_obs_norm o JOIN matched m ON m.detector_id = CAST(o.detector_id AS VARCHAR) ` +
    `WHERE o.dur_min = ${grid} ${match} GROUP BY o.t_start_min ORDER BY o.t_start_min LIMIT ${Math.ceil(1440 / grid)}`;
}

/** Simulated profile as one row per (interval start, duration), preserving mixed durations. */
export function dayProfileSimQuery(scope: ProfileScope, detectorId?: string, matchedOnly = false): string {
  const id = detectorId === undefined ? "" : detectorId.replace(/\x27/g, "\x27\x27");
  const filter = scope === "detector" ? "AND CAST(s.eid AS VARCHAR) = \x27" + id + "\x27" : "";
  const aggregate = scope === "sum" ? "SUM(s.flow)" : "AVG(s.flow)";
  const matched = matchedOnly && scope !== "detector" ? "WITH matched AS (SELECT DISTINCT CAST(s.eid AS VARCHAR) detector_id FROM v_sim_norm s JOIN v_obs_norm o ON CAST(o.detector_id AS VARCHAR) = CAST(s.eid AS VARCHAR)) " : "";
  const join = matched ? "JOIN matched m ON m.detector_id = CAST(s.eid AS VARCHAR) " : "";
  return matched + "SELECT CAST(s.t_start_min * 60 AS INTEGER) interval_start_s, CAST(s.dur_min * 60 AS INTEGER) duration_s, " + aggregate + " AS profile_value FROM v_sim_norm s " + join +
    "WHERE s.eid IS NOT NULL AND trim(CAST(s.eid AS VARCHAR)) <> \x27\x27 " + filter + " GROUP BY s.t_start_min, s.dur_min ORDER BY s.t_start_min, s.dur_min";
}
