/**
 * Pure helpers for the OD Trips map: layer selection (bars vs dots), bar sizing, the per-centroid
 * label features (full-selection totals, never the top-N pair subset), MapLibre label expressions,
 * the DOM fallback layout used when the basemap style has no `glyphs`, and the legend model.
 * Kept free of DOM/MapLibre so it is unit-testable.
 */
import type { Feature, FC } from "./calc.ts";
import { barHeight, OD_COLORS } from "./map-logic.ts";
export { OD_COLORS, barOffset } from "./map-logic.ts";

/** ---- layer selection ---- */
export interface TripsLayerOpts { bars: boolean; grouped: boolean; lineStyle: "2d" | "3d"; labels: boolean }
/** Bars replace the dot layers (centroids, groups, ends); otherwise the dots show. */
export function tripsLayerIds(o: TripsLayerOpts): string[] {
  const lines = o.lineStyle === "3d" ? "3d-lines" : "lines";
  const ids = o.bars ? [lines, "bars"] : [o.grouped ? "groups" : "centroids", lines, "ends"];
  if (o.labels) ids.push("labels");
  return ids;
}

/** ---- bar sizing ---- */
export const BAR_DEFAULTS = { size: 50, cap: 400, targetHeight: 150 } as const;
/** Auto height scale (m per 1000 trips) so the tallest bar is ~`target` m. */
export function autoBarScale(maxTrips: number, target: number = BAR_DEFAULTS.targetHeight, logarithmic = false): number {
  const m = Math.max(1, maxTrips) / 1000;
  return Math.max(0.001, target / (logarithmic ? Math.log1p(m) : m));
}
/** Largest 1/2/5 x 10^k that is <= max (>= 1): a readable reference for the height legend. */
export function niceTripsRef(maxTrips: number): number {
  if (!(maxTrips >= 1)) return 1;
  const p = 10 ** Math.floor(Math.log10(maxTrips));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= maxTrips) ?? p;
}
export interface BarLegendInfo { refTrips: number; heightM: number; logarithmic: boolean; capped: boolean }
export function barLegendInfo(maxTrips: number, scale: number, cap: number, logarithmic: boolean): BarLegendInfo {
  const refTrips = niceTripsRef(maxTrips);
  const raw = barHeight(refTrips, scale, Infinity, logarithmic);
  return { refTrips, heightM: Math.round(Math.min(cap, raw)), logarithmic, capped: raw > cap };
}

/** ---- label features ---- */
export interface NodeTotals { id: string; name: string; lon: number; lat: number; out: number; in: number }
export interface LabelOpts { fmtInt: (n: number) => string; outWord?: string; inWord?: string; barHeightM?: (n: NodeTotals) => number; maxLabels?: number }
/** Zoom bands: a label with rank < K(band) shows from that band's lower zoom bound. */
export const LABEL_BANDS: ReadonlyArray<{ minZoom: number; k: number }> = [
  { minZoom: 0, k: 8 }, { minZoom: 9, k: 20 }, { minZoom: 11, k: 50 }, { minZoom: 13, k: 120 }, { minZoom: 15, k: Infinity },
];
export function labelMinZoom(rank: number): number {
  return LABEL_BANDS.find((b) => rank < b.k)!.minZoom;
}
/** Label text = name, then `out N / in M` (thousands-separated by the injected formatter). */
export function labelFeatures(nodes: readonly NodeTotals[], o: LabelOpts): Array<Feature<{ type: "Point"; coordinates: [number, number] }>> {
  const outW = o.outWord ?? "out", inW = o.inWord ?? "in";
  return nodes
    .filter((n) => Number.isFinite(n.lon) && Number.isFinite(n.lat) && n.out + n.in > 0)
    .map((n) => ({ n, total: n.out + n.in }))
    .sort((a, b) => b.total - a.total || a.n.id.localeCompare(b.n.id))
    .slice(0, o.maxLabels ?? 400)
    .map(({ n, total }, rank) => {
      const out_s = `${outW} ${o.fmtInt(n.out)}`, in_s = `${inW} ${o.fmtInt(n.in)}`;
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [n.lon, n.lat] as [number, number] },
        properties: { id: n.id, name: n.name || n.id, out_s, in_s, total, sk: -total, rank, minz: labelMinZoom(rank), hm: Math.round(o.barHeightM?.(n) ?? 0), tip: `${n.name || n.id}\n${out_s} / ${in_s}` },
      };
    });
}

/** Zoom-banded px-per-metre (mid-latitude, pitched view) used to lift labels above the bars. */
const BAND_ZOOMS = [10, 12, 14, 16, 18];
const pxPerMetre = (z: number, latDeg = 45): number => (2 ** z) / (78271.517 * Math.cos(latDeg * Math.PI / 180));
const PITCH_FORESHORTEN = 0.57;
const TEXT_PX = 12;
const HM_STEP = 25;
/** em lift for a bar of `hm` metres at zoom `z`. */
export function liftEm(hm: number, z: number): number {
  return 0.6 + (Math.max(0, hm) * pxPerMetre(z) * PITCH_FORESHORTEN) / TEXT_PX;
}
/** text-offset: top-level zoom step, each band a step over the per-feature bar height `hm`. */
export function labelOffsetExpression(maxHm: number = BAR_DEFAULTS.cap): unknown[] {
  const band = (z: number): unknown[] => {
    const e: unknown[] = ["step", ["get", "hm"], ["literal", [0, -Number(liftEm(0, z).toFixed(2))]]];
    for (let h = HM_STEP; h <= maxHm; h += HM_STEP) e.push(h, ["literal", [0, -Number(liftEm(h, z).toFixed(2))]]);
    return e;
  };
  const e: unknown[] = ["step", ["zoom"], band(BAND_ZOOMS[0])];
  for (let i = 1; i < BAND_ZOOMS.length; i++) e.push(BAND_ZOOMS[i] - 1, band(BAND_ZOOMS[i]));
  return e;
}
/** text-size: zoom-banded; a label whose `minz` is above the band's lower bound gets size 0 (top-K by zoom). */
export function labelSizeExpression(): unknown[] {
  const sizes = [10, 11, 12, 13, 14];
  const e: unknown[] = ["step", ["zoom"], 0];
  LABEL_BANDS.forEach((b, i) => {
    const v = ["case", ["<=", ["get", "minz"], b.minZoom], sizes[i], 0];
    if (i === 0) e[2] = v; else e.push(b.minZoom, v);
  });
  return e;
}
/** Two-line, two-colour label text (origin orange / destination blue). */
export function labelTextField(): unknown[] {
  return ["format", ["get", "name"], {}, "\n", {}, ["get", "out_s"], { "text-color": OD_COLORS.origin }, "  /  ", {}, ["get", "in_s"], { "text-color": OD_COLORS.destination }];
}
export const LABEL_LAYOUT_BASE = { "text-optional": true, "text-allow-overlap": false, "text-anchor": "bottom", "text-justify": "center", "text-max-width": 12, "symbol-sort-key": ["get", "sk"], "text-padding": 2 } as const;
export const LABEL_PAINT = { "text-color": "#1b1f24", "text-halo-color": "#ffffff", "text-halo-width": 2, "text-halo-blur": 0.5 } as const;

/** Font stack borrowed from the basemap style (a style serves only its own glyph ranges). */
export function resolveLabelFont(layers: ReadonlyArray<{ type: string; layout?: Record<string, unknown> }> | undefined, fallback: string[] = ["Noto Sans Regular"]): string[] {
  for (const l of layers ?? []) {
    if (l.type !== "symbol" || !l.layout?.["text-field"]) continue;
    const f = l.layout["text-font"];
    if (!Array.isArray(f)) continue;
    const fonts = f[0] === "literal" && Array.isArray(f[1]) ? (f[1] as unknown[]) : (f as unknown[]);
    if (fonts.length && fonts.every((x) => typeof x === "string") && !["get", "case", "match", "coalesce", "step", "interpolate", "let", "var", "concat", "format"].includes(fonts[0] as string)) return fonts as string[];
  }
  return fallback;
}

/** ---- DOM fallback (no `glyphs` in the basemap style) ---- */
export interface DomLabelIn { id: string; x: number; y: number; sk: number; minz: number; lift: number }
export interface DomLabelOut { id: string; x: number; y: number }
/** Greedy screen-space collision: biggest first, skip labels overlapping an accepted one or off-screen. */
export function layoutDomLabels(items: readonly DomLabelIn[], zoom: number, view: { w: number; h: number }, box = { w: 110, h: 30 }, max = 80): DomLabelOut[] {
  const placed: DomLabelOut[] = [];
  for (const it of [...items].sort((a, b) => a.sk - b.sk)) {
    if (placed.length >= max) break;
    if (it.minz > zoom) continue;
    const x = it.x, y = it.y - it.lift;
    if (x < -box.w || y < -box.h || x > view.w + box.w || y > view.h + box.h) continue;
    if (placed.some((p) => Math.abs(p.x - x) < box.w && Math.abs(p.y - y) < box.h)) continue;
    placed.push({ id: it.id, x, y });
  }
  return placed;
}
/** On-screen lift (px) of a bar of `hm` metres at the current zoom/latitude/pitch. */
export function liftPx(hm: number, zoom: number, latDeg: number, pitchDeg: number): number {
  return Math.max(0, hm) * pxPerMetre(zoom, latDeg) * Math.max(0, Math.cos(pitchDeg * Math.PI / 180)) + 4;
}

/** ---- legend ---- */
export type Tr = (key: string, def: string, params?: Record<string, string | number>) => string;
export interface LegendEntry { key: string; kind: "dot" | "bar" | "line" | "text"; color?: string; text: string }
export interface LegendOpts { bars: boolean; labels: boolean; grouped: boolean; lineStyle: "2d" | "3d"; barInfo?: BarLegendInfo | null; fmtInt: (n: number) => string; t: Tr }
export function legendEntries(o: LegendOpts): LegendEntry[] {
  const { t } = o;
  const e: LegendEntry[] = [];
  if (o.bars) {
    e.push({ key: "bar-origin", kind: "bar", color: OD_COLORS.origin, text: t("legend.barOrigin", "bar: origin trips (out)") });
    e.push({ key: "bar-dest", kind: "bar", color: OD_COLORS.destination, text: t("legend.barDest", "bar: destination trips (in)") });
    if (o.barInfo) e.push({ key: "bar-scale", kind: "text", text: t(o.barInfo.logarithmic ? "legend.barScaleLog" : "legend.barScale", o.barInfo.logarithmic ? "log scale: {{n}} trips = {{m}} m" : "{{n}} trips = {{m}} m", { n: o.fmtInt(o.barInfo.refTrips), m: o.fmtInt(o.barInfo.heightM) }) });
  } else {
    e.push({ key: "dot-origin", kind: "dot", color: OD_COLORS.origin, text: t("legend.origin", "origin") });
    e.push({ key: "dot-dest", kind: "dot", color: OD_COLORS.destination, text: t("legend.dest", "destination") });
    e.push({ key: "dot-both", kind: "dot", color: OD_COLORS.both, text: t("legend.both", "origin and destination") });
    e.push({ key: "dot-size", kind: "text", text: t(o.grouped ? "legend.dotSizeGroups" : "legend.dotSize", o.grouped ? "grey circle: group, size ~ trips" : "dot size ~ trips; grey dot: centroid") });
  }
  e.push({ key: "line", kind: "line", color: OD_COLORS.line, text: t(o.lineStyle === "3d" ? "legend.arch" : "legend.width", o.lineStyle === "3d" ? "arch: desire line, width ~ trips" : "line width ~ trips") });
  if (o.labels) e.push({ key: "labels", kind: "text", text: t("legend.labels", "label: name, out N / in M (selection totals)") });
  return e;
}

/** Hint under the map legend; groups mode no longer claims "grey dots: all centroids". */
export function mapHintText(o: { grouped: boolean; bars: boolean; t: Tr }): string {
  const { t } = o;
  if (o.grouped) return t("map.hintGroups", "Straight lines between group centres, not routes; every pair of the selection is aggregated by group. Circles (or bars) show trips per group.");
  return t("map.hintCentroids", "Straight lines between centroids, not routes. Dots, bars and labels are selection totals per centroid.");
}
export function topNNotice(o: { grouped: boolean; shown: number; sharePct: string; t: Tr; fmtInt: (n: number) => string }): string | null {
  if (o.grouped) return null;
  return o.t("map.topNote", "Showing the {{n}} largest pairs ({{p}} of the selection's trips); dots, bars and labels use full-selection totals.", { n: o.fmtInt(o.shown), p: o.sharePct });
}

/** ---- full-selection totals query ---- */
/** Out/in trips per centroid over the whole selection (not the top-N pairs). `where` is an already-built predicate (may be ""). */
export function centroidTotalsSql(table: string, where: string): string {
  const w = where ? `WHERE ${where}` : "";
  return `SELECT id, SUM(o) AS out_trips, SUM(i) AS in_trips FROM (SELECT CAST(t.origin AS VARCHAR) AS id, t.trips AS o, 0 AS i FROM ${table} t ${w} UNION ALL SELECT CAST(t.destination AS VARCHAR) AS id, 0 AS o, t.trips AS i FROM ${table} t ${w}) f GROUP BY id`;
}
export function nodesFromTotals(rows: ReadonlyArray<Record<string, unknown>>, centroids: ReadonlyArray<{ id: string; name: string; lon: number | null; lat: number | null }>): NodeTotals[] {
  const by = new Map(centroids.map((c) => [String(c.id), c]));
  const out: NodeTotals[] = [];
  for (const r of rows) {
    const c = by.get(String(r.id));
    if (!c || c.lon === null || c.lat === null) continue;
    out.push({ id: String(c.id), name: c.name, lon: c.lon, lat: c.lat, out: Number(r.out_trips) || 0, in: Number(r.in_trips) || 0 });
  }
  return out;
}
export type { FC };
