/** Pure aggregation over v_det_validation rows (per detector, KPIs, histogram, worst-N). */
import { geh, gehStatus, regressionStats, type GehStatus } from "../../../_shared/src/metrics.ts";

export interface ValRow {
  detector_id: string;
  oid: number | string | null;
  bucket_start_min: number;
  sim_flow_h: number;
  obs_flow_h: number;
  geh: number;
  status: GehStatus;
}

export interface DetAgg {
  id: string;
  oid: string | null;
  buckets: number;
  sim: number;
  obs: number;
  diff: number;
  relErr: number | null;
  geh: number;
  status: GehStatus;
}

/** Mean hourly flows over the buckets in the window; GEH/status recomputed on those means. */
export function aggregateDetectors(rows: readonly ValRow[]): DetAgg[] {
  const m = new Map<string, { oid: string | null; n: number; s: number; o: number }>();
  for (const r of rows) {
    const id = String(r.detector_id);
    const a = m.get(id) ?? { oid: r.oid === null || r.oid === undefined ? null : String(r.oid), n: 0, s: 0, o: 0 };
    a.n += 1;
    a.s += Number(r.sim_flow_h);
    a.o += Number(r.obs_flow_h);
    m.set(id, a);
  }
  return [...m.entries()].map(([id, a]) => {
    const sim = a.s / a.n;
    const obs = a.o / a.n;
    const g = geh(sim, obs);
    return { id, oid: a.oid, buckets: a.n, sim, obs, diff: sim - obs, relErr: obs !== 0 ? (sim - obs) / obs : null, geh: g, status: gehStatus(g) };
  });
}

export const GEH_TARGET_PCT = 85;

export interface Kpis {
  n: number;
  rmse: number | null;
  mae: number | null;
  bias: number | null;
  r2: number | null;
  slope: number | null;
  intercept: number | null;
  pctGehLt5: number | null;
  targetPct: number;
  meetsTarget: boolean | null;
  nPass: number;
  nWarn: number;
  nFail: number;
}

/** Pooled over every (detector x bucket) row, like v_det_summary. obs = x, sim = y. */
export function computeKpis(rows: readonly ValRow[], targetPct = GEH_TARGET_PCT): Kpis {
  const s = regressionStats(rows.map((r) => Number(r.obs_flow_h)), rows.map((r) => Number(r.sim_flow_h)));
  let nPass = 0;
  let nWarn = 0;
  let nFail = 0;
  for (const r of rows) {
    const st = gehStatus(geh(Number(r.sim_flow_h), Number(r.obs_flow_h)));
    if (st === "pass") nPass++;
    else if (st === "warn") nWarn++;
    else nFail++;
  }
  return {
    n: s.count,
    rmse: s.rmse,
    mae: s.mae,
    bias: s.bias,
    r2: s.r2,
    slope: s.slope,
    intercept: s.intercept,
    pctGehLt5: s.pctGehLt5,
    targetPct,
    meetsTarget: s.pctGehLt5 === null ? null : s.pctGehLt5 >= targetPct,
    nPass,
    nWarn,
    nFail,
  };
}

export interface GehBin {
  start: number;
  end: number;
  value: number;
}

/** GEH histogram: `width`-wide bins from 0 up to `cap`; values >= cap fall in the last bin. */
export function gehBins(values: readonly number[], width = 1, cap = 10): GehBin[] {
  const k = Math.max(1, Math.round(cap / width));
  const bins: GehBin[] = Array.from({ length: k + 1 }, (_, i) => ({ start: i * width, end: (i + 1) * width, value: 0 }));
  for (const g of values) {
    if (!Number.isFinite(g)) continue;
    bins[Math.min(k, Math.max(0, Math.floor(g / width)))].value += 1;
  }
  return bins;
}

export type SortKey = "id" | "sim" | "obs" | "diff" | "relErr" | "geh";
export type SortDir = "asc" | "desc";

export function sortAggs(aggs: readonly DetAgg[], key: SortKey, dir: SortDir): DetAgg[] {
  const f = dir === "asc" ? 1 : -1;
  const val = (a: DetAgg): number | string | null => (key === "id" ? a.id : a[key]);
  return [...aggs].sort((x, y) => {
    const a = val(x);
    const b = val(y);
    if (a === null && b === null) return 0;
    if (a === null) return 1; // nulls last in both directions
    if (b === null) return -1;
    if (typeof a === "string" || typeof b === "string") return f * String(a).localeCompare(String(b), undefined, { numeric: true });
    return f * (a - b) || String(x.id).localeCompare(String(y.id), undefined, { numeric: true });
  });
}

/** The n detectors with the highest GEH (ties: larger absolute difference first). */
export function worstN(aggs: readonly DetAgg[], n: number): DetAgg[] {
  return [...aggs].sort((a, b) => b.geh - a.geh || Math.abs(b.diff) - Math.abs(a.diff)).slice(0, Math.max(0, n));
}
