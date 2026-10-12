/**
 * Observed-vs-simulated journey time pairing, per-route aggregation and KPIs. Pure functions.
 *
 * Pairing key = match key of (route, direction) after the shared normalisation (case/whitespace,
 * In->IB, Out->OB), joined with the time-of-day bucket. Observed values are ONE source (never mixed)
 * and one statistic across days (mean or median); simulated values are the mean of the sim rows in
 * the bucket (several replications/rows per bucket are averaged).
 */
import { regressionStats, type RegressionStats } from "../../_shared/src/metrics";
import { pairKey } from "../../aimsun-subpath-jt/src/common/match";
import type { ObsRow, Stat } from "../../aimsun-subpath-jt/src/common/profile";

export interface SimRow {
  route: string;
  direction_norm: string;
  bucket_start_min: number;
  sim_s: number;
  n: number;
}

export interface Pair {
  key: string;
  route: string;
  direction: string;
  bucket: number;
  obs: number;
  sim: number;
}

export interface PairingResult {
  pairs: Pair[];
  /** Observed route/direction labels with no simulated counterpart (by key). */
  obsOnly: string[];
  /** Simulated route/direction labels with no observed counterpart (by key). */
  simOnly: string[];
  /** Keys present on both sides but with no common bucket inside the window. */
  noOverlap: string[];
}

export interface Window {
  from: number; // minutes, inclusive
  to: number; // minutes, exclusive
}

const label = (route: string, dir: string): string => `${route} - ${dir}`;

export function pairObsSim(obs: readonly ObsRow[], sim: readonly SimRow[], stat: Stat, win: Window | null): PairingResult {
  const inWin = (b: number): boolean => !win || (b >= win.from && b < win.to);
  const obsBy = new Map<string, { route: string; direction: string; byBucket: Map<number, number> }>();
  for (const r of obs) {
    const v = stat === "mean" ? r.mean_s : r.median_s;
    const key = pairKey(r.route, r.direction_norm);
    if (!key || v === null || !Number.isFinite(v)) continue;
    const e = obsBy.get(key) ?? { route: r.route, direction: r.direction_norm, byBucket: new Map() };
    e.byBucket.set(r.bucket_start_min, v);
    obsBy.set(key, e);
  }
  const simBy = new Map<string, { route: string; direction: string; byBucket: Map<number, number> }>();
  for (const r of sim) {
    const key = pairKey(r.route, r.direction_norm);
    if (!key || !Number.isFinite(r.sim_s)) continue;
    const e = simBy.get(key) ?? { route: r.route, direction: r.direction_norm, byBucket: new Map() };
    e.byBucket.set(r.bucket_start_min, r.sim_s);
    simBy.set(key, e);
  }
  const pairs: Pair[] = [];
  const noOverlap: string[] = [];
  for (const [key, o] of obsBy) {
    const s = simBy.get(key);
    if (!s) continue;
    let any = false;
    for (const [bucket, ov] of [...o.byBucket].sort((a, b) => a[0] - b[0])) {
      const sv = s.byBucket.get(bucket);
      if (sv === undefined || !inWin(bucket)) continue;
      pairs.push({ key, route: o.route, direction: o.direction, bucket, obs: ov, sim: sv });
      any = true;
    }
    if (!any) noOverlap.push(label(o.route, o.direction));
  }
  return {
    pairs,
    obsOnly: [...obsBy].filter(([k]) => !simBy.has(k)).map(([, v]) => label(v.route, v.direction)),
    simOnly: [...simBy].filter(([k]) => !obsBy.has(k)).map(([, v]) => label(v.route, v.direction)),
    noOverlap,
  };
}

export interface RouteRow {
  key: string;
  route: string;
  direction: string;
  nBuckets: number;
  /** Mean over the paired buckets. */
  obs: number;
  sim: number;
  delta: number;
  /** sim / obs. */
  ratio: number | null;
}

export function perRoute(pairs: readonly Pair[]): RouteRow[] {
  const by = new Map<string, Pair[]>();
  for (const p of pairs) (by.get(p.key) ?? by.set(p.key, []).get(p.key)!).push(p);
  const out: RouteRow[] = [];
  for (const [key, ps] of by) {
    const obs = ps.reduce((a, p) => a + p.obs, 0) / ps.length;
    const sim = ps.reduce((a, p) => a + p.sim, 0) / ps.length;
    out.push({ key, route: ps[0].route, direction: ps[0].direction, nBuckets: ps.length, obs, sim, delta: sim - obs, ratio: obs > 0 ? sim / obs : null });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route) || a.direction.localeCompare(b.direction));
}

export interface Kpis extends RegressionStats {
  /** % of points with |sim - obs| / obs <= tolerance. */
  pctWithin: number | null;
  tolerancePct: number;
  /** Mean of sim/obs over the points. */
  meanRatio: number | null;
}

/** KPIs over (obs, sim) points. R2 = OLS R2 of sim on obs; r2Identity is about y = x. */
export function kpis(obs: readonly number[], sim: readonly number[], tolerancePct: number): Kpis {
  const base = regressionStats(obs, sim);
  let within = 0;
  let n = 0;
  let ratioSum = 0;
  for (let i = 0; i < Math.min(obs.length, sim.length); i++) {
    if (!Number.isFinite(obs[i]) || !Number.isFinite(sim[i]) || obs[i] <= 0) continue;
    n++;
    ratioSum += sim[i] / obs[i];
    if (Math.abs(sim[i] - obs[i]) / obs[i] <= tolerancePct / 100 + 1e-12) within++;
  }
  return { ...base, pctWithin: n ? (100 * within) / n : null, tolerancePct, meanRatio: n ? ratioSum / n : null };
}

export type Level = "route" | "bucket";

/** Points for the scatter and KPIs: one per route/direction (window mean) or one per route/direction/bucket. */
export function points(pairs: readonly Pair[], level: Level): { obs: number[]; sim: number[]; labels: string[] } {
  if (level === "bucket") return { obs: pairs.map((p) => p.obs), sim: pairs.map((p) => p.sim), labels: pairs.map((p) => `${label(p.route, p.direction)} @${p.bucket}`) };
  const rows = perRoute(pairs);
  return { obs: rows.map((r) => r.obs), sim: rows.map((r) => r.sim), labels: rows.map((r) => label(r.route, r.direction)) };
}
