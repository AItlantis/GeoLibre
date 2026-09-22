export type EmissionsH3Metric = "co2" | "nox" | "noise";
export interface EmissionsH3Ramp { stops: number[]; colors: string[]; unit: string; label: string; }
// First-pass stops; tune against real exported packages once units are verified.
export const EMISSIONS_H3_RAMPS: Record<EmissionsH3Metric, EmissionsH3Ramp> = {
  // The supplied CO₂ map uses a logarithmic-looking sequential scale:
  // pale pink/white for low values, then warm yellow, green, cyan and dark
  // blue for the highest-emission cells.
  co2: {
    stops: [1, 10, 30, 100, 300, 1000, 3000, 10000],
    colors: ["#fff7f3", "#fdd0c5", "#f28e78", "#f4c95d", "#a8c875", "#4fb7a5", "#2d6aa3", "#111c5c"],
    unit: "g",
    label: "CO₂",
  },
  nox: { stops: [0, 1, 10, 100], colors: ["#ecfdf5", "#86efac", "#16a34a", "#14532d"], unit: "g", label: "NOx" },
  // Traffic-noise convention from the referenced noise-map colour code:
  // low levels are bright green (up to about 55 dB), then progress through
  // yellow/orange into darker reds as the level approaches 80 dB and above.
  // https://www.researchgate.net/figure/Noise-level-colour-code_fig1_326146066
  noise: {
    stops: [35, 45, 55, 60, 65, 70, 75, 80],
    colors: ["#00b050", "#92d050", "#ffff00", "#ffc000", "#ff8000", "#ff0000", "#c00000", "#7f0000"],
    unit: "dB LAeq",
    label: "Road source level (LAeq at roadway)",
  },
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
