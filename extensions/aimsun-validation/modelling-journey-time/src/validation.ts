/** Pure validation and comparison calculations for observed and simulated JT curves. */
import { regressionStats, type RegressionStats } from "../../_shared/src/metrics";
import { pairKey } from "./match";
import type { ObsRow, Stat } from "./profile";

export interface Criteria {
  passPct: number;
  failPct: number;
  targetPct: number;
  absoluteEnabled: boolean;
  absoluteSeconds: number;
  bandEdges: number[];
  bandPassPct: number;
  bandWarnPct: number;
}
export const DEFAULT_CRITERIA: Criteria = { passPct: 15, failPct: 30, targetPct: 85, absoluteEnabled: false, absoluteSeconds: 60, bandEdges: [120, 300, 600, 1200], bandPassPct: 85, bandWarnPct: 70 };

export function validateCriteria(value: unknown): Criteria {
  if (!value || typeof value !== "object") throw new Error("criteria must be an object");
  const c = value as Partial<Criteria>;
  const edges = c.bandEdges;
  const nums = [c.passPct, c.failPct, c.targetPct, c.absoluteSeconds, c.bandPassPct, c.bandWarnPct, ...(edges ?? [])];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("criteria values must be finite numbers");
  if (c.passPct! < 0 || c.passPct! > c.failPct!) throw new Error("pass error must be non-negative and no greater than fail error");
  if (c.targetPct! < 0 || c.targetPct! > 100) throw new Error("target must be between 0 and 100");
  if (c.absoluteSeconds! < 0) throw new Error("absolute threshold must be non-negative");
  if (c.bandPassPct! < 0 || c.bandPassPct! > 100 || c.bandWarnPct! < 0 || c.bandWarnPct! > c.bandPassPct!) throw new Error("band pass-rate thresholds must be ordered within 0 to 100");
  if (!edges?.length || edges.some((n, i) => n < 0 || (i > 0 && n <= edges[i - 1]))) throw new Error("journey-time band edges must be increasing non-negative numbers");
  return { passPct: c.passPct!, failPct: c.failPct!, targetPct: c.targetPct!, absoluteEnabled: c.absoluteEnabled === true, absoluteSeconds: c.absoluteSeconds!, bandEdges: [...edges], bandPassPct: c.bandPassPct!, bandWarnPct: c.bandWarnPct! };
}

export type Status = "pass" | "warn" | "fail";
export function relativeError(sim: number, obs: number): number | null { return Number.isFinite(sim) && Number.isFinite(obs) && obs > 0 ? (sim - obs) / obs * 100 : null; }
export function classifyError(sim: number, obs: number, c: Criteria = DEFAULT_CRITERIA): Status {
  if (c.absoluteEnabled && Math.abs(sim - obs) <= c.absoluteSeconds) return "pass";
  const e = relativeError(sim, obs);
  if (e === null) return "fail";
  return Math.abs(e) <= c.passPct ? "pass" : Math.abs(e) <= c.failPct ? "warn" : "fail";
}

export interface SimRow {
  route: string; direction_norm: string; bucket_start_min: number; sim_s: number; n: number;
  interval_start_s?: number; duration_s?: number; run?: string;
}
export interface Pair { key: string; route: string; direction: string; bucket: number; obs: number; sim: number; errorPct?: number; absError?: number; status?: Status }
export interface PairingResult { pairs: Pair[]; obsOnly: string[]; simOnly: string[]; noOverlap: string[] }
export interface Window { from: number; to: number }
const label = (r: string, d: string): string => `${r} - ${d}`;

/** Pair a typical-day observed value with the simulated segment covering that bucket. */
export function pairObsSim(obs: readonly ObsRow[], sim: readonly SimRow[], stat: Stat, win: Window | null, criteria: Criteria = DEFAULT_CRITERIA): PairingResult {
  const validObs = new Map<string, { route: string; direction: string; buckets: Map<number, number> }>();
  for (const r of obs) {
    const value = stat === "mean" ? r.mean_s : r.median_s, key = pairKey(r.route, r.direction_norm);
    if (!key || value === null || !Number.isFinite(value)) continue;
    const e = validObs.get(key) ?? { route: r.route, direction: r.direction_norm, buckets: new Map<number, number>() };
    e.buckets.set(r.bucket_start_min, value); validObs.set(key, e);
  }
  const validSim = new Map<string, SimRow[]>();
  for (const r of sim) { const key = pairKey(r.route, r.direction_norm); if (key && Number.isFinite(r.sim_s)) (validSim.get(key) ?? validSim.set(key, []).get(key)!).push(r); }
  const pairs: Pair[] = [], noOverlap: string[] = [];
  for (const [key, o] of validObs) {
    const segments = validSim.get(key); if (!segments) continue;
    let overlap = false;
    for (const [bucket, ov] of o.buckets) {
      if (win && (bucket < win.from || bucket >= win.to)) continue;
      const start = bucket * 60, end = start + 900;
      const weighted = segments.flatMap((s) => {
        if (s.interval_start_s === undefined || s.duration_s === undefined) return s.bucket_start_min === bucket ? [{ row: s, weight: 1 }] : [];
        const overlap = Math.max(0, Math.min(end, s.interval_start_s + s.duration_s) - Math.max(start, s.interval_start_s));
        return overlap ? [{ row: s, weight: overlap }] : [];
      });
      if (!weighted.length) continue;
      const sv = weighted.reduce((n, x) => n + x.row.sim_s * x.weight, 0) / weighted.reduce((n, x) => n + x.weight, 0);
      const errorPct = relativeError(sv, ov);
      pairs.push({ key, route: o.route, direction: o.direction, bucket, obs: ov, sim: sv, errorPct: errorPct ?? undefined, absError: Math.abs(sv - ov), status: classifyError(sv, ov, criteria) }); overlap = true;
    }
    if (!overlap) noOverlap.push(label(o.route, o.direction));
  }
  return { pairs, obsOnly: [...validObs].filter(([k]) => !validSim.has(k)).map(([, v]) => label(v.route, v.direction)), simOnly: [...validSim].filter(([k]) => !validObs.has(k)).map(([, v]) => label(v[0].route, v[0].direction_norm)), noOverlap };
}

export interface RouteRow { key: string; route: string; direction: string; nBuckets: number; obs: number; sim: number; delta: number; ratio: number | null; errorPct: number; absError: number; status: Status }
export function perRoute(pairs: readonly Pair[], c: Criteria = DEFAULT_CRITERIA): RouteRow[] {
  const by = new Map<string, Pair[]>(); for (const p of pairs) (by.get(p.key) ?? by.set(p.key, []).get(p.key)!).push(p);
  return [...by].map(([key, ps]) => {
    const obs = ps.reduce((a, p) => a + p.obs, 0) / ps.length, sim = ps.reduce((a, p) => a + p.sim, 0) / ps.length;
    return { key, route: ps[0].route, direction: ps[0].direction, nBuckets: ps.length, obs, sim, delta: sim - obs, ratio: obs > 0 ? sim / obs : null, errorPct: relativeError(sim, obs) ?? 0, absError: Math.abs(sim - obs), status: classifyError(sim, obs, c) };
  }).sort((a, b) => a.route.localeCompare(b.route) || a.direction.localeCompare(b.direction));
}
export type Level = "route" | "bucket";
export function points(pairs: readonly Pair[], level: Level): { obs: number[]; sim: number[]; labels: string[] } {
  if (level === "bucket") return { obs: pairs.map((p) => p.obs), sim: pairs.map((p) => p.sim), labels: pairs.map((p) => `${label(p.route, p.direction)} @${p.bucket}`) };
  const rows = perRoute(pairs); return { obs: rows.map((r) => r.obs), sim: rows.map((r) => r.sim), labels: rows.map((r) => label(r.route, r.direction)) };
}

export interface Kpis extends RegressionStats { pctWithin: number | null; tolerancePct: number; meanRatio: number | null; nPass: number; nWarn: number; nFail: number; }
export function kpis(obs: readonly number[], sim: readonly number[], tolerancePct: number, criteria: Criteria = DEFAULT_CRITERIA): Kpis {
  const base = regressionStats(obs, sim); let nPass = 0, nWarn = 0, nFail = 0, ratio = 0;
  let within = 0, validRatios = 0;
  for (let i = 0; i < Math.min(obs.length, sim.length); i++) { const st = classifyError(sim[i], obs[i], criteria); if (st === "pass") nPass++; else if (st === "warn") nWarn++; else nFail++; if (obs[i] > 0) { ratio += sim[i] / obs[i]; validRatios++; if (Math.abs(sim[i] - obs[i]) / obs[i] <= tolerancePct / 100 + 1e-12) within++; } }
  const n = nPass + nWarn + nFail;
  return { ...base, pctWithin: validRatios ? 100 * within / validRatios : null, tolerancePct, meanRatio: validRatios ? ratio / validRatios : null, nPass, nWarn, nFail };
}

export interface BandStats { label: string; n: number; passPct: number | null }
export function journeyTimeBands(rows: readonly RouteRow[], edges: readonly number[] = DEFAULT_CRITERIA.bandEdges): BandStats[] {
  if (!edges.length || edges.some((v, i) => !Number.isFinite(v) || v < 0 || (i > 0 && v <= edges[i - 1]))) throw new Error("journey-time band edges must be increasing non-negative numbers");
  const bounds = [0, ...edges, Infinity];
  return bounds.slice(0, -1).map((min, i) => {
    const max = bounds[i + 1], group = rows.filter((r) => r.obs >= min && r.obs < max), pass = group.filter((r) => r.status === "pass").length;
    return { label: i === 0 ? `<${max}` : i === bounds.length - 2 ? `≥${min}` : `${min}–${max}`, n: group.length, passPct: group.length ? pass / group.length * 100 : null };
  });
}

export interface ComparisonRow { key: string; route: string; direction: string; a: number | null; b: number | null; change: number | null; status: "improved" | "unchanged" | "degraded" | "only" }
export function joinComparison(a: readonly RouteRow[], b: readonly RouteRow[]): ComparisonRow[] {
  const am = new Map(a.map((r) => [r.key, r])), bm = new Map(b.map((r) => [r.key, r]));
  return [...new Set([...am.keys(), ...bm.keys()])].map((key) => {
    const x = am.get(key), y = bm.get(key), change = x && y ? Math.abs(x.errorPct) - Math.abs(y.errorPct) : null;
    return { key, route: x?.route ?? y!.route, direction: x?.direction ?? y!.direction, a: x ? Math.abs(x.errorPct) : null, b: y ? Math.abs(y.errorPct) : null, change,
      status: change === null ? "only" : change > 1e-9 ? "improved" : change < -1e-9 ? "degraded" : "unchanged" };
  });
}
