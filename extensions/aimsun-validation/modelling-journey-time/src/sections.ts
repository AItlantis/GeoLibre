/**
 * C12: per-section delay along a subpath (micro runs). Pure functions (no DOM, no DuckDB).
 *   subpath_sections.geojson  LineString per (subpath_oid, seq): section_id, length_m, name, geometry_method
 *   section_sim_tt            subpath_oid, seq, section_id, run, interval_start_s, duration_s, ttime_s, dtime_s, speed_kmh, flow
 * Both are optional; without them the plugin keeps drawing the single-colour route line.
 */
import type { GeoJSONFC, GeoJSONFeature } from "./host";
import { NO_DATA_COLOUR, rampColour } from "./profile";

export type SectionMetric = "delay_s" | "delay_ratio" | "speed_kmh" | "ttime_s";

export const SECTION_METRICS: ReadonlyArray<{ id: SectionMetric; label: string; unit: string; digits: number; reverse: boolean }> = [
  { id: "delay_s", label: "Delay (s)", unit: " s", digits: 0, reverse: false },
  { id: "delay_ratio", label: "Delay ratio (delay / travel time)", unit: "", digits: 2, reverse: false },
  { id: "speed_kmh", label: "Speed (km/h)", unit: " km/h", digits: 0, reverse: true },
  { id: "ttime_s", label: "Travel time (s)", unit: " s", digits: 0, reverse: false },
];

export interface SecRow {
  subpath_oid: string;
  seq: number;
  section_id: string;
  run: string | null;
  interval_start_s: number;
  duration_s: number;
  ttime_s: number | null;
  dtime_s: number | null;
  speed_kmh: number | null;
  flow: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** DuckDB rows -> SecRow (BigInt/null safe); rows without a usable bucket span are dropped. */
export function toSecRows(rows: ReadonlyArray<Record<string, unknown>>): SecRow[] {
  const out: SecRow[] = [];
  for (const r of rows) {
    const start = num(r.interval_start_s);
    const dur = num(r.duration_s);
    const seq = num(r.seq);
    if (start === null || dur === null || !(dur > 0) || seq === null || r.subpath_oid === null || r.subpath_oid === undefined) continue;
    out.push({
      subpath_oid: String(r.subpath_oid), seq, section_id: String(r.section_id ?? ""),
      run: r.run === null || r.run === undefined ? null : String(r.run),
      interval_start_s: start, duration_s: dur,
      ttime_s: num(r.ttime_s), dtime_s: num(r.dtime_s), speed_kmh: num(r.speed_kmh), flow: num(r.flow),
    });
  }
  return out;
}

export interface SectionValue {
  seq: number;
  section_id: string;
  ttime_s: number | null;
  dtime_s: number | null;
  speed_kmh: number | null;
  flow: number | null;
  delay_ratio: number | null;
  n: number;
}

const mean = (v: Array<number | null>): number | null => {
  const x = v.filter((n): n is number => n !== null && Number.isFinite(n));
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
};

/** Per-section values of one subpath for the time span [fromS, toS): mean over the simulated buckets overlapping it. */
export function sectionValuesAt(rows: readonly SecRow[], oid: string, run: string | null, fromS: number, toS: number): Map<number, SectionValue> {
  const by = new Map<number, SecRow[]>();
  for (const r of rows) {
    if (r.subpath_oid !== oid) continue;
    if (run !== null && r.run !== null && r.run !== run) continue;
    if (!(r.interval_start_s < toS && r.interval_start_s + r.duration_s > fromS)) continue;
    (by.get(r.seq) ?? by.set(r.seq, []).get(r.seq)!).push(r);
  }
  const out = new Map<number, SectionValue>();
  for (const [seq, rs] of by) {
    const tt = mean(rs.map((r) => r.ttime_s));
    const dt = mean(rs.map((r) => r.dtime_s));
    out.set(seq, {
      seq, section_id: rs[0].section_id, ttime_s: tt, dtime_s: dt, speed_kmh: mean(rs.map((r) => r.speed_kmh)), flow: mean(rs.map((r) => r.flow)),
      delay_ratio: tt !== null && tt > 0 && dt !== null ? dt / tt : null, n: rs.length,
    });
  }
  return out;
}

export function metricValue(v: SectionValue | undefined, m: SectionMetric): number | null {
  if (!v) return null;
  return m === "delay_s" ? v.dtime_s : m === "delay_ratio" ? v.delay_ratio : m === "speed_kmh" ? v.speed_kmh : v.ttime_s;
}

export interface SectionScale {
  min: number;
  max: number;
  metric: SectionMetric;
  unit: string;
  digits: number;
  reverse: boolean;
  colour(v: number | null): string;
}

/** Linear ramp over the values of the selected route at the selected bucket (low speed is the bad end). */
export function sectionScale(values: ReadonlyArray<number | null>, metric: SectionMetric): SectionScale {
  const def = SECTION_METRICS.find((m) => m.id === metric)!;
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  const min = v.length ? Math.min(...v) : 0;
  const max = v.length ? Math.max(...v) : 1;
  return {
    min, max, metric, unit: def.unit, digits: def.digits, reverse: def.reverse,
    colour: (x) => {
      if (x === null || !Number.isFinite(x)) return NO_DATA_COLOUR;
      const t = max === min ? 0.5 : (x - min) / (max - min);
      return rampColour(def.reverse ? 1 - t : t);
    },
  };
}

/** Section geometry features of one subpath, ordered by seq. Matches subpath_oid (string compare). */
export function sectionGeometry(sections: GeoJSONFC | null, oid: string): GeoJSONFeature[] {
  if (!sections) return [];
  return sections.features
    .filter((f) => String(f.properties?.subpath_oid ?? "") === oid)
    .sort((a, b) => Number(a.properties?.seq ?? 0) - Number(b.properties?.seq ?? 0));
}

/** Distinct subpath oids that have section geometry. */
export function sectionOids(sections: GeoJSONFC | null): Set<string> {
  return new Set((sections?.features ?? []).map((f) => String(f.properties?.subpath_oid ?? "")).filter(Boolean));
}

const f1 = (v: number | null, d = 1): string => (v === null || !Number.isFinite(v) ? "-" : v.toFixed(d));

export interface SectionFeatureInput {
  geometry: GeoJSONFeature[];
  values: ReadonlyMap<number, SectionValue>;
  metric: SectionMetric;
  scale: SectionScale;
  bucketLabel: string;
  routeName: string;
}

/** One coloured line per section; simplestyle `stroke` is set so a Layers-panel snapshot is styled too. */
export function sectionFeatures(inp: SectionFeatureInput): GeoJSONFC {
  const features: GeoJSONFeature[] = inp.geometry.map((g) => {
    const seq = Number(g.properties?.seq ?? 0);
    const v = inp.values.get(seq);
    const val = metricValue(v, inp.metric);
    const sectionId = String(g.properties?.section_id ?? v?.section_id ?? "");
    return {
      type: "Feature",
      id: `${String(g.properties?.subpath_oid ?? "")}:${seq}`,
      geometry: g.geometry,
      properties: {
        route: inp.routeName, subpath_oid: String(g.properties?.subpath_oid ?? ""), seq, section_id: sectionId,
        length_m: g.properties?.length_m ?? null, name: g.properties?.name ?? null, geometry_method: g.properties?.geometry_method ?? null,
        bucket: inp.bucketLabel,
        ttime_s: v?.ttime_s ?? null, dtime_s: v?.dtime_s ?? null, speed_kmh: v?.speed_kmh ?? null, delay_ratio: v?.delay_ratio ?? null,
        value: val,
        stroke: inp.scale.colour(val), "stroke-width": 6, "stroke-opacity": 1,
        tooltip: `Section ${sectionId} (#${seq}); travel time ${f1(v?.ttime_s ?? null)} s; delay ${f1(v?.dtime_s ?? null)} s; speed ${f1(v?.speed_kmh ?? null)} km/h`,
      },
    };
  });
  return { type: "FeatureCollection", features };
}

export interface WorstSection {
  seq: number;
  section_id: string;
  delay_s: number;
}

/** Top-n sections by delay (seconds) at the bucket. */
export function worstSections(values: ReadonlyMap<number, SectionValue>, n = 3): WorstSection[] {
  return [...values.values()]
    .filter((v) => v.dtime_s !== null)
    .sort((a, b) => (b.dtime_s as number) - (a.dtime_s as number) || a.seq - b.seq)
    .slice(0, n)
    .map((v) => ({ seq: v.seq, section_id: v.section_id, delay_s: v.dtime_s as number }));
}

/** Parse subpath_sections.geojson: LineString / MultiLineString features with a subpath_oid; others are skipped and counted. */
export function parseSectionGeoJson(json: unknown): { fc: GeoJSONFC; skipped: number } {
  const o = json as { type?: string; features?: unknown };
  if (!o || o.type !== "FeatureCollection" || !Array.isArray(o.features)) throw new Error("subpath_sections: not a GeoJSON FeatureCollection");
  const all = (o.features as GeoJSONFC["features"]).filter((f) => f && f.type === "Feature");
  const ok = all.filter((f) => f.geometry && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") && f.properties && f.properties.subpath_oid !== undefined && f.properties.subpath_oid !== null && f.properties.seq !== undefined);
  return { fc: { type: "FeatureCollection", features: ok }, skipped: all.length - ok.length };
}
