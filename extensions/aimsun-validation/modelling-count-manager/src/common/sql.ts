/**
 * SQL parameter building for the detector plugins. All dynamic values are validated here
 * (integers / known identifiers); nothing user-typed is ever interpolated as text.
 */
import { buildAdapterSql, ADAPTED_RELATIONS, type ObsSourceSpec } from "../../../_shared/src/sql/adapter.sql.ts";
import { buildViewsSql } from "../../../_shared/src/sql/views.sql.ts";

/**
 * Observed source selection. Legacy packages (no `observed_sources`): 'validation' | 'calibration' | 'both'
 * (the source_file of the 2025 yearly pattern). Observation contract v2 packages: a `source_id` from the
 * manifest's `observed_sources`, or 'both' = every comparable source (offered only when they are homogeneous).
 */
export type ObsSource = string;
export type LegacyObsSource = "validation" | "calibration" | "both";
export const OBS_SOURCES: readonly LegacyObsSource[] = ["validation", "calibration", "both"];

export function isObsSource(v: unknown): v is LegacyObsSource {
  return v === "validation" || v === "calibration" || v === "both";
}

/** One entry of `observed_sources` (contract C7), as parsed from analysis_manifest.json / analysis.json. */
export interface ObservedSource {
  sourceId: string;
  file: string | null;
  adapter: string | null;
  role: "counts" | "journey_time" | "unknown";
  referenceDay: string | null;
  dateKind: "actual" | "typical" | "unknown";
  gridSeconds: number | null;
  durationSeconds: number | null;
  timestampConvention: "interval-end" | "interval-start" | "unknown";
  units: "veh/h" | "veh" | "unknown";
  unitConfidence: "declared" | "inferred" | "unknown";
  /** As declared by the producer ('comparable' | 'profile-only'); null when absent (the consumer rules decide). */
  eligibility: "comparable" | "profile-only" | null;
  rows: number | null;
  detectors: number | null;
}

/** An observed source after the consumer's own eligibility rules (declared eligibility AND known interval/units). */
export interface ResolvedSource extends ObservedSource {
  effective: "comparable" | "profile-only";
  /** Why the source is profile-only (null when comparable). */
  reason: string | null;
  /** Interval length in whole minutes, null when unknown. */
  durationMin: number | null;
  /** Day the timestamps are placed on; null = time of day only. */
  refDay: string | null;
  tsLabel: "end" | "start";
}

/** A report listed in analysis_manifest.json / analysis.json `reports` (never a table). */
export interface ReportRef {
  name: string;
  path: string;
  format: string;
  sha256: string | null;
  bytes: number | null;
}

/**
 * Apply the consumer eligibility rules to the counts sources of a run (journey_time sources are not counts).
 * A source is comparable only when (a) it is not declared 'profile-only', (b) its interval is known and a
 * whole number of minutes (durationSeconds, else gridSeconds) and (c) its units are known: 'veh/h', or 'veh'
 * with 'declared' / 'inferred' confidence (converted to veh/h with the interval length). Otherwise it is
 * profile-only: shown in day profiles, never part of validation/comparison statistics.
 * Reference day: the source's own, else the run-level `observed.referenceDay`, else (typical days)
 * time of day only, else the legacy 2025-01-01. A timestamp convention that is 'unknown' is read as
 * interval-end (the documented default).
 */
export function resolveSources(sources: readonly ObservedSource[], observed?: Pick<ObservedMeta, "referenceDay"> | null): ResolvedSource[] {
  return sources
    .filter((s) => s.role !== "journey_time")
    .map((s) => {
      const dur = s.durationSeconds ?? s.gridSeconds;
      let reason: string | null = null;
      if (s.eligibility === "profile-only") reason = "declared profile-only (sparse points or interval unknown)";
      else if (dur === null || !(dur > 0)) reason = "its interval length is unknown";
      else if (dur % 60 !== 0) reason = "its interval is not a whole number of minutes";
      else if (s.units === "unknown") reason = "its units are unknown";
      else if (s.units === "veh" && s.unitConfidence === "unknown") reason = "its units (veh) are neither declared nor inferred";
      const refDay = s.referenceDay ?? observed?.referenceDay ?? (s.dateKind === "typical" ? null : "2025-01-01");
      return {
        ...s,
        effective: reason === null ? ("comparable" as const) : ("profile-only" as const),
        reason,
        durationMin: dur !== null && dur > 0 && dur % 60 === 0 ? dur / 60 : null,
        refDay,
        tsLabel: s.timestampConvention === "interval-start" ? ("start" as const) : ("end" as const),
      };
    });
}

/** True when every source shares interval, day, convention and units (so their rows can be pooled as one source). */
export function sourcesHomogeneous(list: readonly ResolvedSource[]): boolean {
  if (list.length < 2) return true;
  const key = (s: ResolvedSource): string => [s.durationMin, s.refDay, s.tsLabel, s.units, s.unitConfidence === "unknown" ? "u" : "k"].join("|");
  return list.every((s) => key(s) === key(list[0]));
}

export interface SourceChoice {
  value: string;
  /** 'all' = every comparable source ('both'). */
  kind: "all" | "source";
  source?: ResolvedSource;
}

/**
 * The 'Observed source' choices of a v2 package: one per source_id (counts sources only), plus 'both'
 * only when there are at least two comparable sources and they are homogeneous.
 */
export function sourceChoices(list: readonly ResolvedSource[]): SourceChoice[] {
  const comparable = list.filter((s) => s.effective === "comparable");
  const out: SourceChoice[] = [];
  if (comparable.length >= 2 && sourcesHomogeneous(comparable)) out.push({ value: "both", kind: "all" });
  for (const s of list) out.push({ value: s.sourceId, kind: "source", source: s });
  return out;
}

/** Default selection: 'both' when offered, else the first comparable source, else the first source. */
export function defaultSourceChoice(list: readonly ResolvedSource[]): string {
  const ch = sourceChoices(list);
  return ch.find((c) => c.kind === "all")?.value ?? list.find((s) => s.effective === "comparable")?.sourceId ?? list[0]?.sourceId ?? "both";
}

/** Sources selected by a choice value (unknown value = none). */
export function selectedSources(list: readonly ResolvedSource[], value: string): ResolvedSource[] {
  if (value === "both" && sourceChoices(list).some((c) => c.kind === "all")) return list.filter((s) => s.effective === "comparable");
  return list.filter((s) => s.sourceId === value);
}

/** Adapter spec of a resolved source. */
export function toSpec(s: ResolvedSource): ObsSourceSpec {
  return {
    sourceId: s.sourceId,
    durationSeconds: s.durationMin === null ? null : s.durationMin * 60,
    units: s.units,
    unitConfidence: s.unitConfidence,
    eligibility: s.effective,
    referenceDay: s.refDay,
    tsLabel: s.tsLabel,
  };
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
  /**
   * Observation contract v2: the selected sources (already resolved, in preference order). Switches the
   * adapter to extended mode (per-source interval, units, day); `obsSource` is then only informative.
   */
  sources?: ResolvedSource[];
  /** Columns of the raw obs table (extended mode only). */
  obsColumns?: readonly string[];
}

export function rawTableNames(prefix: string): { sim: string; obs: string } {
  if (!PREFIX.test(prefix)) throw new Error(`invalid table prefix '${prefix}'`);
  return { sim: `${prefix}sim_raw`, obs: `${prefix}obs_raw` };
}

/** Adapter + det views for the given config (re-created before every query, see det-data.ts). */
export function detViewScript(cfg: DetViewConfig): string {
  const t = rawTableNames(cfg.prefix);
  const extended = cfg.sources !== undefined;
  if (!extended && !isObsSource(cfg.obsSource)) throw new Error("invalid obsSource");
  const bucket = intArg(cfg.bucketMinutes, "bucketMinutes");
  if (bucket <= 0) throw new Error("bucketMinutes must be > 0");
  const adapter: Parameters<typeof buildAdapterSql>[0] = { rawSimTable: t.sim, rawObsTable: t.obs, obsSource: extended ? "both" : (cfg.obsSource as LegacyObsSource) };
  if (cfg.sources) {
    adapter.obsSources = cfg.sources.map(toSpec);
    if (cfg.obsColumns) adapter.obsColumns = cfg.obsColumns;
  } else if (cfg.observed) {
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
export const DET_VIEWS = ["v_det_summary", "v_det_validation", "v_obs_norm", "v_obs_profile", "v_obs_ext", "v_obs_src", "v_sim_norm"] as const;

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
export function dayProfileObsQuery(scope: ProfileScope, detectorId?: string, gridMin: number | null = 5, relation: "v_obs_norm" | "v_obs_profile" = "v_obs_norm"): string {
  // gridMin null (v2 packages): every selected source row of the relation, whatever its interval
  const grid = gridMin === null ? null : intArg(gridMin, "gridMin");
  if (grid !== null && grid <= 0) throw new Error("gridMin must be > 0");
  if (relation !== "v_obs_norm" && relation !== "v_obs_profile") throw new Error("invalid observed relation");
  const id = detectorId === undefined ? "" : detectorId.replace(/'/g, "''");
  const match = scope === "detector" ? `AND CAST(o.detector_id AS VARCHAR) = '${id}'` : "";
  const aggregate = scope === "sum" ? "SUM(o.flow)" : "AVG(o.flow)";
  return `WITH matched AS (SELECT DISTINCT CAST(eid AS VARCHAR) detector_id FROM v_sim_norm WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '')\n` +
    `SELECT CAST(o.t_start_min AS INTEGER) AS profile_minute, ${aggregate} AS profile_value FROM ${relation} o JOIN matched m ON m.detector_id = CAST(o.detector_id AS VARCHAR) ` +
    `WHERE ${grid === null ? "TRUE" : `o.dur_min = ${grid}`} ${match} GROUP BY o.t_start_min ORDER BY o.t_start_min LIMIT ${grid === null ? 1440 : Math.ceil(1440 / grid)}`;
}

/** Simulated profile as one row per (interval start, duration), preserving mixed durations. */
export function dayProfileSimQuery(scope: ProfileScope, detectorId?: string, matchedOnly = false, obsRelation: "v_obs_norm" | "v_obs_profile" = "v_obs_norm"): string {
  if (obsRelation !== "v_obs_norm" && obsRelation !== "v_obs_profile") throw new Error("invalid observed relation");
  const id = detectorId === undefined ? "" : detectorId.replace(/'/g, "''");
  const filter = scope === "detector" ? "AND s.eid = '" + id + "'" : "";
  const aggregate = scope === "sum" ? "SUM(s.flow)" : "AVG(s.flow)";
  // C8: oids sharing an eid are pooled per (eid, interval) with the mean first, so a network total counts each eid once.
  const pooled = "pooled AS (SELECT CAST(eid AS VARCHAR) eid, t_start_min, dur_min, AVG(flow) flow FROM v_sim_norm WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '' GROUP BY 1, 2, 3)";
  const matched = matchedOnly && scope !== "detector" ? ", matched AS (SELECT DISTINCT s.eid detector_id FROM pooled s JOIN " + obsRelation + " o ON CAST(o.detector_id AS VARCHAR) = s.eid)" : "";
  const join = matched ? "JOIN matched m ON m.detector_id = s.eid " : "";
  return "WITH " + pooled + matched + " SELECT CAST(s.t_start_min * 60 AS INTEGER) interval_start_s, CAST(s.dur_min * 60 AS INTEGER) duration_s, " + aggregate + " AS profile_value FROM pooled s " + join +
    "WHERE TRUE " + filter + " GROUP BY s.t_start_min, s.dur_min ORDER BY s.t_start_min, s.dur_min";
}

/** Simulated eids that several simulated oids share (C8): eid and how many oids. */
export const SHARED_EID_SQL =
  "SELECT CAST(eid AS VARCHAR) AS eid, count(DISTINCT oid) AS n_oids FROM v_sim_norm " +
  "WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '' GROUP BY 1 HAVING count(DISTINCT oid) > 1";

/**
 * Simulation-only aggregation (no observed table, or validation disabled): one row per eid, pooled per
 * (eid, interval) with the MEAN across its oids (C8), then the duration-weighted mean over the intervals.
 */
export const SIM_ONLY_SQL =
  "WITH p AS (SELECT CAST(eid AS VARCHAR) detector_id, t_start_min, dur_min, min(oid) oid, avg(flow) flow FROM v_sim_norm " +
  "WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '' AND flow IS NOT NULL AND dur_min > 0 GROUP BY 1, 2, 3) " +
  "SELECT detector_id, min(oid) oid, sum(flow * dur_min) / sum(dur_min) sim_flow_h FROM p GROUP BY detector_id ORDER BY detector_id";
