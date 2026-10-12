/** Pure, bounded analytics used by the additional OD views and their tests. */
export interface FlowCell { origin: string; destination: string; trips: number }
export interface Bin { start: number; end: number; trips: number }
export interface DistributionStats { total: number; mean: number | null; median: number | null; p90: number | null; under5Share: number | null }

/** Deterministic Jenks-Fisher breaks. Inputs are reduced to an evenly sampled sorted set. */
export function jenksBreaks(values: readonly number[], classes = 5, sampleSize = 2000): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length || classes < 2) return [];
  const sample = sorted.length <= sampleSize ? sorted : Array.from({ length: sampleSize }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (sampleSize - 1))]);
  const distinct = [...new Set(sample)];
  const k = Math.min(Math.max(1, Math.floor(classes)), distinct.length);
  if (k <= 1) return [];
  const n = sample.length, lower: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
  const variance: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(Infinity));
  for (let c = 1; c <= k; c++) { lower[0][c] = 1; variance[0][c] = 0; }
  for (let end = 1; end <= n; end++) {
    let sum = 0, sumSq = 0;
    for (let size = 1; size <= end; size++) {
      const value = sample[end - size]; sum += value; sumSq += value * value;
      const v = sumSq - sum * sum / size, start = end - size;
      if (start === 0) { lower[end][1] = 1; variance[end][1] = v; }
      else for (let c = 2; c <= k; c++) if (variance[start][c - 1] + v < variance[end][c]) { lower[end][c] = start + 1; variance[end][c] = variance[start][c - 1] + v; }
    }
  }
  const cuts: number[] = []; let at = n, c = k;
  while (c > 1) { const start = lower[at][c]; if (!start) break; cuts.push(sample[start - 1]); at = start - 1; c--; }
  return cuts.reverse();
}

export function volumeOpacity(value: number, min: number, max: number, minOpacity = 0.2, maxOpacity = 0.9): number {
  const lo = Math.max(0, Math.min(1, minOpacity)), hi = Math.max(lo, Math.min(1, maxOpacity));
  if (!Number.isFinite(value) || !(max > min)) return lo;
  return lo + (hi - lo) * Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export interface BalanceRow { id: string; productions: number; attractions: number; net: number; ratio: number | null }
export function balanceRows(rows: readonly { id: string; productions: number; attractions: number }[]): BalanceRow[] {
  return rows.map((r) => ({ ...r, net: r.productions - r.attractions, ratio: r.attractions > 0 ? r.productions / r.attractions : r.productions === 0 ? 1 : null }));
}

export function distributionStats(bins: readonly Bin[]): DistributionStats {
  const valid = bins.filter((b) => Number.isFinite(b.trips) && b.trips > 0 && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end >= b.start).sort((a, b) => a.start - b.start);
  const total = valid.reduce((s, b) => s + b.trips, 0);
  if (!total) return { total: 0, mean: null, median: null, p90: null, under5Share: null };
  const mean = valid.reduce((s, b) => s + (b.start + b.end) / 2 * b.trips, 0) / total;
  const quantile = (q: number): number => { let cumulative = 0; for (const b of valid) { cumulative += b.trips; if (cumulative >= total * q) return b.start + (b.end - b.start) * Math.max(0, Math.min(1, (total * q - (cumulative - b.trips)) / b.trips)); } return valid.at(-1)!.end; };
  const under = valid.reduce((s, b) => s + b.trips * Math.max(0, Math.min(1, (5 - b.start) / (b.end - b.start || 1))), 0);
  return { total, mean, median: quantile(.5), p90: quantile(.9), under5Share: under / total };
}

export function cumulativeBins(bins: readonly Bin[]): Bin[] {
  const total = bins.reduce((s, b) => s + Math.max(0, b.trips), 0); let sum = 0;
  return bins.map((b) => { sum += Math.max(0, b.trips); return { ...b, trips: total ? sum / total : 0 }; });
}

export interface MatrixValue extends FlowCell { before: number; after: number; delta: number; deltaPct: number | null }
export function flowMatrix(rows: readonly { origin: string; destination: string; before: number; after: number }[], limit = 30): { rows: MatrixValue[]; groups: string[] } {
  const totals = new Map<string, number>();
  for (const r of rows) { totals.set(r.origin, (totals.get(r.origin) ?? 0) + Math.max(r.before, r.after)); totals.set(r.destination, (totals.get(r.destination) ?? 0) + Math.max(r.before, r.after)); }
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chosen = new Set(ranked.slice(0, Math.max(1, limit)).map(([g]) => g));
  const acc = new Map<string, MatrixValue>();
  for (const r of rows) { const origin = chosen.has(r.origin) ? r.origin : "Other", destination = chosen.has(r.destination) ? r.destination : "Other", key = `${origin}\0${destination}`; const x = acc.get(key) ?? { origin, destination, trips: 0, before: 0, after: 0, delta: 0, deltaPct: null }; x.before += r.before; x.after += r.after; x.trips = x.after; x.delta = x.after - x.before; acc.set(key, x); }
  for (const x of acc.values()) x.deltaPct = x.before ? x.delta / x.before : x.after ? null : 0;
  return { rows: [...acc.values()], groups: [...ranked.slice(0, Math.max(1, limit)).map(([g]) => g), ...(ranked.length > limit ? ["Other"] : [])] };
}

export interface Check { name: string; pass: boolean; detail: string }
export function conservationChecks(input: { before: number; after: number; rowSum: number; columnSum: number; grand: number; rowSumBefore?: number; columnSumBefore?: number; grandBefore?: number; grouped: number; groupedBefore?: number; ungroupedTrips?: number; newFlows: number; droppedFlows: number; unknownTrips: number; invalidValues: number; tolerance?: number; tolerancePct?: number }): Check[] {
  const t = Math.max(0, input.tolerance ?? .5), pct=Math.max(0,input.tolerancePct??.0001), eq = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && (Math.abs(a - b) <= t || (Math.max(Math.abs(a),Math.abs(b))>0&&Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b))<=pct));
  return [
    { name: "before-after", pass: Number.isFinite(input.before) && Number.isFinite(input.after), detail: `${input.before} / ${input.after} (${input.before ? ((input.after - input.before) / input.before * 100).toFixed(2) : "n/a"}%)` },
    { name: "matrix-sums", pass: eq(input.rowSum, input.grand) && eq(input.columnSum, input.grand) && eq(input.rowSumBefore??input.before,input.grandBefore??input.before) && eq(input.columnSumBefore??input.before,input.grandBefore??input.before), detail: `before ${input.rowSumBefore??input.before} / ${input.columnSumBefore??input.before} / ${input.grandBefore??input.before}; after ${input.rowSum} / ${input.columnSum} / ${input.grand}` },
    { name: "group-total", pass: eq(input.grouped, input.grand) && eq(input.groupedBefore??input.before,input.grandBefore??input.before), detail: `before ${input.groupedBefore??input.before} / ${input.grandBefore??input.before}; after ${input.grouped} / ${input.grand}; ungrouped ${input.ungroupedTrips??0}` },
    { name: "new-dropped", pass: input.newFlows >= 0 && input.droppedFlows >= 0, detail: `${input.newFlows} new; ${input.droppedFlows} dropped` },
    { name: "unknown-zones", pass: input.unknownTrips === 0, detail: `${input.unknownTrips} trips on unknown ids` },
    { name: "invalid-values", pass: input.invalidValues === 0, detail: `${input.invalidValues} negative or non-finite values` },
  ];
}

export function joinComparisons<T extends { run: string }>(runs: readonly T[], baseline: string): Array<T & { baseline: boolean }> {
  return runs.map((r) => ({ ...r, baseline: r.run === baseline }));
}
