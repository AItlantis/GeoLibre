import { KPI_RAMPS, type NetworkKpiMetric } from "./network-kpi-ramps";

export type ComparisonDifferenceMetric = "flow_delta" | "density_delta" | "speed_delta" | "delay_delta";
export type ComparisonMetric = NetworkKpiMetric | ComparisonDifferenceMetric | "cmp_flow_sign" | "cmp_flow_density_quadrant";

export interface CategoricalRamp {
  readonly kind: "categorical";
  readonly categories: readonly { key: string; label: string; color: string }[];
  readonly unit: string;
  readonly label: string;
}

export interface ContinuousComparisonRamp {
  readonly kind: "continuous";
  readonly label: string;
  readonly unit: string;
  readonly domainMax: number;
  readonly thresholdDefault: number;
  readonly thresholdOptions: readonly number[];
  readonly colors: readonly [string, string, string, string, string];
}

const DIVERGING_COLORS = ["#2166ac", "#67a9cf", "#f7f7f7", "#ef8a62", "#b2182b"] as const;

export const COMPARISON_CONTINUOUS_RAMPS: Readonly<Record<ComparisonDifferenceMetric, ContinuousComparisonRamp>> = {
  flow_delta: { kind: "continuous", label: "Flow difference", unit: "veh/h", domainMax: 1000, thresholdDefault: 50, thresholdOptions: [0, 25, 50, 100, 250], colors: DIVERGING_COLORS },
  density_delta: { kind: "continuous", label: "Density difference", unit: "veh/km", domainMax: 75, thresholdDefault: 5, thresholdOptions: [0, 1, 5, 10, 25], colors: DIVERGING_COLORS },
  speed_delta: { kind: "continuous", label: "Speed difference", unit: "km/h", domainMax: 60, thresholdDefault: 5, thresholdOptions: [0, 1, 5, 10, 20], colors: DIVERGING_COLORS },
  delay_delta: { kind: "continuous", label: "Delay difference", unit: "s", domainMax: 120, thresholdDefault: 5, thresholdOptions: [0, 1, 5, 10, 30], colors: DIVERGING_COLORS },
};

const FALLBACK_CATEGORICAL: Readonly<Partial<Record<ComparisonMetric, CategoricalRamp>>> = {
  cmp_flow_sign: { kind: "categorical", categories: [{ key: "negative", label: "Negative", color: "#2166ac" }, { key: "zero", label: "Zero", color: "#b0b7c3" }, { key: "positive", label: "Positive", color: "#d73027" }, { key: "unknown", label: "Unknown", color: "#888888" }], unit: "", label: "Flow sign" },
  cmp_flow_density_quadrant: { kind: "categorical", categories: [{ key: "more_flow_more_density", label: "More flow, more density", color: "#facc15" }, { key: "more_flow_less_density", label: "More flow, less density", color: "#2563eb" }, { key: "less_flow_less_density", label: "Less flow, less density", color: "#22c55e" }, { key: "less_flow_more_density", label: "Less flow, more density", color: "#dc2626" }, { key: "unknown", label: "Unknown", color: "#888888" }], unit: "", label: "Flow-density quadrant" },
};

export function parseComparisonRamps(raw: unknown): Partial<Record<ComparisonMetric, CategoricalRamp>> {
  const root = ((raw as Record<string, unknown> | null)?.default_ramps ?? raw ?? {}) as Record<string, unknown>;
  const out: Partial<Record<ComparisonMetric, CategoricalRamp>> = {};
  for (const metric of Object.keys(FALLBACK_CATEGORICAL) as ComparisonMetric[]) {
    const parsed = comparisonCategoricalRamp(metric, root);
    if (parsed) out[metric] = parsed;
  }
  return out;
}

export function isComparisonDifferenceMetric(metric: ComparisonMetric): metric is ComparisonDifferenceMetric {
  return Object.hasOwn(COMPARISON_CONTINUOUS_RAMPS, metric);
}

export function comparisonThresholdOptions(metric: ComparisonMetric): readonly number[] {
  return isComparisonDifferenceMetric(metric) ? COMPARISON_CONTINUOUS_RAMPS[metric].thresholdOptions : [];
}

export function comparisonThresholdDefault(metric: ComparisonMetric): number {
  return isComparisonDifferenceMetric(metric) ? COMPARISON_CONTINUOUS_RAMPS[metric].thresholdDefault : 0;
}

export function comparisonCategoricalRamp(metric: ComparisonMetric, raw?: unknown): CategoricalRamp | undefined {
  const fallback = FALLBACK_CATEGORICAL[metric];
  const root = ((raw as Record<string, unknown> | null)?.default_ramps ?? raw ?? {}) as Record<string, unknown>;
  const entry = root[metric] as Record<string, unknown> | undefined;
  const categories = Array.isArray(entry?.categories)
    ? entry.categories.map((category) => category as Record<string, unknown>)
      .filter((category) => typeof category.key === "string" && typeof category.color === "string")
      .map((category) => ({
        key: category.key as string,
        label: typeof category.label === "string" ? category.label : category.key as string,
        color: category.color as string,
      }))
    : [];
  if (!categories.length) return fallback;
  return {
    kind: "categorical",
    categories,
    unit: typeof entry?.unit === "string" ? entry.unit : fallback?.unit ?? "",
    label: typeof entry?.label === "string" ? entry.label : fallback?.label ?? metric,
  };
}

function parseHexColor(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

export function comparisonDifferenceColor(metric: ComparisonDifferenceMetric, value: number, flowScale = COMPARISON_CONTINUOUS_RAMPS.flow_delta.domainMax): [number, number, number] {
  const ramp = COMPARISON_CONTINUOUS_RAMPS[metric];
  const max = metric === "flow_delta" ? Math.max(10, Math.min(2000, flowScale)) : ramp.domainMax;
  const stops = [-max, -max / 2, 0, max / 2, max];
  if (!Number.isFinite(value) || value <= stops[0]) return parseHexColor(ramp.colors[0]);
  if (value >= stops[4]) return parseHexColor(ramp.colors[4]);
  for (let index = 1; index < stops.length; index += 1) {
    if (value > stops[index]) continue;
    const t = (value - stops[index - 1]) / (stops[index] - stops[index - 1]);
    const a = parseHexColor(ramp.colors[index - 1]);
    const b = parseHexColor(ramp.colors[index]);
    return a.map((channel, i) => Math.round(channel + (b[i] - channel) * t)) as [number, number, number];
  }
  return parseHexColor(ramp.colors[4]);
}

export function comparisonDifferenceLegend(metric: ComparisonDifferenceMetric, flowScale = COMPARISON_CONTINUOUS_RAMPS.flow_delta.domainMax) {
  const ramp = COMPARISON_CONTINUOUS_RAMPS[metric];
  const max = metric === "flow_delta" ? Math.max(10, Math.min(2000, flowScale)) : ramp.domainMax;
  return {
    label: ramp.label,
    unit: ramp.unit,
    colors: ramp.colors,
    stops: [-max, -max / 2, 0, max / 2, max],
    domainMax: max,
  } as const;
}

export function sideBySideLegend(metric: NetworkKpiMetric) {
  return KPI_RAMPS[metric];
}

export function isComparisonMetric(value: unknown): value is ComparisonMetric {
  return typeof value === "string" && [
    "flow", "density", "speed", "delay", "flow_delta", "density_delta", "speed_delta", "delay_delta",
    "cmp_flow_sign", "cmp_flow_density_quadrant",
  ].includes(value);
}
