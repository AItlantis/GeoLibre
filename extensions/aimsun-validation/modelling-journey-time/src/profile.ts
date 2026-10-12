/**
 * Aggregation helpers on top of the shared `v_sp_obs` view (route/dir/source x time-of-day bucket,
 * statistics across days). Pure functions: no DOM, no DuckDB.
 */
import type { GeoJSONFC, GeoJSONFeature } from "./host";
import type { LinePoint, BandPoint } from "./lineSvg";
import { minutesToHHMM } from "./lineSvg";
import { pairKey, type MatchResult } from "./match";

export interface ObsRow {
  route: string;
  direction_norm: string;
  source: string;
  bucket_start_min: number;
  n_days: number;
  mean_s: number | null;
  median_s: number | null;
  min_s: number | null;
  max_s: number | null;
}

export type Stat = "mean" | "median";
export type ColourBy = "seconds" | "ratio";

export const bucketLabel = minutesToHHMM;

const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** Coerce DuckDB rows (BigInt/null-safe) to ObsRow. */
export function toObsRows(rows: ReadonlyArray<Record<string, unknown>>): ObsRow[] {
  return rows.map((r) => ({
    route: String(r.route),
    direction_norm: String(r.direction_norm),
    source: String(r.source),
    bucket_start_min: Number(r.bucket_start_min),
    n_days: Number(r.n_days),
    mean_s: num(r.mean_s),
    median_s: num(r.median_s),
    min_s: num(r.min_s),
    max_s: num(r.max_s),
  }));
}

export interface Profile {
  mean: LinePoint[];
  median: LinePoint[];
  band: BandPoint[];
  nDaysMax: number;
}

/** Profile of one route/direction/source, sorted by bucket. */
export function profileOf(rows: readonly ObsRow[], route: string, direction: string, source: string): Profile {
  const mine = rows
    .filter((r) => r.route === route && r.direction_norm === direction && r.source === source)
    .sort((a, b) => a.bucket_start_min - b.bucket_start_min);
  return {
    mean: mine.map((r) => ({ x: r.bucket_start_min, y: r.mean_s })),
    median: mine.map((r) => ({ x: r.bucket_start_min, y: r.median_s })),
    band: mine.map((r) => ({ x: r.bucket_start_min, lo: r.min_s, hi: r.max_s })),
    nDaysMax: mine.reduce((m, r) => Math.max(m, r.n_days), 0),
  };
}

export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface BucketValue {
  key: string;
  route: string;
  direction: string;
  /** Value used for colouring (seconds, or ratio to the route's own median over the day). */
  value: number | null;
  seconds: number | null;
  nDays: number;
}

/** One value per observed route/direction at a time bucket, for one source. `rows` must hold ONE source. */
export function valuesAtBucket(rows: readonly ObsRow[], bucket: number, stat: Stat, mode: ColourBy): Map<string, BucketValue> {
  const pick = (r: ObsRow): number | null => (stat === "mean" ? r.mean_s : r.median_s);
  const dayMedian = new Map<string, number | null>();
  if (mode === "ratio") {
    const byKey = new Map<string, number[]>();
    for (const r of rows) {
      const k = pairKey(r.route, r.direction_norm) ?? `${r.route}|${r.direction_norm}`;
      const v = pick(r);
      if (v !== null) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(v);
    }
    for (const [k, v] of byKey) dayMedian.set(k, median(v));
  }
  const out = new Map<string, BucketValue>();
  for (const r of rows) {
    if (r.bucket_start_min !== bucket) continue;
    const key = pairKey(r.route, r.direction_norm) ?? `${r.route}|${r.direction_norm}`;
    const s = pick(r);
    const ref = dayMedian.get(key) ?? null;
    out.set(key, {
      key,
      route: r.route,
      direction: r.direction_norm,
      seconds: s,
      value: mode === "seconds" ? s : s !== null && ref ? s / ref : null,
      nDays: r.n_days,
    });
  }
  return out;
}

// ---- colour scale (sequential YlOrRd, light -> dark = short -> long) --------------------------
const STOPS = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"];
export const NO_DATA_COLOUR = "#9ca3af";

const hex2rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const rgb2hex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** t in [0,1] -> hex colour. */
export function rampColour(t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const a = hex2rgb(STOPS[i]);
  const b = hex2rgb(STOPS[i + 1]);
  const k = x - i;
  return rgb2hex(a.map((v, j) => v + (b[j] - v) * k));
}

export interface ColourScale {
  min: number;
  max: number;
  colour(v: number | null): string;
}

export function colourScale(values: ReadonlyArray<number | null>): ColourScale {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  const min = v.length ? Math.min(...v) : 0;
  const max = v.length ? Math.max(...v) : 1;
  return { min, max, colour: (x) => (x === null || !Number.isFinite(x) ? NO_DATA_COLOUR : rampColour(max === min ? 0.5 : (x - min) / (max - min))) };
}

export interface OverlayInput {
  geo: GeoJSONFC;
  /** Aligned with geo.features (see subpathRefs()). */
  match: MatchResult;
  values: ReadonlyMap<string, BucketValue>;
  source: string;
  bucket: number;
  scale: ColourScale;
}

/** FeatureCollection of the matched subpaths coloured for one bucket (simplestyle `stroke` so the Layers panel snapshot is styled too). */
export function overlayFeatures(inp: OverlayInput): GeoJSONFC {
  const byId = new Map<string, GeoJSONFeature>();
  inp.geo.features.forEach((f, i) => byId.set(String((f.properties?.id as string | number | undefined) ?? f.id ?? i), f));
  const features: GeoJSONFeature[] = [];
  for (const row of inp.match.matchedObs) {
    const val = row.key ? inp.values.get(row.key) : undefined;
    for (const m of row.matches) {
      const f = byId.get(String(m.subpath.id));
      if (!f) continue;
      features.push({
        type: "Feature",
        id: m.subpath.id,
        geometry: f.geometry,
        properties: {
          name: m.subpath.name,
          group: m.subpath.group,
          route: row.route,
          direction: row.direction,
          source: inp.source,
          bucket: bucketLabel(inp.bucket),
          jt_s: val?.seconds ?? null,
          value: val?.value ?? null,
          stroke: inp.scale.colour(val?.value ?? null),
          "stroke-width": 4,
          "stroke-opacity": 0.9,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export function featuresBounds(fc: GeoJSONFC): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  for (const f of fc.features) visit(f.geometry?.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
