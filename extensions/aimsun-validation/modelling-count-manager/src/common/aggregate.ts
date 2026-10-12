/** Pure aggregation over v_det_validation rows (per detector, KPIs, histogram, worst-N). */
import { geh, gehStatus, regressionStats, type GehStatus } from "../../../_shared/src/metrics.ts";

export interface Criteria {
  gehPass: number;
  gehFail: number;
  targetPct: number;
  flowBandEdges: [number, number, number, number];
  bandPassPct: number;
  bandWarnPct: number;
}
export const DEFAULT_CRITERIA: Criteria = { gehPass: 5, gehFail: 10, targetPct: 85, flowBandEdges: [250, 500, 1000, 2000], bandPassPct: 85, bandWarnPct: 70 };
export function validateCriteria(value: unknown): Criteria {
  if (!value || typeof value !== "object") throw new Error("criteria must be an object");
  const c = value as Partial<Criteria>;
  const nums = [c.gehPass, c.gehFail, c.targetPct, c.bandPassPct, c.bandWarnPct, ...(c.flowBandEdges ?? [])];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("criteria values must be finite numbers");
  if (!(c.gehPass! >= 0 && c.gehPass! <= c.gehFail!)) throw new Error("GEH pass threshold must be non-negative and no greater than fail threshold");
  if (c.targetPct! < 0 || c.targetPct! > 100 || c.bandPassPct! < 0 || c.bandPassPct! > 100 || c.bandWarnPct! < 0 || c.bandWarnPct! > 100 || c.bandWarnPct! > c.bandPassPct!) throw new Error("pass-rate thresholds must be ordered within 0 to 100");
  const edges = c.flowBandEdges!;
  if (edges.length !== 4 || edges.some((n, i) => n < 0 || (i > 0 && n <= edges[i - 1]))) throw new Error("flow-band edges must be four increasing non-negative numbers");
  return { gehPass: c.gehPass!, gehFail: c.gehFail!, targetPct: c.targetPct!, bandPassPct: c.bandPassPct!, bandWarnPct: c.bandWarnPct!, flowBandEdges: [...edges] as Criteria["flowBandEdges"] };
}

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
export function aggregateDetectors(rows: readonly ValRow[], criteria: Criteria = DEFAULT_CRITERIA): DetAgg[] {
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
    return { id, oid: a.oid, buckets: a.n, sim, obs, diff: sim - obs, relErr: obs !== 0 ? (sim - obs) / obs : null, geh: g, status: gehStatus(g, criteria.gehPass, criteria.gehFail) };
  });
}

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
export function computeKpis(rows: readonly ValRow[], criteria: Criteria = DEFAULT_CRITERIA): Kpis {
  const s = regressionStats(rows.map((r) => Number(r.obs_flow_h)), rows.map((r) => Number(r.sim_flow_h)));
  let nPass = 0;
  let nWarn = 0;
  let nFail = 0;
  for (const r of rows) {
    const st = gehStatus(geh(Number(r.sim_flow_h), Number(r.obs_flow_h)), criteria.gehPass, criteria.gehFail);
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
    pctGehLt5: s.count ? (nPass / s.count) * 100 : null,
    targetPct: criteria.targetPct,
    meetsTarget: s.pctGehLt5 === null ? null : s.pctGehLt5 >= criteria.targetPct,
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
export function gehBins(values: readonly number[], width = 1, cap = 10, thresholds: readonly number[] = []): GehBin[] {
  const max = Math.max(width, Math.ceil(cap / width) * width);
  const edges = new Set<number>();
  for (let x = 0; x <= max; x += width) edges.add(x);
  for (const x of thresholds) if (Number.isFinite(x) && x > 0 && x < max) edges.add(x);
  const sorted = [...edges].sort((a, b) => a - b);
  sorted.push(max + width);
  const bins: GehBin[] = sorted.slice(0, -1).map((start, i) => ({ start, end: sorted[i + 1], value: 0 }));
  for (const g of values) {
    if (!Number.isFinite(g)) continue;
    const i = g >= max ? bins.length - 1 : Math.max(0, bins.findIndex((bin) => g >= bin.start && g < bin.end));
    bins[i].value += 1;
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

export interface FlowBandStats { label: string; n: number; passPct: number | null; meanBias: number | null }

/** Count validation rows by observed flow band and compute pass rate and sim-observed bias. */
export function flowBandStats(rows: readonly ValRow[], criteria: Criteria = DEFAULT_CRITERIA): FlowBandStats[] {
  const edges = [0, ...criteria.flowBandEdges, Number.POSITIVE_INFINITY];
  const bands = edges.slice(0, -1).map((min, i) => ({ min, max: edges[i + 1], label: i === 0 ? `<${edges[i + 1]}` : i === edges.length - 2 ? `>=${min}` : `${min}-${edges[i + 1]}` }));
  return bands.map((band) => {
    const group = rows.filter((r) => r.obs_flow_h >= band.min && r.obs_flow_h < band.max);
    const nPass = group.filter((r) => gehStatus(geh(r.sim_flow_h, r.obs_flow_h), criteria.gehPass, criteria.gehFail) === "pass").length;
    return { label: band.label, n: group.length, passPct: group.length ? nPass / group.length * 100 : null,
      meanBias: group.length ? group.reduce((sum, r) => sum + r.sim_flow_h - r.obs_flow_h, 0) / group.length : null };
  });
}

export interface ComplianceShares { pass: number; warn: number; fail: number; n: number; passPct: number | null }
/** Compliance share of rows, with pass meaning GEH < 5. */
export function complianceShares(rows: readonly ValRow[], criteria: Criteria = DEFAULT_CRITERIA): ComplianceShares {
  let pass = 0, warn = 0, fail = 0;
  for (const r of rows) { const status = gehStatus(geh(r.sim_flow_h, r.obs_flow_h), criteria.gehPass, criteria.gehFail); if (status === "pass") pass++; else if (status === "warn") warn++; else fail++; }
  const n = pass + warn + fail;
  return { pass, warn, fail, n, passPct: n ? pass / n * 100 : null };
}

