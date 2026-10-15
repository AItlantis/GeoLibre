/**
 * C11: period matching of OBSERVED time-only (typical-day) journey-time rows against a SIMULATED run.
 * Pure functions (no DOM, no DuckDB).
 *
 *  - an observed row at clock time t is a POINT observation unless it declares window_start_s/window_end_s
 *    (then it is a WINDOW observation); the manifest/run config can force 'point' or 'window'.
 *  - POINT: paired with the simulated bucket that CONTAINS t under the declared timestamp convention:
 *      'interval-end'   (default; the simulated ts is the END of the bucket)  bucket = (start, end]
 *      'interval-start'                                                         bucket = [start, end)
 *    The simulated bucket span is always taken from interval_start_s/duration_s; the convention only decides the
 *    boundary tie (an observation at exactly 09:00 belongs to the bucket ENDING at 09:00 under 'interval-end').
 *  - WINDOW: compared with the mean of the simulated buckets lying completely inside the window.
 *  - only observations inside the run period are compared. The run period is the manifest `run_period` when present,
 *    else it is derived from the simulated buckets themselves. `tolerance_s` widens the period test and lets a point
 *    that falls in a gap between buckets use the nearest bucket within that many seconds (default 0).
 *  - everything that cannot be paired is listed with its reason; nothing is silently dropped.
 */
import { pairKey } from "./match";
import type { ObsRow } from "./profile";
import { classifyError, DEFAULT_CRITERIA, type Criteria, type Pair, type RouteRow, type SimRow, type Status } from "./validation";

export type Convention = "interval-start" | "interval-end";
export type MatchMode = "auto" | "point" | "window";

export interface RunPeriod {
  start_s: number;
  end_s: number;
  interval_s: number | null;
  day: string | null;
  source: string;
}

export interface PeriodConfig {
  matchMode: MatchMode;
  convention: Convention;
  toleranceS: number;
  /** true when matchMode/convention/tolerance come from the run configuration (manifest `declared`). */
  declared: boolean;
  runPeriod: RunPeriod | null;
}

export const DEFAULT_PERIOD_CONFIG: PeriodConfig = { matchMode: "auto", convention: "interval-end", toleranceS: 0, declared: false, runPeriod: null };

// ---- manifest -----------------------------------------------------------------------------------------------
export interface ObsSourceCfg {
  source_id: string | null;
  file: string | null;
  matchMode: MatchMode;
  convention: Convention | null;
  toleranceS: number | null;
  declared: boolean;
}

export interface PeriodInfo {
  /** run name -> period, when the manifest states one per run. */
  runPeriods: Record<string, RunPeriod>;
  /** the (single-run) period stated at the top level of the manifest. */
  defaultPeriod: RunPeriod | null;
  sources: ObsSourceCfg[];
}

export const EMPTY_PERIOD_INFO: PeriodInfo = { runPeriods: {}, defaultPeriod: null, sources: [] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseRunPeriod(v: unknown): RunPeriod | null {
  if (!isObj(v)) return null;
  const start = numOrNull(v.start_s ?? v.startS);
  const end = numOrNull(v.end_s ?? v.endS);
  if (start === null || end === null || end <= start) return null;
  return { start_s: start, end_s: end, interval_s: numOrNull(v.interval_s ?? v.intervalS), day: strOrNull(v.day), source: strOrNull(v.source) ?? "unknown" };
}

function parseConvention(v: unknown): Convention | null {
  return v === "interval-start" || v === "interval-end" ? v : null;
}

const baseName = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? p;

/** Tolerant reader of the per-run manifest fields run_period / run_periods / runs[].run_period / observed_sources. */
export function parsePeriodInfo(manifest: unknown): PeriodInfo {
  if (!isObj(manifest)) return EMPTY_PERIOD_INFO;
  const scopes: Record<string, unknown>[] = [manifest, ...(isObj(manifest.analysis) ? [manifest.analysis] : [])];
  const runPeriods: Record<string, RunPeriod> = {};
  let defaultPeriod: RunPeriod | null = null;
  const sources: ObsSourceCfg[] = [];
  for (const m of scopes) {
    defaultPeriod ??= parseRunPeriod(m.run_period);
    if (isObj(m.run_periods)) for (const [k, v] of Object.entries(m.run_periods)) { const p = parseRunPeriod(v); if (p) runPeriods[k] ??= p; }
    const runs = m.runs;
    const list: Array<[string | null, unknown]> = Array.isArray(runs) ? runs.map((r) => [isObj(r) ? strOrNull(r.run ?? r.name ?? r.id) : null, r]) : isObj(runs) ? Object.entries(runs) : [];
    for (const [name, r] of list) {
      if (!isObj(r) || !name) continue;
      const p = parseRunPeriod(r.run_period);
      if (p) runPeriods[name] ??= p;
    }
    if (Array.isArray(m.observed_sources)) {
      for (const s of m.observed_sources) {
        if (!isObj(s)) continue;
        const role = strOrNull(s.role);
        if (role && role !== "journey_time" && role !== "journey-time") continue;
        const mode = s.matchMode ?? s.match_mode ?? s.match;
        sources.push({
          source_id: strOrNull(s.source_id),
          file: strOrNull(s.file),
          matchMode: mode === "point" || mode === "window" ? mode : "auto",
          convention: parseConvention(s.convention) ?? parseConvention(s.timestampConvention),
          toleranceS: numOrNull(s.tolerance_s ?? s.toleranceS),
          declared: s.declared === true,
        });
      }
    }
  }
  return { runPeriods, defaultPeriod, sources };
}

/** Effective config for one observed source (matched by source_id or file name) and run. */
export function resolvePeriodConfig(info: PeriodInfo, source: { source: string; source_id?: string | null }, run: string | null): PeriodConfig {
  const entry = info.sources.find((s) => (s.source_id && source.source_id && s.source_id === source.source_id) || (s.file && baseName(s.file) === baseName(source.source)) || (s.source_id && s.source_id === source.source));
  const period = (run ? info.runPeriods[run] : null) ?? info.defaultPeriod;
  return {
    matchMode: entry?.matchMode ?? "auto",
    convention: entry?.convention ?? "interval-end",
    toleranceS: entry?.toleranceS ?? 0,
    declared: entry?.declared ?? false,
    runPeriod: period,
  };
}

// ---- helpers -------------------------------------------------------------------------------------------------
export function clock(s: number): string {
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const spanLabel = (a: number, b: number): string => `${clock(a)}-${clock(b)}`;

/** Period derived from the simulated buckets themselves (min start .. max end). */
export function derivePeriod(sim: readonly SimRow[]): RunPeriod | null {
  let lo = Infinity;
  let hi = -Infinity;
  let step: number | null = null;
  for (const r of sim) {
    if (r.interval_start_s === undefined || r.duration_s === undefined || !(r.duration_s > 0)) continue;
    lo = Math.min(lo, r.interval_start_s);
    hi = Math.max(hi, r.interval_start_s + r.duration_s);
    step = step === null ? r.duration_s : Math.min(step, r.duration_s);
  }
  return Number.isFinite(lo) && hi > lo ? { start_s: lo, end_s: hi, interval_s: step, day: null, source: "subpath_sim_jt" } : null;
}

/** Does bucket [start, start+dur] contain t under the convention (boundary tie only)? */
export function bucketContains(start: number, dur: number, t: number, convention: Convention): boolean {
  return convention === "interval-end" ? t > start && t <= start + dur : t >= start && t < start + dur;
}

function inPeriod(t: number, p: RunPeriod, convention: Convention, tol: number): boolean {
  if (tol > 0) return t >= p.start_s - tol && t <= p.end_s + tol;
  return bucketContains(p.start_s, p.end_s - p.start_s, t, convention);
}

// ---- observed points ---------------------------------------------------------------------------------------
export interface ObsPoint {
  key: string;
  route: string;
  direction: string;
  subpath_oid: string | null;
  tS: number;
  win: { startS: number; endS: number } | null;
  obs: number;
  min: number | null;
  max: number | null;
}

/** Observed rows of ONE source -> observation points (one per row; typical rows are single-day: mean == median). */
export function obsPointsOf(rows: readonly ObsRow[], source: string): { points: ObsPoint[]; invalid: ObsRow[] } {
  const points: ObsPoint[] = [];
  const invalid: ObsRow[] = [];
  for (const r of rows) {
    if (r.source !== source) continue;
    const key = pairKey(r.route, r.direction_norm);
    const v = r.mean_s;
    if (!key || v === null || !Number.isFinite(v) || v <= 0) { invalid.push(r); continue; }
    const ws = r.window_start_s ?? null;
    const we = r.window_end_s ?? null;
    points.push({
      key, route: r.route, direction: r.direction_norm, subpath_oid: r.subpath_oid ?? null,
      tS: r.t_s ?? r.bucket_start_min * 60,
      win: ws !== null && we !== null && we > ws ? { startS: ws, endS: we } : null,
      obs: v,
      min: r.sup_min_s ?? null,
      max: r.sup_max_s ?? null,
    });
  }
  return { points, invalid };
}

// ---- pairing -------------------------------------------------------------------------------------------------
export type UnpairedCode = "outside-period" | "no-bucket" | "no-sim-route" | "window-missing" | "invalid" | "no-window-bucket";

export interface JtPair {
  key: string;
  route: string;
  direction: string;
  subpath_oid: string | null;
  run: string | null;
  kind: "point" | "window";
  tS: number;
  windowS: [number, number] | null;
  timeLabel: string;
  sim: number;
  obs: number;
  min: number | null;
  max: number | null;
  errorS: number;
  errorPct: number | null;
  inBand: boolean | null;
  status: Status;
  nBuckets: number;
}

export interface Unpaired {
  key: string | null;
  route: string;
  direction: string;
  timeLabel: string;
  code: UnpairedCode;
  reason: string;
}

export interface PeriodResult {
  period: RunPeriod | null;
  periodLabel: string | null;
  config: PeriodConfig;
  pairs: JtPair[];
  unpaired: Unpaired[];
  /** Observed routes with no simulated series at all ("route / dir"). */
  obsOnlyRoutes: string[];
  /** Simulated routes with no observation. */
  simOnlyRoutes: string[];
}

export function classifyPair(sim: number, obs: number, min: number | null, max: number | null, c: Criteria = DEFAULT_CRITERIA): Status {
  if (min !== null && max !== null && sim >= min && sim <= max) return "pass";
  return classifyError(sim, obs, c);
}

const routeLabel = (r: string, d: string): string => `${r} - ${d}`;

/** Pair one run's simulated rows with the observed points of one source. `sim` must hold ONE run. */
export function matchPeriod(obs: readonly ObsPoint[], sim: readonly SimRow[], cfg: PeriodConfig, criteria: Criteria = DEFAULT_CRITERIA, run: string | null = null): PeriodResult {
  const period = cfg.runPeriod ?? derivePeriod(sim);
  const periodLabel = period ? spanLabel(period.start_s, period.end_s) : null;
  const byKey = new Map<string, Array<{ start: number; dur: number; sim: number }>>();
  const simNames = new Map<string, string>();
  for (const r of sim) {
    const key = pairKey(r.route, r.direction_norm);
    if (!key || !Number.isFinite(r.sim_s) || r.interval_start_s === undefined || r.duration_s === undefined || !(r.duration_s > 0)) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ start: r.interval_start_s, dur: r.duration_s, sim: r.sim_s });
    if (!simNames.has(key)) simNames.set(key, routeLabel(r.route, r.direction_norm));
  }
  for (const list of byKey.values()) list.sort((a, b) => a.start - b.start);

  const pairs: JtPair[] = [];
  const unpaired: Unpaired[] = [];
  const obsKeys = new Set<string>();
  const routesWithSim = new Set<string>();
  const routesNoSim = new Map<string, string>();
  const tol = cfg.toleranceS;

  for (const o of obs) {
    obsKeys.add(o.key);
    const list = byKey.get(o.key);
    const wantsWindow = cfg.matchMode === "window" || (cfg.matchMode === "auto" && o.win !== null);
    const label = routeLabel(o.route, o.direction);
    const timeLabel = wantsWindow && o.win ? spanLabel(o.win.startS, o.win.endS) : clock(o.tS);
    const miss = (code: UnpairedCode, reason: string): void => { unpaired.push({ key: o.key, route: o.route, direction: o.direction, timeLabel, code, reason }); };
    if (!list) { routesNoSim.set(o.key, label); miss("no-sim-route", "no simulated journey time for this route"); continue; }
    if (!period) { miss("outside-period", "the simulated period is unknown"); continue; }
    if (wantsWindow) {
      if (!o.win) { miss("window-missing", "window matching is configured but the observation declares no window (window_start_s / window_end_s)"); continue; }
      if (o.win.startS < period.start_s - tol || o.win.endS > period.end_s + tol) { miss("outside-period", `window ${timeLabel} is not inside the simulated period ${periodLabel}`); continue; }
      const inside = list.filter((b) => b.start >= o.win!.startS - tol && b.start + b.dur <= o.win!.endS + tol);
      if (!inside.length) { miss("no-window-bucket", `no simulated bucket lies inside the window ${timeLabel}`); continue; }
      const sv = inside.reduce((a, b) => a + b.sim, 0) / inside.length;
      pairs.push(makePair(o, run, "window", sv, [o.win.startS, o.win.endS], timeLabel, inside.length, criteria));
      routesWithSim.add(o.key);
      continue;
    }
    if (!inPeriod(o.tS, period, cfg.convention, tol)) { miss("outside-period", `outside the simulated period ${periodLabel}`); continue; }
    let hit = list.find((b) => bucketContains(b.start, b.dur, o.tS, cfg.convention));
    if (!hit && tol > 0) {
      const dist = (b: { start: number; dur: number }): number => (o.tS < b.start ? b.start - o.tS : o.tS > b.start + b.dur ? o.tS - (b.start + b.dur) : 0);
      const best = list.reduce((a, b) => (dist(b) < dist(a) ? b : a), list[0]);
      if (dist(best) <= tol) hit = best;
    }
    if (!hit) { miss("no-bucket", `no simulated bucket contains ${timeLabel} for this route`); continue; }
    pairs.push(makePair(o, run, "point", hit.sim, null, timeLabel, 1, criteria));
    routesWithSim.add(o.key);
  }
  return {
    period, periodLabel, config: cfg, pairs, unpaired,
    obsOnlyRoutes: [...routesNoSim].filter(([k]) => !routesWithSim.has(k)).map(([, v]) => v),
    simOnlyRoutes: [...simNames].filter(([k]) => !obsKeys.has(k)).map(([, v]) => v),
  };
}

function makePair(o: ObsPoint, run: string | null, kind: "point" | "window", sim: number, win: [number, number] | null, timeLabel: string, nBuckets: number, c: Criteria): JtPair {
  const errorS = sim - o.obs;
  const errorPct = o.obs > 0 ? (errorS / o.obs) * 100 : null;
  const inBand = o.min !== null && o.max !== null ? sim >= o.min && sim <= o.max : null;
  return { key: o.key, route: o.route, direction: o.direction, subpath_oid: o.subpath_oid, run, kind, tS: o.tS, windowS: win, timeLabel, sim, obs: o.obs, min: o.min, max: o.max, errorS, errorPct, inBand, status: classifyPair(sim, o.obs, o.min, o.max, c), nBuckets };
}

// ---- aggregates ------------------------------------------------------------------------------------------------
export interface Aggregates {
  n: number;
  nRoutes: number;
  /** mean absolute percentage error over pairs (null without valid pairs). */
  mape: number | null;
  /** mean signed error in seconds (sim - obs). */
  bias: number | null;
  /** share (0-100) of pairs whose simulated value lies inside the supplied min-max band; null when no pair has a band. */
  bandHitRate: number | null;
  nBand: number;
  nPass: number;
  nWarn: number;
  nFail: number;
}

export function aggregates(pairs: readonly JtPair[]): Aggregates {
  const pcts = pairs.map((p) => p.errorPct).filter((v): v is number => v !== null);
  const banded = pairs.filter((p) => p.inBand !== null);
  return {
    n: pairs.length,
    nRoutes: new Set(pairs.map((p) => p.key)).size,
    mape: pcts.length ? pcts.reduce((a, v) => a + Math.abs(v), 0) / pcts.length : null,
    bias: pairs.length ? pairs.reduce((a, p) => a + p.errorS, 0) / pairs.length : null,
    bandHitRate: banded.length ? (banded.filter((p) => p.inBand).length / banded.length) * 100 : null,
    nBand: banded.length,
    nPass: pairs.filter((p) => p.status === "pass").length,
    nWarn: pairs.filter((p) => p.status === "warn").length,
    nFail: pairs.filter((p) => p.status === "fail").length,
  };
}

const RANK: Record<Status, number> = { pass: 0, warn: 1, fail: 2 };
const worst = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);

/** Per-route rows: the route status is the WORST status of its pairs; errors are means over the pairs. */
export function routeRowsFromPairs(pairs: ReadonlyArray<Pick<Pair, "key" | "route" | "direction" | "obs" | "sim" | "errorPct" | "status">>): RouteRow[] {
  const by = new Map<string, typeof pairs[number][]>();
  for (const p of pairs) (by.get(p.key) ?? by.set(p.key, []).get(p.key)!).push(p);
  return [...by].map(([key, ps]) => {
    const obs = ps.reduce((a, p) => a + p.obs, 0) / ps.length;
    const sim = ps.reduce((a, p) => a + p.sim, 0) / ps.length;
    const status = ps.reduce<Status>((a, p) => worst(a, p.status ?? "fail"), "pass");
    return { key, route: ps[0].route, direction: ps[0].direction, nBuckets: ps.length, obs, sim, delta: sim - obs, ratio: obs > 0 ? sim / obs : null, errorPct: ps.reduce((a, p) => a + (p.errorPct ?? 0), 0) / ps.length, absError: Math.abs(sim - obs), status };
  }).sort((a, b) => a.route.localeCompare(b.route) || a.direction.localeCompare(b.direction));
}

/** JtPair -> the Pair shape used by the existing validation charts/KPIs (bucket = minute of the clock time). */
export function toValidationPairs(pairs: readonly JtPair[]): Pair[] {
  return pairs.map((p) => ({ key: p.key, route: p.route, direction: p.direction, bucket: Math.round(p.tS / 60), obs: p.obs, sim: p.sim, errorPct: p.errorPct ?? undefined, absError: Math.abs(p.errorS), status: p.status }));
}

// ---- availability --------------------------------------------------------------------------------------------------
export interface Availability {
  enabled: boolean;
  reason: string | null;
}

/** Validation/Comparison are enabled iff the run has simulated JT AND at least one pair falls inside the run period. */
export function periodAvailability(a: { hasSim: boolean; simReason: string | null; hasObs: boolean; result: PeriodResult | null }): Availability {
  if (!a.hasSim) return { enabled: false, reason: a.simReason ?? "no simulated subpath table for static runs" };
  if (!a.hasObs) return { enabled: false, reason: "no observed journey-time rows" };
  const r = a.result;
  if (!r) return { enabled: false, reason: "no simulated subpath table for static runs" };
  if (r.pairs.length) return { enabled: true, reason: null };
  const outside = r.unpaired.filter((u) => u.code === "outside-period");
  if (r.unpaired.length && outside.length === r.unpaired.length && r.periodLabel) {
    const times = [...new Set(outside.map((u) => u.timeLabel))];
    const shown = times.length > 4 ? `${times.slice(0, 4).join(", ")}, ...` : times.join(", ");
    return { enabled: false, reason: `observations (${shown}) are outside the simulated period ${r.periodLabel}` };
  }
  if (r.unpaired.length && r.unpaired.every((u) => u.code === "no-sim-route")) return { enabled: false, reason: "no observed route matches a simulated route" };
  const first = r.unpaired[0];
  return { enabled: false, reason: first ? `no observation could be paired with the simulated run (${first.reason})` : "no observation could be paired with the simulated run" };
}

// ---- map colours (signed error, diverging) -----------------------------------------------------------------------
const NEG = "#2166ac";
const MID = "#f7f7f7";
const POS = "#b2182b";
const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
export const DIVERGING_GRADIENT = `linear-gradient(90deg, ${NEG}, ${MID}, ${POS})`;

/** Signed error (%) -> colour: blue = simulated faster than observed, red = slower; capped at +-cap. */
export function divergingColour(errorPct: number | null, cap = 50): string {
  if (errorPct === null || !Number.isFinite(errorPct)) return "#9ca3af";
  const x = Math.max(-1, Math.min(1, errorPct / cap));
  const [a, b] = x < 0 ? [hex(MID), hex(NEG)] : [hex(MID), hex(POS)];
  const k = Math.abs(x);
  return toHex(a.map((v, i) => v + (b[i] - v) * k));
}
