export interface ComparisonInput {
  key: string | number;
  flow: number | null;
  density: number | null;
  speed?: number | null;
  delay?: number | null;
}

export type ComparisonFlowSign = "negative" | "zero" | "positive" | "unknown";
export type ComparisonFlowDensityQuadrant =
  | "more_flow_more_density"
  | "more_flow_less_density"
  | "less_flow_less_density"
  | "less_flow_more_density"
  | "unknown";

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

function delta(compared: number | null | undefined, reference: number | null | undefined): number | null {
  return compared == null || reference == null ? null : compared - reference;
}

/** Percentage deltas follow compared-minus-reference and use the reference magnitude as denominator. */
function percentageDelta(compared: number | null | undefined, reference: number | null | undefined): number | null {
  if (compared == null || reference == null || reference === 0) return null;
  return ((compared - reference) / Math.abs(reference)) * 100;
}

/** Aligns rows by normalized section ID; side A is the reference and B is compared. */
export function buildScenarioComparisonRows(
  reference: readonly ComparisonInput[],
  compared: readonly ComparisonInput[],
): ComparisonRow[] {
  const referenceByKey = new Map(reference.map((row) => [String(row.key), row]));
  const comparedByKey = new Map(compared.map((row) => [String(row.key), row]));
  const keys = [...new Set([...reference, ...compared].map((row) => String(row.key)))];

  return keys.map((key) => {
    const a = referenceByKey.get(key);
    const b = comparedByKey.get(key);
    const flowDelta = delta(b?.flow, a?.flow);
    const densityDelta = delta(b?.density, a?.density);
    return {
      key: a?.key ?? b!.key,
      flow: a?.flow ?? null,
      density: a?.density ?? null,
      speed: a?.speed ?? null,
      hasReference: a !== undefined,
      hasCompared: b !== undefined,
      flow_delta: flowDelta,
      density_delta: densityDelta,
      speed_delta: delta(b?.speed, a?.speed),
      delay_delta: delta(b?.delay, a?.delay),
      flow_pct_delta: percentageDelta(b?.flow, a?.flow),
      density_pct_delta: percentageDelta(b?.density, a?.density),
      cmp_flow_sign: flowDelta == null ? "unknown" : flowDelta > 0 ? "positive" : flowDelta < 0 ? "negative" : "zero",
      cmp_flow_density_quadrant: flowDelta == null || densityDelta == null
        ? "unknown"
        : flowDelta >= 0
          ? (densityDelta >= 0 ? "more_flow_more_density" : "more_flow_less_density")
          : (densityDelta < 0 ? "less_flow_less_density" : "less_flow_more_density"),
    };
  });
}
