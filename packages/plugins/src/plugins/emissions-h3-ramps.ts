export type EmissionsH3Metric = "co2" | "nox" | "noise";
export interface EmissionsH3Ramp { stops: number[]; colors: string[]; unit: string; label: string; }
// First-pass stops; tune against real exported packages once units are verified.
export const EMISSIONS_H3_RAMPS: Record<EmissionsH3Metric, EmissionsH3Ramp> = {
  co2: { stops: [0, 100, 1000, 10000], colors: ["#eff6ff", "#93c5fd", "#2563eb", "#172554"], unit: "g", label: "CO₂" },
  nox: { stops: [0, 1, 10, 100], colors: ["#ecfdf5", "#86efac", "#16a34a", "#14532d"], unit: "g", label: "NOx" },
  noise: { stops: [35, 55, 75, 98], colors: ["#dbeafe", "#fde68a", "#f97316", "#991b1b"], unit: "dB LAeq", label: "Road source level (LAeq at roadway)" },
};
export const EMISSIONS_H3_METRICS: EmissionsH3Metric[] = ["co2", "nox", "noise"];
// H3 itself supports resolutions 0-15. The practical band for a road network
// is much narrower: below 4 a cell is bigger than most cities (useless for
// per-road aggregation), and above 14 a cell edge is under a couple of
// meters, finer than the ~30m sampling the plugin walks road geometry at.
export const EMISSIONS_H3_RESOLUTION_MIN = 4;
export const EMISSIONS_H3_RESOLUTION_MAX = 14;
export function clampEmissionsH3Resolution(resolution: number): number {
  return Math.max(EMISSIONS_H3_RESOLUTION_MIN, Math.min(EMISSIONS_H3_RESOLUTION_MAX, Math.trunc(resolution)));
}
export function normalizeEmissionsH3Metric(metric: unknown): EmissionsH3Metric { return metric === "co2" || metric === "nox" || metric === "noise" ? metric : "noise"; }
export function emissionsH3Color(value: number | null, metric: EmissionsH3Metric): [number, number, number] | null {
  if (value === null || !Number.isFinite(value)) return null;
  const ramp = EMISSIONS_H3_RAMPS[metric]; const i = ramp.stops.findIndex((s) => value <= s);
  const idx = i < 0 ? ramp.stops.length - 1 : Math.max(1, i); const lo = ramp.stops[idx - 1]; const hi = ramp.stops[idx];
  const t = Math.max(0, Math.min(1, (value - lo) / Math.max(hi - lo, 1e-9)));
  const hex = (a: string) => a.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16));
  const a = hex(ramp.colors[idx - 1]); const b = hex(ramp.colors[idx]); return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * t)) as [number, number, number];
}
