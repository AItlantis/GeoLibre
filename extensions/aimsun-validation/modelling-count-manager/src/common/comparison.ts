import { computeKpis, DEFAULT_CRITERIA, type Criteria, type Kpis } from "./aggregate.ts";
import type { ValRow } from "./aggregate.ts";
import type { GeoIndex } from "./geo.ts";

export interface ComparisonDetector { id: string; geh: number; oid?: string | null }
export interface ComparisonRun {
  run: string;
  rows: Array<Pick<ValRow, "obs_flow_h" | "sim_flow_h" | "geh">>;
  detectors: ComparisonDetector[];
  geo: GeoIndex | null;
  startMin: number;
  endMin: number;
}
export interface ComparisonJoinRow { id: string; gehA: number | null; gehB: number | null; change: number | null; status: "improved" | "unchanged" | "degraded" | "only-a" | "only-b" }
export interface ComparisonJoin { rows: ComparisonJoinRow[]; both: number; onlyA: number; onlyB: number; improved: number; unchanged: number; degraded: number }

export function joinComparison(a: readonly ComparisonDetector[], b: readonly ComparisonDetector[]): ComparisonJoin {
  const am = new Map(a.map((d) => [d.id, d.geh]));
  const bm = new Map(b.map((d) => [d.id, d.geh]));
  const rows = [...new Set([...am.keys(), ...bm.keys()])].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).map((id): ComparisonJoinRow => {
    const gehA = am.get(id) ?? null, gehB = bm.get(id) ?? null;
    if (gehA === null) return { id, gehA, gehB, change: null, status: "only-b" };
    if (gehB === null) return { id, gehA, gehB, change: null, status: "only-a" };
    const change = gehA - gehB;
    return { id, gehA, gehB, change, status: change > 1e-9 ? "improved" : change < -1e-9 ? "degraded" : "unchanged" };
  });
  return { rows, both: rows.filter((r) => r.gehA !== null && r.gehB !== null).length,
    onlyA: rows.filter((r) => r.status === "only-a").length, onlyB: rows.filter((r) => r.status === "only-b").length,
    improved: rows.filter((r) => r.status === "improved").length, unchanged: rows.filter((r) => r.status === "unchanged").length, degraded: rows.filter((r) => r.status === "degraded").length };
}

export function comparisonKpis(run: ComparisonRun, criteria: Criteria = DEFAULT_CRITERIA): Kpis {
  return computeKpis(run.rows.map((r, i) => ({ detector_id: String(i), oid: null, bucket_start_min: 0, ...r, status: "pass" })), criteria);
}
