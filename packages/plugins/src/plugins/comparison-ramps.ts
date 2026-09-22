export type ComparisonMetric = "flow" | "density" | "speed" | "flow_delta" | "density_delta" | "speed_delta" | "delay_delta" | "flow_density_product_delta" | "cmp_flow_sign" | "cmp_flow_density_quadrant";
export interface CategoricalRamp { readonly kind: "categorical"; readonly categories: readonly { key: string; label: string; color: string }[]; readonly unit: string; readonly label: string; }
const FALLBACK: Record<ComparisonMetric, CategoricalRamp | null> = {
  flow: null, density: null, speed: null, flow_delta: null, density_delta: null, speed_delta: null, delay_delta: null, flow_density_product_delta: null,
  cmp_flow_sign: { kind: "categorical", categories: [{key:"negative",label:"Negative",color:"#2166ac"},{key:"zero",label:"Zero",color:"#b0b7c3"},{key:"positive",label:"Positive",color:"#d73027"},{key:"unknown",label:"Unknown",color:"#888888"}], unit:"", label:"Flow sign" },
  cmp_flow_density_quadrant: { kind:"categorical", categories:[{key:"more_flow_more_density",label:"More flow, more density",color:"#facc15"},{key:"more_flow_less_density",label:"More flow, less density",color:"#2563eb"},{key:"less_flow_less_density",label:"Less flow, less density",color:"#22c55e"},{key:"less_flow_more_density",label:"Less flow, more density",color:"#dc2626"},{key:"unknown",label:"Unknown",color:"#888888"}], unit:"", label:"Flow-density quadrant" },
};
export function parseComparisonRamps(raw: unknown): Partial<Record<ComparisonMetric, CategoricalRamp>> {
  const root = ((raw as Record<string, unknown> | null)?.default_ramps ?? raw ?? {}) as Record<string, unknown>;
  const out: Partial<Record<ComparisonMetric, CategoricalRamp>> = {};
  for (const key of Object.keys(FALLBACK) as ComparisonMetric[]) {
    const e = root[key] as Record<string, unknown> | undefined;
    const cats = Array.isArray(e?.categories) ? e.categories : [];
    const parsed = cats.map((c) => c as Record<string, unknown>).filter(c => typeof c.key === "string" && typeof c.color === "string").map(c => ({key:c.key as string,label:typeof c.label === "string" ? c.label as string : c.key as string,color:c.color as string}));
    if (parsed.length) out[key] = { kind:"categorical", categories:parsed, unit:typeof e?.unit === "string" ? e.unit : "", label:typeof e?.label === "string" ? e.label : key };
    else if (FALLBACK[key]) out[key] = FALLBACK[key]!;
  }
  return out;
}
export const comparisonCategoricalRamp = (metric: ComparisonMetric, raw?: unknown) => parseComparisonRamps(raw)[metric] ?? FALLBACK[metric];
