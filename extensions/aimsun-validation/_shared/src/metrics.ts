/**
 * Pure TS twins of the validation statistics (GEH, RMSE, MAE, bias, OLS, R2).
 * Used for unit tests and client-side recompute; mirror v_det_validation/v_det_summary and
 * linear_regression_stats() in validation_analytics.py.
 */

/** GEH of simulated m vs observed c hourly flows. m + c <= 0 gives 0. */
export function geh(m: number, c: number): number {
  const s = m + c;
  if (!(s > 0)) return 0;
  return Math.sqrt((2 * (m - c) ** 2) / s);
}

export type GehStatus = "pass" | "warn" | "fail";

export function gehStatus(g: number, pass = 5, warn = 10): GehStatus {
  return g < pass ? "pass" : g <= warn ? "warn" : "fail";
}

/** (m - c) / c, or null when c = 0. */
export function relativeError(m: number, c: number): number | null {
  return c !== 0 ? (m - c) / c : null;
}

export type FlowKind = "rate" | "count";

/**
 * Hourly flow (veh/h) of ONE interval. kind 'rate' (default): `flow` already is veh/h and is
 * returned unchanged. kind 'count': `flow` vehicles over `durMin` minutes -> flow * 60 / durMin.
 */
export function hourlyFlow(flow: number, durMin: number, kind: FlowKind = "rate"): number {
  return kind === "rate" ? flow : (flow * 60) / durMin;
}

/**
 * Hourly flow (veh/h) of a bucket made of several intervals: duration-weighted mean for
 * rates, SUM(count) * 60 / SUM(dur) for counts. Mirrors the SQL in views.sql.ts.
 */
export function hourlyFlowOver(intervals: ReadonlyArray<{ flow: number; durMin: number }>, kind: FlowKind = "rate"): number {
  let f = 0;
  let d = 0;
  for (const i of intervals) {
    f += kind === "rate" ? i.flow * i.durMin : i.flow;
    d += i.durMin;
  }
  return kind === "rate" ? f / d : (f * 60) / d;
}

export interface RegressionStats {
  count: number;
  bias: number | null;
  mae: number | null;
  rmse: number | null;
  r2: number | null;
  slope: number | null;
  intercept: number | null;
  /** 1 - SSres/SStot about y = x, SStot around the observed mean. */
  r2Identity: number | null;
  pctGehLt5: number | null;
}

/** obs = x, sim = y. Pairs with non-finite values are dropped. */
export function regressionStats(obs: readonly number[], sim: readonly number[]): RegressionStats {
  const x: number[] = [];
  const y: number[] = [];
  const n0 = Math.min(obs.length, sim.length);
  for (let i = 0; i < n0; i++) {
    if (Number.isFinite(obs[i]) && Number.isFinite(sim[i])) {
      x.push(obs[i]);
      y.push(sim[i]);
    }
  }
  const n = x.length;
  if (n === 0) {
    return { count: 0, bias: null, mae: null, rmse: null, r2: null, slope: null, intercept: null, r2Identity: null, pctGehLt5: null };
  }
  const err = y.map((v, i) => v - x[i]);
  const sse = err.reduce((a, b) => a + b * b, 0);
  const bias = err.reduce((a, b) => a + b, 0) / n;
  const mae = err.reduce((a, b) => a + Math.abs(b), 0) / n;
  const rmse = Math.sqrt(sse / n);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
  const sxy = x.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0);
  const syy = y.reduce((a, v) => a + (v - my) ** 2, 0);
  const slope = sxx ? sxy / sxx : null;
  const intercept = slope !== null ? my - slope * mx : null;
  let r2: number | null = null;
  if (slope !== null && intercept !== null) {
    const resid = x.reduce((a, v, i) => a + (y[i] - (slope * v + intercept)) ** 2, 0);
    r2 = syy ? 1 - resid / syy : resid === 0 ? 1 : null;
  }
  const r2Identity = sxx ? 1 - sse / sxx : null;
  const pctGehLt5 = (100 * x.filter((v, i) => geh(y[i], v) < 5).length) / n;
  return { count: n, bias, mae, rmse, r2, slope, intercept, r2Identity, pctGehLt5 };
}

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

/** Fixed-width histogram; optional weights (e.g. trips). */
export function histogram(values: readonly number[], binWidth: number, weights?: readonly number[]): HistogramBin[] {
  if (!(binWidth > 0)) throw new Error("binWidth must be > 0");
  const bins = new Map<number, number>();
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const k = Math.floor(v / binWidth);
    bins.set(k, (bins.get(k) ?? 0) + (weights ? weights[i] : 1));
  });
  return [...bins.keys()]
    .sort((a, b) => a - b)
    .map((k) => ({ start: k * binWidth, end: (k + 1) * binWidth, count: bins.get(k)! }));
}

/** Haversine distance (km) on a sphere of mean radius 6371.0088 km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number, R = 6371.0088): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Deviation ratio with the same zero-denominator rule as v_od_diff. */
export function deviationRatio(before: number, after: number): number | null {
  if (before !== 0) return (after - before) / before;
  return after === 0 ? 0 : null;
}
