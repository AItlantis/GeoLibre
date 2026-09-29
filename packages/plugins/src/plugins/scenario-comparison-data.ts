export interface ComparisonInput { key: string | number; flow: number | null; density: number | null; speed?: number | null; delay?: number | null; }
export type ComparisonFlowSign = "negative" | "zero" | "positive" | "unknown";
export type ComparisonFlowDensityQuadrant = "more_flow_more_density" | "more_flow_less_density" | "less_flow_less_density" | "less_flow_more_density" | "unknown";
export interface ComparisonRow extends ComparisonInput {
  hasReference: boolean;
  hasCompared: boolean;
  flow_delta: number | null;
  density_delta: number | null;
  speed_delta: number | null;
  delay_delta: number | null;
  flow_pct_delta: number | null;
  density_pct_delta: number | null;
  cmp_flow_sign: ComparisonFlowSign;
  cmp_flow_density_quadrant: ComparisonFlowDensityQuadrant;
}

export function defaultScenarioComparisonPair(
  scenarioIndices: readonly number[],
  currentA: number,
  currentB: number,
  didA: number | null,
  didB: number | null,
): { scenarioA: number; scenarioB: number } | null {
  if (scenarioIndices.length < 2 || currentA !== currentB || didA != null || didB != null) return null;
  return { scenarioA: scenarioIndices[0], scenarioB: scenarioIndices[1] };
}

function delta(left: number | null | undefined, right: number | null | undefined): number | null {
  return left == null || right == null ? null : left - right;
}

/** Percentage follows the existing A-minus-B delta convention and uses B as its denominator. */
function percentageDelta(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null || right == null || right === 0) return null;
  return ((left - right) / Math.abs(right)) * 100;
}

export function buildScenarioComparisonRows(a: readonly ComparisonInput[], b: readonly ComparisonInput[]): ComparisonRow[] {
  const right = new Map(b.map(row => [String(row.key), row]));
  const left = new Map(a.map(row => [String(row.key), row]));
  const keys = [...new Set([...a, ...b].map(row => String(row.key)))];
  const out: ComparisonRow[] = [];
  for (const key of keys) {
    const first = left.get(key);
    const other = right.get(key);
    // Scenario A is the reference and scenario B is the compared case.
    // All deltas intentionally use Compared - Reference (B - A).
    const fd = delta(other?.flow, first?.flow);
    const dd = delta(other?.density, first?.density);
    out.push({
      key: first?.key ?? other!.key,
      hasReference: first !== undefined,
      hasCompared: other !== undefined,
      flow: first?.flow ?? null,
      density: first?.density ?? null,
      speed: first?.speed ?? null,
      flow_delta: fd,
      density_delta: dd,
      speed_delta: delta(other?.speed, first?.speed),
      delay_delta: delta(other?.delay, first?.delay),
      flow_pct_delta: percentageDelta(other?.flow, first?.flow),
      density_pct_delta: percentageDelta(other?.density, first?.density),
      cmp_flow_sign: fd == null ? "unknown" : fd > 0 ? "positive" : fd < 0 ? "negative" : "zero",
      cmp_flow_density_quadrant: fd == null || dd == null
        ? "unknown"
        : fd >= 0 ? (dd >= 0 ? "more_flow_more_density" : "more_flow_less_density")
          : (dd < 0 ? "less_flow_less_density" : "less_flow_more_density"),
    });
  }
  return out;
}
