/** Pure helpers: style scales, GeoJSON assembly, selection parsing, band labels. No DOM, no DuckDB. */
import type { Selection } from "../_shared/src/sql/od-adapter.sql.ts";

export interface LineRow {
  origin: string;
  destination: string;
  trips: number;
  origin_name?: string | null;
  destination_name?: string | null;
  o_lon: number | null;
  o_lat: number | null;
  d_lon: number | null;
  d_lat: number | null;
}

export type Pt = [number, number];
export interface Feature<G> {
  type: "Feature";
  geometry: G;
  properties: Record<string, unknown>;
}
export interface FC<G = unknown> {
  type: "FeatureCollection";
  features: Array<Feature<G>>;
}
export const emptyFc = (): FC => ({ type: "FeatureCollection", features: [] });

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Line width (px): sqrt scale so that thin lines stay visible and the largest does not swamp the map. */
export function widthPx(v: number, max: number, minW = 1, maxW = 9): number {
  if (!(max > 0) || !(v > 0)) return minW;
  return minW + (maxW - minW) * Math.sqrt(Math.min(1, v / max));
}

/** Circle radius (px), area proportional to |v| down to a floor. */
export function radiusPx(v: number, max: number, minR = 3, maxR = 24): number {
  if (!(max > 0)) return minR;
  return Math.max(minR, maxR * Math.sqrt(Math.min(1, Math.abs(v) / max)));
}

const BLUE = [33, 102, 172];
const WHITE = [247, 247, 247];
const RED = [178, 24, 43];

const hex = (c: number[]): string => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

/** Diverging colour: decrease = blue, 0 = near white, increase = red; saturates at +-maxAbs. */
export function divergingHex(v: number, maxAbs: number): string {
  if (!fin(v) || !(maxAbs > 0)) return hex(WHITE);
  const t = Math.max(-1, Math.min(1, v / maxAbs));
  const end = t < 0 ? BLUE : RED;
  const a = Math.abs(t);
  return hex(WHITE.map((w, i) => w + (end[i] - w) * a));
}

/** Sequential single-hue colour (light yellow to dark blue), 0..1. */
export function sequentialHex(t: number): string {
  const x = Math.max(0, Math.min(1, fin(t) ? t : 0));
  const a = [255, 247, 188];
  const b = [8, 48, 107];
  const mid = [65, 171, 93];
  const seg = x < 0.5 ? [a, mid, x * 2] : [mid, b, (x - 0.5) * 2];
  const [p, q, k] = seg as [number[], number[], number];
  return hex(p.map((c, i) => c + (q[i] - c) * k));
}

/** Desire lines as straight LineStrings, largest drawn last (on top). Rows without coordinates are skipped. */
export function linesToFc(rows: readonly LineRow[], colorOf: (r: LineRow) => string, widthOf: (r: LineRow) => number, tipOf: (r: LineRow) => string): FC<{ type: "LineString"; coordinates: Pt[] }> {
  const ok = rows.filter((r) => fin(r.o_lon) && fin(r.o_lat) && fin(r.d_lon) && fin(r.d_lat));
  const sorted = [...ok].sort((a, b) => Math.abs(a.trips) - Math.abs(b.trips));
  return {
    type: "FeatureCollection",
    features: sorted.map((r) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[r.o_lon as number, r.o_lat as number], [r.d_lon as number, r.d_lat as number]] },
      properties: { c: colorOf(r), w: widthOf(r), tip: tipOf(r) },
    })),
  };
}

export function boundsOf(fc: FC<any>): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: any): void => {
    if (typeof c[0] === "number") {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else for (const x of c) visit(x);
  };
  for (const f of fc.features) visit(f.geometry.coordinates);
  return w <= e ? [w, s, e, n] : null;
}

/** Deviation bands from the rendering_adjustments contract: |ratio| in [0,.05) [.05,.1) [.1,.2) [.2,.5) [.5,inf). */
export const BAND_EDGES = [0, 0.05, 0.1, 0.2, 0.5] as const;

export function bandLabel(i: number): string {
  if (i < 0) return "new";
  const lo = BAND_EDGES[i] * 100;
  const hi = BAND_EDGES[i + 1];
  return hi === undefined ? `>= ${lo}%` : `${lo}-${hi * 100}%`;
}

export function bandOf(absRatio: number): number {
  let b = 0;
  for (let i = 1; i < BAND_EDGES.length; i++) if (absRatio >= BAND_EDGES[i]) b = i;
  return b;
}

/** Selector state -> SQL selection. Centroid pickers hold "id - name" text; the leading integer is the id. */
export function parseSelection(kind: string, value: string): Selection {
  if (kind === "group" && value) return { kind: "group", value };
  if (kind === "centroid") {
    const m = /^\s*(\d{1,18})\b/.exec(value);
    if (m) return { kind: "centroid", value: m[1] };
  }
  return { kind: "all" };
}

export function describeSelection(sel: Selection, nameOf: (id: string) => string | undefined, all: string): string {
  if (sel.kind === "all") return all;
  if (sel.kind === "group") return sel.value;
  const n = nameOf(sel.value);
  return n ? `${sel.value} - ${n}` : sel.value;
}

/** CSV cell escape (RFC 4180) for table export. */
export const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
