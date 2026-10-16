/**
 * C12: per-section delay along a subpath (micro runs). Pure functions (no DOM, no DuckDB).
 *   subpath_sections.geojson  LineString per (subpath_oid, seq): section_id, length_m, name, geometry_method
 *   section_sim_tt            subpath_oid, seq, section_id, run, interval_start_s, duration_s, ttime_s, dtime_s, speed_kmh, flow
 * Both are optional; without them the plugin keeps drawing the single-colour route line.
 */
import type { GeoJSONFC, GeoJSONFeature } from "./host";
import { NO_DATA_COLOUR } from "./profile";

/** The section layer shows speed only; delay / delay ratio / travel time stay in the hover tooltip. */
export const SECTION_LINE_WIDTH = 6;

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

/** Red (slow) -> yellow -> green (fast); one colour per 25 % breakpoint of the route's max section speed. */
export const SPEED_STOPS: readonly string[] = ["#d73027", "#f46d43", "#fdd835", "#a6d96a", "#1a9850"];
export const SPEED_BREAKS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

const hex2rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const rgb2hex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export interface SpeedScale {
  /** Smallest / largest section speed of the route at the bucket (informational). */
  min: number;
  max: number;
  /** Speeds (km/h) at the 0/25/50/75/100 % breakpoints of max. */
  breaks: number[];
  /** Colour at each breakpoint. */
  stops: readonly string[];
  colour(v: number | null): string;
}

/** Fixed-breakpoint speed scale: 0 -> red, max -> green, linear in between (breakpoints at 0/25/50/75/100 % of max). */
export function speedScale(values: ReadonlyArray<number | null>): SpeedScale {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  const min = v.length ? Math.min(...v) : 0;
  const max = v.length ? Math.max(...v) : 0;
  return {
    min, max, breaks: SPEED_BREAKS.map((b) => b * max), stops: SPEED_STOPS,
    colour: (x) => {
      if (x === null || !Number.isFinite(x)) return NO_DATA_COLOUR;
      const f = max > 0 ? Math.min(1, Math.max(0, x / max)) : 1;
      const pos = f * (SPEED_STOPS.length - 1);
      const i = Math.min(SPEED_STOPS.length - 2, Math.floor(pos));
      const a = hex2rgb(SPEED_STOPS[i]);
      const c = hex2rgb(SPEED_STOPS[i + 1]);
      return rgb2hex(a.map((q, j) => q + (c[j] - q) * (pos - i)));
    },
  };
}

/** CSS gradient of the legend ramp (same stops, same positions as the map colours). */
export function speedGradient(): string {
  return `linear-gradient(90deg, ${SPEED_STOPS.map((c, i) => `${c} ${SPEED_BREAKS[i] * 100}%`).join(", ")})`;
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
  scale: SpeedScale;
  bucketLabel: string;
  routeName: string;
}

/** One line per section coloured by speed (km/h); simplestyle `stroke` is set so a Layers-panel snapshot is styled too. */
export function sectionFeatures(inp: SectionFeatureInput): GeoJSONFC {
  const features: GeoJSONFeature[] = inp.geometry.map((g) => {
    const seq = Number(g.properties?.seq ?? 0);
    const v = inp.values.get(seq);
    const val = v?.speed_kmh ?? null;
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
        stroke: inp.scale.colour(val), "stroke-width": SECTION_LINE_WIDTH, "stroke-opacity": 1,
        tooltip: `Section ${sectionId} (#${seq}); travel time ${f1(v?.ttime_s ?? null)} s; delay ${f1(v?.dtime_s ?? null)} s; speed ${f1(v?.speed_kmh ?? null)} km/h`,
      },
    };
  });
  return { type: "FeatureCollection", features };
}

export interface SlowestSection {
  seq: number;
  section_id: string;
  speed_kmh: number;
  length_m: number | null;
}

/** The n slowest sections (km/h) at the bucket, with the section length taken from the geometry. */
export function slowestSections(values: ReadonlyMap<number, SectionValue>, geometry: readonly GeoJSONFeature[], n = 3): SlowestSection[] {
  const length = new Map<number, number | null>();
  for (const g of geometry) {
    const l = Number(g.properties?.length_m);
    length.set(Number(g.properties?.seq ?? 0), g.properties?.length_m === null || g.properties?.length_m === undefined || !Number.isFinite(l) ? null : l);
  }
  return [...values.values()]
    .filter((v) => v.speed_kmh !== null && Number.isFinite(v.speed_kmh))
    .sort((a, b) => (a.speed_kmh as number) - (b.speed_kmh as number) || a.seq - b.seq)
    .slice(0, n)
    .map((v) => ({ seq: v.seq, section_id: v.section_id, speed_kmh: v.speed_kmh as number, length_m: length.get(v.seq) ?? null }));
}

/** Parse subpath_sections.geojson: LineString / MultiLineString features with a subpath_oid; others are skipped and counted. */
export function parseSectionGeoJson(json: unknown): { fc: GeoJSONFC; skipped: number } {
  const o = json as { type?: string; features?: unknown };
  if (!o || o.type !== "FeatureCollection" || !Array.isArray(o.features)) throw new Error("subpath_sections: not a GeoJSON FeatureCollection");
  const all = (o.features as GeoJSONFC["features"]).filter((f) => f && f.type === "Feature");
  const ok = all.filter((f) => f.geometry && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") && f.properties && f.properties.subpath_oid !== undefined && f.properties.subpath_oid !== null && f.properties.seq !== undefined);
  return { fc: { type: "FeatureCollection", features: ok }, skipped: all.length - ok.length };
}
