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

export interface DetViewConfig {
  /** Prefix of this plugin's private raw tables (two plugins share one DuckDB instance). */
  prefix: string;
  obsSource: ObsSource;
  bucketMinutes: number;
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
  return (
    buildAdapterSql({ rawSimTable: t.sim, rawObsTable: t.obs, obsSource: cfg.obsSource }) +
    "\n" +
    buildViewsSql({ only: ["det"], bucketMinutes: bucket, ...ADAPTED_RELATIONS })
  );
}

/** Rows of v_det_validation whose bucket starts in [fromMin, toMin). */
export function windowQuery(fromMin: number, toMin: number): string {
  const a = intArg(fromMin, "fromMin");
  const b = intArg(toMin, "toMin");
  return (
    "SELECT detector_id, oid, bucket_start_min, sim_flow_h, obs_flow_h, geh, status FROM v_det_validation " +
    `WHERE bucket_start_min >= ${a} AND bucket_start_min < ${b} ORDER BY detector_id, bucket_start_min`
  );
}

export const PROBE_SIM_SQL =
  "SELECT min(t_start_min) AS start_min, max(t_start_min + dur_min) AS end_min, max(dur_min) AS dur_min, " +
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

/**
 * Buckets that compare like with like. Simulated MADET intervals are `simDur` long (60 in the
 * delivery), and v_det_validation drops buckets that are not fully covered, so a bucket must be
 * a multiple of simDur, fit in the simulated span, and start on the simulated grid.
 */
export function bucketOptions(simDurMin: number, simStartMin: number, simEndMin: number): number[] {
  if (!(simDurMin > 0)) return [60];
  const span = simEndMin - simStartMin;
  const out: number[] = [];
  for (let b = simDurMin; b <= Math.max(span, simDurMin); b += simDurMin) {
    if (b === simDurMin || simStartMin % b === 0) out.push(b);
  }
  return out;
}
