/** C6 detector coverage: parsing, coverage/arrow features, zoom-dependent layers, images, selection, reload, disposal. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateDetectors } from "../src/common/aggregate.ts";
import {
  buildCoverage,
  buildFeatures,
  buildUnmatchedCoverage,
  buildUnmatchedFeatures,
  detectorExtentPoints,
  glyphFor,
  parseDetectorGeo,
  partsForAgg,
} from "../src/common/geo.ts";
import { ARROW_POLYGON, GLYPH_SIZE, makeArrowImage, makeNeutralImage } from "../src/common/glyphs.ts";
import {
  arrowAllowOverlap,
  arrowIgnorePlacement,
  arrowOpacity,
  arrowPadding,
  arrowSize,
  arrowSortKey,
  coverageLineWidth,
  DetectorMapLayer,
  dotFilter,
  dotOpacity,
  glyphHeightPx,
  hitBox,
  HIT_PX,
  pickFeature,
  selectedAreaFilter,
  selectedArrowFilter,
  ZOOM,
} from "../src/common/map-layer.ts";
import { cardinal, countLegend, countLegendModel, directionNote, directionTip } from "../src/common/count-legend.ts";
import { installDomShim } from "./dom-shim.ts";
import { fileURLToPath } from "node:url";

const FIX = new URL("./fixtures/detectors_c6.geojson", import.meta.url);
const c6 = JSON.parse(readFileSync(FIX, "utf8"));
const legacy = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [55.1, 25.2] }, properties: { oid: 10, eid: "E1" } },
    { type: "Feature", geometry: null, properties: { oid: 11, eid: "E2", x: 55.3, y: 25.3 } },
  ],
};
const row = (eid: string, oid: number, sim = 100, obs = 90) => ({ detector_id: eid, oid, bucket_start_min: 0, sim_flow_h: sim, obs_flow_h: obs, geh: 3, status: "pass" as const });
const C6_ROWS = ([["C6_FWD", 5001], ["C6_REV", 5002], ["J383_A", 5003], ["C6_BIDI", 5006], ["C6_MIX", 5007], ["C6_NOBRG", 5008], ["C6_POINT", 5009]] as const).map(([e, o]) => row(e, o));

// ---------- parsing ----------
test("parseDetectorGeo: Polygon, MultiPolygon and Point features with the C6 properties", () => {
  const g = parseDetectorGeo(c6);
  assert.equal(g.count, 9);
  assert.equal(g.hasCoverage, true);
  const fwd = g.parts.get("5001")!;
  assert.equal(fwd.coverage?.type, "Polygon");
  assert.equal(fwd.eid, "C6_FWD");
  assert.equal(fwd.bearingDeg, 75.3);
  assert.equal(fwd.direction, "forward");
  assert.equal(fwd.sectionId, 35975);
  assert.deepEqual(fwd.lanes, [0]);
  assert.equal(fwd.positionM, 152.0886);
  assert.equal(fwd.lengthM, 3);
  assert.equal(fwd.geometryMethod, "lane-polyline");
  assert.equal(g.parts.get("5005")!.coverage?.type, "MultiPolygon");
  assert.equal(g.parts.get("5009")!.coverage, null);
  assert.equal(g.parts.get("5009")!.geometryMethod, "point");
  assert.equal(g.parts.get("5008")!.bearingDeg, null);
  // the anchor is x/y (kept for old readers)
  assert.deepEqual(g.byOid.get("5001"), { lon: c6.features[0].properties.x, lat: c6.features[0].properties.y });
});

test("parseDetectorGeo: eid -> several oids is exposed as a multimap and nothing is aggregated", () => {
  const g = parseDetectorGeo(c6);
  assert.deepEqual(g.oidsByEid.get("J383_A"), ["5003", "5004", "5005"]);
  assert.equal(g.oidsByEid.size, 7);
  assert.equal(g.parts.size, 9);
  const parts = partsForAgg(g, { id: "J383_A", oid: "5003" });
  assert.deepEqual(parts.map((p) => p.oid), ["5003", "5004", "5005"]);
});

test("parseDetectorGeo: Feature.id is the oid when properties.oid is missing; centroid anchor without x/y", () => {
  const poly = { type: "Polygon", coordinates: [[[55, 25], [55.001, 25], [55.001, 25.001], [55, 25.001], [55, 25]]] };
  const g = parseDetectorGeo({ type: "FeatureCollection", features: [{ type: "Feature", id: 77, geometry: poly, properties: { eid: "Z" } }] });
  assert.equal(g.parts.get("77")?.eid, "Z");
  const a = g.byOid.get("77")!;
  assert.ok(Math.abs(a.lon - 55.0005) < 1e-9 && Math.abs(a.lat - 25.0005) < 1e-9);
});

test("parseDetectorGeo: invalid polygon geometry is dropped but the x/y anchor survives; projected metres rejected", () => {
  const bad = { type: "Polygon", coordinates: [[[350000, 2790000], [350003, 2790000], [350003, 2790003], [350000, 2790000]]] };
  const g = parseDetectorGeo({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: bad, properties: { oid: 1, eid: "A", x: 55.1, y: 25.1 } },
      { type: "Feature", geometry: bad, properties: { oid: 2, eid: "B" } },
    ],
  });
  assert.equal(g.count, 1);
  assert.equal(g.hasCoverage, false);
  assert.equal(g.parts.get("1")!.coverage, null);
  assert.equal(g.parts.has("2"), false);
});

test("legacy Point-only package: same index as before, no coverage", () => {
  const g = parseDetectorGeo(legacy);
  assert.equal(g.count, 2);
  assert.equal(g.hasCoverage, false);
  assert.deepEqual(g.byOid.get("11"), { lon: 55.3, lat: 25.3 });
  assert.deepEqual(g.byEid.get("E1"), { lon: 55.1, lat: 25.2 });
  const aggs = aggregateDetectors([row("E1", 10)]);
  const { fc } = buildFeatures(aggs, g);
  assert.equal("cov" in fc.features[0].properties, false);
  assert.deepEqual(buildCoverage(aggs, g).features, []);
  assert.deepEqual(buildUnmatchedCoverage([{ oid: "10", flow: 1 }], g), []);
});

// ---------- direction glyph rule ----------
test("glyph rule: arrow only for forward/reverse with a bearing; bidirectional, mixed, unknown or missing bearing are neutral", () => {
  assert.equal(glyphFor({ direction: "forward", bearingDeg: 10 }), "arrow");
  assert.equal(glyphFor({ direction: "reverse", bearingDeg: 190 }), "arrow");
  assert.equal(glyphFor({ direction: "forward", bearingDeg: null }), "neutral");
  assert.equal(glyphFor({ direction: "bidirectional", bearingDeg: 90 }), "neutral");
  assert.equal(glyphFor({ direction: "mixed", bearingDeg: 45 }), "neutral");
  assert.equal(glyphFor({ direction: "unknown", bearingDeg: 45 }), "neutral");
  assert.equal(glyphFor({ direction: null, bearingDeg: 45 }), "neutral");
});

// ---------- features ----------
test("buildCoverage: one area + one glyph per oid, metrics shared per eid, analytical rows not multiplied", () => {
  const g = parseDetectorGeo(c6);
  const aggs = aggregateDetectors(C6_ROWS);
  assert.equal(aggs.length, 7, "one analytical row per eid");
  const { fc } = buildFeatures(aggs, g);
  assert.equal(fc.features.length, 7, "one dot per eid");
  assert.equal(fc.features.filter((f) => f.properties.cov === true).length, 6, "the Point-only detector keeps its dot");
  const cov = buildCoverage(aggs, g);
  const area = cov.features.filter((f) => f.properties.kind === "area");
  const glyph = cov.features.filter((f) => f.properties.kind === "arrow");
  assert.equal(area.length, 8, "3 oids of J383_A + 5 single-oid polygons");
  assert.equal(glyph.length, 8);
  const j = area.filter((f) => f.properties.eid === "J383_A");
  assert.equal(j.length, 3);
  assert.deepEqual(new Set(j.map((f) => f.properties.sim)).size, 1, "every part of an eid carries the eid's metric (no per-oid split or sum)");
  assert.ok(area.some((f) => f.geometry.type === "MultiPolygon"));
  assert.equal(glyph.find((f) => f.properties.oid === "5001")!.properties.glyph, "arrow");
  assert.equal(glyph.find((f) => f.properties.oid === "5001")!.properties.bearing_deg, 75.3);
  assert.equal(glyph.find((f) => f.properties.oid === "5002")!.properties.bearing_deg, 255.3);
  assert.equal(glyph.find((f) => f.properties.oid === "5006")!.properties.glyph, "neutral");
  assert.equal(glyph.find((f) => f.properties.oid === "5008")!.properties.glyph, "neutral");
});

test("buildCoverage: an eid with a polygon oid and a point-only oid still gets a glyph for the point part", () => {
  const poly = { type: "Polygon", coordinates: [[[55, 25], [55.0001, 25], [55.0001, 25.0001], [55, 25.0001], [55, 25]]] };
  const g = parseDetectorGeo({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: 1, geometry: poly, properties: { oid: 1, eid: "S", direction: "forward", bearing_deg: 10, x: 55, y: 25 } },
      { type: "Feature", id: 2, geometry: { type: "Point", coordinates: [55.0002, 25] }, properties: { oid: 2, eid: "S", direction: "unknown" } },
    ],
  });
  const cov = buildCoverage(aggregateDetectors([row("S", 1)]), g);
  assert.equal(cov.features.filter((f) => f.properties.kind === "area").length, 1);
  assert.equal(cov.features.filter((f) => f.properties.kind === "arrow").length, 2);
});

test("unmatched oids with coverage are drawn grey-flagged, not selectable (empty eid)", () => {
  const g = parseDetectorGeo(c6);
  const dots = buildUnmatchedFeatures([{ oid: "5001", flow: 40 }], g);
  assert.equal(dots[0].properties.cov, true);
  const f = buildUnmatchedCoverage([{ oid: "5001", flow: 40 }], g);
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.properties.status === "unmatched" && x.properties.eid === ""));
});

// ---------- glyph images ----------
test("SDF glyphs: north-pointing arrow, solid inside, empty outside, RGBA sized for the icon", () => {
  const arrow = makeArrowImage();
  assert.equal(arrow.width, GLYPH_SIZE);
  assert.equal(arrow.data.length, GLYPH_SIZE * GLYPH_SIZE * 4);
  const alpha = (img: typeof arrow, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3];
  assert.ok(alpha(arrow, 32, 40) > 191, "shaft is inside");
  assert.ok(alpha(arrow, 32, 20) > 191, "head is inside");
  assert.equal(alpha(arrow, 2, 2), 0, "corner is empty");
  assert.ok(alpha(arrow, 14, 52) < 100, "left of the shaft, below the head, is outside");
  // north-pointing: the tip is the topmost vertex of the polygon
  assert.equal(Math.min(...ARROW_POLYGON.map((p) => p[1])), ARROW_POLYGON[0][1]);
  assert.ok(alpha(makeNeutralImage(), 32, 32) > 191);
});

// ---------- fake map ----------
class FakeMap {
  sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  layers = new Map<string, Record<string, any>>();
  images = new Map<string, { sdf?: boolean; pixelRatio?: number; width: number }>();
  listeners: Array<{ type: string; layer: string | null; fn: (e: any) => void }> = [];
  paint: Array<[string, string, unknown]> = [];
  layout: Array<[string, string, unknown]> = [];
  filters = new Map<string, unknown>();
  flown: unknown[] = [];
  zoom = 3;
  /** what queryRenderedFeatures returns (the test decides which symbols are rendered/placed) */
  rendered: Array<Record<string, any>> = [];
  queries: Array<{ box: unknown; layers: string[] | undefined }> = [];
  addSource(id: string, s: Record<string, unknown>) {
    const rec = { data: s.data, setData: (d: unknown) => void (rec.data = d) };
    this.sources.set(id, rec);
  }
  getSource(id: string) { return this.sources.get(id); }
  removeSource(id: string) { this.sources.delete(id); }
  addLayer(l: Record<string, any>) { this.layers.set(l.id, l); }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  setPaintProperty(layer: string, prop: string, v: unknown) { this.paint.push([layer, prop, v]); this.layers.get(layer)!.paint[prop] = v; }
  setLayoutProperty(layer: string, prop: string, v: unknown) { this.layout.push([layer, prop, v]); (this.layers.get(layer)!.layout ??= {})[prop] = v; }
  setFilter(layer: string, f: unknown) { this.filters.set(layer, f); }
  addImage(id: string, img: { width: number }, o?: { sdf?: boolean; pixelRatio?: number }) { this.images.set(id, { ...o, width: img.width }); }
  hasImage(id: string) { return this.images.has(id); }
  removeImage(id: string) { this.images.delete(id); }
  on(type: string, a: unknown, b?: unknown) {
    this.listeners.push(typeof a === "string" ? { type, layer: a, fn: b as never } : { type, layer: null, fn: a as never });
  }
  off(type: string, a: unknown, b?: unknown) {
    const layer = typeof a === "string" ? a : null;
    const fn = (typeof a === "string" ? b : a) as unknown;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.layer === layer && l.fn === fn));
  }
  getContainer() { return {} as HTMLElement; }
  getCanvas() { return { style: {} } as HTMLCanvasElement; }
  getZoom() { return this.zoom; }
  flyTo(o: unknown) { this.flown.push(o); }
  queryRenderedFeatures(box: unknown, o?: { layers?: string[] }) {
    this.queries.push({ box, layers: o?.layers });
    return this.rendered.filter((f) => !o?.layers || o.layers.includes(f.layer?.id));
  }
  project(c: [number, number]) { return { x: (c[0] - 55) * 1e5, y: (25 - c[1]) * 1e5 }; }
  /** setStyle(): sources, layers and images vanish; layer-bound listeners stay registered; styledata fires. */
  reloadStyle() {
    this.sources.clear();
    this.layers.clear();
    this.images.clear();
    for (const l of this.listeners.filter((x) => x.type === "styledata")) l.fn({});
  }
  /** map-level (layer-less) event, as MapLibre fires click / mousemove / mouseout */
  fireMap(type: string, e: any) { for (const l of this.listeners.filter((x) => x.type === type && x.layer === null)) l.fn(e); }
  fire(type: string, layer: string, e: any) { for (const l of this.listeners.filter((x) => x.type === type && x.layer === layer)) l.fn(e); }
}

const STYLE = { radius: ["interpolate", ["linear"], ["sqrt", ["get", "sim"]], 0, 3, 10, 16], color: "#41ab5d" };

function mount(map = new FakeMap()) {
  const reg: Array<{ id: string; nativeLayerIds: string[]; sourceIds?: string[]; paintBridge?: any }> = [];
  const unreg: string[] = [];
  const selected: string[] = [];
  const app = { getMap: () => map as never, registerExternalNativeLayer: (l: any) => void reg.push(l), unregisterExternalNativeLayer: (id: string) => void unreg.push(id) };
  const layer = new DetectorMapLayer(app as never, "cm", "Counts", { describe: () => ["x"], onSelect: (e) => void selected.push(e) }, STYLE);
  return { map, layer, reg, unreg, selected };
}

function c6Data() {
  const g = parseDetectorGeo(c6);
  const aggs = aggregateDetectors(C6_ROWS);
  return { fc: buildFeatures(aggs, g).fc, coverage: buildCoverage(aggs, g), g, aggs };
}

test("coverage package: dots + coverage source, fill/outline/arrow layers, SDF images, zoom expressions", () => {
  const { map, layer, reg } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  assert.deepEqual([...map.sources.keys()].sort(), ["cm-cov-src", "cm-sel-src", "cm-src"]);
  assert.deepEqual([...map.layers.keys()].sort(), ["cm-arrows", "cm-arrows-sel", "cm-cov-fill", "cm-cov-line", "cm-cov-sel", "cm-pts", "cm-sel"]);
  assert.equal(map.sources.size, 3, "few sources for ~300 detectors: dots, coverage+arrows, selection");
  // images: SDF, registered once each
  assert.deepEqual([...map.images.keys()].sort(), ["cm-arrow", "cm-neutral"]);
  assert.ok([...map.images.values()].every((i) => i.sdf === true && i.pixelRatio === 2));
  // arrows
  const arrows = map.layers.get("cm-arrows")!;
  assert.equal(arrows.type, "symbol");
  assert.deepEqual(arrows.layout["icon-rotate"], ["to-number", ["get", "bearing_deg"], 0]);
  assert.equal(arrows.layout["icon-rotation-alignment"], "map");
  assert.equal(arrows.layout["icon-pitch-alignment"], "map");
  assert.deepEqual(arrows.layout["icon-allow-overlap"], arrowAllowOverlap());
  assert.deepEqual(arrows.layout["icon-image"], ["match", ["get", "glyph"], "arrow", "cm-arrow", "cm-neutral"]);
  assert.deepEqual(arrows.filter, ["==", ["get", "kind"], "arrow"]);
  const size = arrows.layout["icon-size"] as unknown[];
  assert.equal(size[0], "interpolate");
  assert.deepEqual(size[2], ["zoom"], "icon-size is a zoom expression");
  assert.equal(arrows.minzoom, undefined, "glyphs are drawn at every zoom");
  // colour: the same metric colour as the circles
  assert.equal(arrows.paint["icon-color"], map.layers.get("cm-pts")!.paint["circle-color"]);
  assert.equal(map.layers.get("cm-cov-fill")!.paint["fill-color"], STYLE.color);
  assert.equal(map.layers.get("cm-cov-fill")!.type, "fill");
  assert.equal(map.layers.get("cm-cov-line")!.type, "line");
  // dots: constant opacity, and only for detectors without a coverage glyph (no double drawing)
  const dots = map.layers.get("cm-pts")!;
  assert.equal(dots.paint["circle-opacity"], 0.85);
  assert.equal("circle-stroke-opacity" in dots.paint, false);
  assert.deepEqual(dots.filter, ["!=", ["get", "cov"], true]);
  // registered into the Layers panel with every native layer and source
  const r = reg.at(-1)!;
  assert.deepEqual([...r.nativeLayerIds].sort(), [...map.layers.keys()].sort());
  assert.deepEqual([...r.sourceIds!].sort(), [...map.sources.keys()].sort());
});

test("old Point-only package renders exactly as before: two sources, two layers, no images, plain opacity", () => {
  const { map, layer, reg } = mount();
  const g = parseDetectorGeo(legacy);
  const { fc } = buildFeatures(aggregateDetectors([row("E1", 10)]), g);
  layer.update(fc, STYLE, buildCoverage([], g));
  assert.deepEqual([...map.sources.keys()].sort(), ["cm-sel-src", "cm-src"]);
  assert.deepEqual([...map.layers.keys()].sort(), ["cm-pts", "cm-sel"]);
  assert.equal(map.images.size, 0);
  const paint = map.layers.get("cm-pts")!.paint;
  assert.equal(paint["circle-opacity"], 0.85);
  assert.equal(paint["circle-radius"], STYLE.radius);
  assert.equal("circle-stroke-opacity" in paint, false);
  assert.deepEqual(map.listeners.filter((l) => l.layer === null && l.type !== "styledata").map((l) => l.type).sort(), ["click", "mouseout", "mousemove"].sort(), "map-level pointer handlers");
  assert.equal(map.listeners.filter((l) => l.layer !== null).length, 0);
  assert.deepEqual(reg.at(-1)!.nativeLayerIds, ["cm-pts", "cm-sel"]);
});

test("metric/filter changes update paint and data; an identical update touches nothing", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const n = map.paint.length;
  const setData = map.sources.get("cm-src")!.data;
  layer.update(fc, STYLE, coverage);
  assert.equal(map.paint.length, n, "no repaint when nothing changed");
  assert.equal(map.sources.get("cm-src")!.data, setData);
  layer.update(fc, { radius: 9, color: "#c62828" }, coverage);
  assert.equal(map.layers.get("cm-pts")!.paint["circle-color"], "#c62828");
  assert.equal(map.layers.get("cm-cov-fill")!.paint["fill-color"], "#c62828");
  assert.equal(map.layers.get("cm-arrows")!.paint["icon-color"], "#c62828");
  assert.deepEqual(map.layers.get("cm-arrows")!.layout["icon-size"], arrowSize(9));
  assert.deepEqual(map.layers.get("cm-arrows")!.layout["symbol-sort-key"], arrowSortKey(9));
  assert.deepEqual(map.layers.get("cm-arrows-sel")!.layout["icon-size"], arrowSize(9, 1.7));
  assert.deepEqual(map.layers.get("cm-cov-line")!.paint["line-width"], coverageLineWidth(9));
});

test("a run without coverage after one with coverage empties the coverage data and restores plain dot opacity", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const g = parseDetectorGeo(legacy);
  layer.update(buildFeatures(aggregateDetectors([row("E1", 10)]), g).fc, STYLE, buildCoverage([], g));
  assert.equal((map.sources.get("cm-cov-src")!.data as { features: unknown[] }).features.length, 0);
  assert.equal(map.layers.get("cm-pts")!.paint["circle-opacity"], 0.85);
  assert.equal(map.filters.get("cm-pts"), null, "every dot is drawn again when the run has no coverage");
});

test("style reload re-adds sources, layers and images without duplicating listeners", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const before = map.listeners.length;
  map.reloadStyle();
  assert.deepEqual([...map.sources.keys()].sort(), ["cm-cov-src", "cm-sel-src", "cm-src"]);
  assert.equal(map.layers.size, 7);
  assert.deepEqual([...map.images.keys()].sort(), ["cm-arrow", "cm-neutral"]);
  assert.equal(map.listeners.length, before, "map-level pointer handlers survive setStyle and are not registered twice");
  assert.deepEqual(map.layers.get("cm-arrows")!.layout["icon-allow-overlap"], arrowAllowOverlap(), "layout is re-applied");
  assert.equal((map.sources.get("cm-cov-src")!.data as { features: unknown[] }).features.length, coverage.features.length);
  // a point-only layer survives the reload too
  const p = mount();
  const g = parseDetectorGeo(legacy);
  p.layer.update(buildFeatures(aggregateDetectors([row("E1", 10)]), g).fc, STYLE);
  p.map.reloadStyle();
  assert.equal(p.map.layers.size, 2);
  assert.equal(p.map.images.size, 0);
});

const at = (x = 100, y = 100) => ({ point: { x, y } });

test("click on polygon, arrow or dot selects the eid via a bbox query; empty eid (unmatched) and misses are safe", () => {
  const { map, layer, selected } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  map.rendered = [{ layer: { id: "cm-cov-fill" }, properties: { eid: "C6_FWD", oid: "5001" } }];
  map.fireMap("click", at());
  map.rendered = [{ layer: { id: "cm-arrows" }, properties: { eid: "J383_A", oid: "5004" } }];
  map.fireMap("click", at());
  map.rendered = [{ layer: { id: "cm-pts" }, properties: { eid: "C6_REV" } }];
  map.fireMap("click", at());
  map.rendered = [{ layer: { id: "cm-cov-fill" }, properties: { eid: "" } }];
  map.fireMap("click", at());
  map.rendered = [];
  map.fireMap("click", at());
  assert.deepEqual(selected, ["C6_FWD", "J383_A", "C6_REV"]);
  assert.deepEqual(map.queries[0].box, hitBox({ x: 100, y: 100 }), "a small box around the pointer, not a point");
  assert.deepEqual(map.queries[0].layers!.sort(), ["cm-arrows", "cm-cov-fill", "cm-pts"], "only the interactive layers (never the selection underlay)");
  assert.deepEqual(map.listeners.filter((x) => x.layer === null && x.type !== "styledata").map((x) => x.type).sort(), ["click", "mousemove", "mouseout"]);
  map.fireMap("mouseout", {});
});

test("hit-testing: a click next to a tiny arrow selects it; an unmatched symbol or the polygon below never steals the click", () => {
  const { map, layer, selected } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  // a polygon (top of the stack by order of the query result), an unmatched arrow and two arrows 3 px / 7 px away
  map.rendered = [
    { layer: { id: "cm-cov-fill" }, geometry: { type: "Polygon", coordinates: [] }, properties: { eid: "POLY" } },
    { layer: { id: "cm-arrows" }, geometry: { type: "Point", coordinates: [55, 25] }, properties: { eid: "" } },
    { layer: { id: "cm-arrows" }, geometry: { type: "Point", coordinates: [55.00007, 25] }, properties: { eid: "FAR" } },
    { layer: { id: "cm-arrows" }, geometry: { type: "Point", coordinates: [55.00003, 25] }, properties: { eid: "NEAR" } },
  ];
  map.fireMap("click", { point: { x: 0, y: 0 } });
  assert.deepEqual(selected, ["NEAR"]);
  // hover on the unmatched one alone still resolves (tooltip), but selects nothing
  map.rendered = [{ layer: { id: "cm-arrows" }, geometry: { type: "Point", coordinates: [55, 25] }, properties: { eid: "" } }];
  map.fireMap("click", { point: { x: 0, y: 0 } });
  assert.deepEqual(selected, ["NEAR"]);
  // collided (unplaced) symbols are not returned by MapLibre, so they cannot be hit
  map.rendered = [];
  map.fireMap("click", at());
  assert.deepEqual(selected, ["NEAR"]);
});

test("pickFeature: eid beats unmatched, glyph beats dot beats polygon, then nearest; no features -> null", () => {
  const order = ["a", "p", "f"];
  const f = (layer: string, eid: string, x?: number) => ({ layer: { id: layer }, properties: { eid }, ...(x === undefined ? {} : { geometry: { type: "Point", coordinates: [x, 0] as [number, number] } }) });
  const project = (c: [number, number]) => ({ x: c[0], y: 0 });
  assert.equal(pickFeature([], { x: 0, y: 0 }, order), null);
  assert.equal(pickFeature([f("f", "P"), f("p", "D"), f("a", "A", 5)], { x: 0, y: 0 }, order, project)!.properties!.eid, "A");
  assert.equal(pickFeature([f("a", "", 0), f("f", "P")], { x: 0, y: 0 }, order, project)!.properties!.eid, "P");
  assert.equal(pickFeature([f("a", "A1", 6), f("a", "A2", 2)], { x: 0, y: 0 }, order, project)!.properties!.eid, "A2");
  assert.equal(pickFeature([f("a", "", 3)], { x: 0, y: 0 }, order, project)!.properties!.eid, "", "tooltip-only fallback");
  assert.deepEqual(hitBox({ x: 10, y: 20 }), [[10 - HIT_PX, 20 - HIT_PX], [10 + HIT_PX, 20 + HIT_PX]]);
});

test("selected highlight: halo at the anchor plus the eid's coverage outline", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  assert.deepEqual(map.filters.get("cm-cov-sel") ?? map.layers.get("cm-cov-sel")!.filter, selectedAreaFilter(null));
  layer.setSelected([55.2, 25.1], "J383_A");
  assert.deepEqual(map.filters.get("cm-cov-sel"), selectedAreaFilter("J383_A"));
  assert.equal((map.sources.get("cm-sel-src")!.data as { features: unknown[] }).features.length, 1);
  assert.deepEqual(map.filters.get("cm-arrows-sel"), selectedArrowFilter("J383_A"), "the selected detector's glyph is highlighted");
  layer.setSelected(null);
  assert.deepEqual(map.filters.get("cm-cov-sel"), selectedAreaFilter(null));
  assert.deepEqual(map.filters.get("cm-arrows-sel"), selectedArrowFilter(null));
  // the selection survives a style reload
  layer.setSelected([55.2, 25.1], "C6_FWD");
  map.reloadStyle();
  assert.deepEqual(map.layers.get("cm-cov-sel")!.filter, selectedAreaFilter("C6_FWD"));
  assert.deepEqual(map.layers.get("cm-arrows-sel")!.filter, selectedArrowFilter("C6_FWD"));
  const under = map.layers.get("cm-arrows-sel")!;
  assert.equal(under.paint["icon-color"], "#0b57d0");
  assert.equal(under.layout["icon-allow-overlap"], true, "the selected glyph is always drawn");
  assert.deepEqual([...map.layers.keys()].filter((k) => k.endsWith("arrows") || k.endsWith("arrows-sel")), ["cm-arrows-sel", "cm-arrows"], "underlay below the glyph: reads as an outline");
});

test("visibility toggle and opacity reach every layer", () => {
  const { map, layer, reg } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const bridge = reg.at(-1)!.paintBridge;
  bridge.setVisibility(false);
  assert.ok([...map.layers.values()].every((l) => l.layout?.visibility === "none"));
  bridge.setVisibility(true);
  assert.ok([...map.layers.values()].every((l) => l.layout?.visibility === "visible"));
  bridge.setOpacity(0.5);
  assert.deepEqual(map.layers.get("cm-pts")!.paint["circle-opacity"], dotOpacity(0.5));
  assert.equal(map.layers.get("cm-arrows")!.paint["icon-opacity"], arrowOpacity(0.5));
  assert.equal(map.layers.get("cm-arrows")!.paint["icon-opacity"], 0.5, "constant opacity, no zoom fade");
});

test("dispose removes every layer, source, image and listener, and unregisters the native layer", () => {
  const { map, layer, reg, unreg } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  assert.ok(map.listeners.length > 0);
  layer.dispose();
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.images.size, 0);
  assert.equal(map.listeners.length, 0);
  assert.deepEqual(unreg, [reg[0].id]);
  layer.update(fc, STYLE, coverage); // late update after dispose
  assert.equal(map.sources.size, 0);
});

test("a map without addImage still gets coverage fill/outline, just no arrows", () => {
  const map = new FakeMap();
  (map as { addImage?: unknown }).addImage = undefined;
  const { layer } = mount(map);
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  assert.equal(map.layers.has("cm-arrows"), false);
  assert.equal(map.layers.has("cm-cov-fill"), true);
});

test("zoomTo goes close enough to see the coverage only when there is coverage", () => {
  const a = mount();
  const { fc, coverage } = c6Data();
  a.layer.update(fc, STYLE, coverage);
  a.layer.zoomTo(55.2, 25.1);
  assert.equal((a.map.flown[0] as { zoom: number }).zoom, ZOOM.focus);
  assert.equal(ZOOM.focus, 17.5);
  const b = mount();
  b.layer.update(buildFeatures([], null).fc, STYLE);
  b.layer.zoomTo(55.2, 25.1);
  assert.equal((b.map.flown[0] as { zoom: number }).zoom, 16);
});

// ---------- C14: arrows at all zooms ----------
test("arrow layer: no minzoom/maxzoom, constant opacity, screen-pixel size expression, metric colour", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const arrows = map.layers.get("cm-arrows")!;
  assert.equal("minzoom" in arrows, false);
  assert.equal("maxzoom" in arrows, false);
  assert.equal(arrows.paint["icon-opacity"], 0.85, "no zoom fade");
  assert.equal(typeof arrows.paint["icon-opacity"], "number");
  const size = arrows.layout["icon-size"] as any[];
  assert.deepEqual(size.slice(0, 3), ["interpolate", ["linear"], ["zoom"]]);
  const flat = JSON.stringify(size);
  assert.ok(!/meter|metre|pitch|ln2|"\*",\s*"zoom"/i.test(flat), "no metres-to-pixels (2^zoom) conversion: the size is in screen px");
  // legible by z10..z14: 14-18 CSS px at z12 for a mid-ramp (radius 8) detector, mild growth afterwards
  const px12 = glyphHeightPx(8, 12);
  assert.ok(px12 >= 13 && px12 <= 18, `z12 mid glyph is ${px12}px`);
  assert.ok(glyphHeightPx(8, 10) >= 10 && glyphHeightPx(8, 14) <= 20);
  assert.ok(glyphHeightPx(8, 21) > glyphHeightPx(8, 12) && glyphHeightPx(8, 21) < 2 * glyphHeightPx(8, 12), "mild growth");
  // the metric ramp (radius) still drives the size
  assert.ok(glyphHeightPx(16, 12) > glyphHeightPx(8, 12) && glyphHeightPx(8, 12) > glyphHeightPx(3, 12));
  assert.equal(JSON.stringify(arrowSize(STYLE.radius)).includes("sqrt"), true, "radius ramp is embedded");
  assert.equal(arrows.paint["icon-color"], STYLE.color);
});

test("density control: collision below z15, everything drawn from z15; padding and ignore-placement follow", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const l = map.layers.get("cm-arrows")!.layout;
  assert.deepEqual(l["icon-allow-overlap"], ["step", ["zoom"], false, 15, true]);
  assert.deepEqual(l["icon-ignore-placement"], ["step", ["zoom"], false, 15, true], "placed glyphs must enter the collision index below z15");
  assert.deepEqual(l["icon-padding"], arrowPadding());
  assert.equal(ZOOM.overlapMin, 15);
  // evaluate the step like MapLibre does
  const stepAt = (e: any[], z: number) => (z >= e[3] ? e[4] : e[2]);
  assert.equal(stepAt(arrowAllowOverlap() as any[], 14.99), false);
  assert.equal(stepAt(arrowAllowOverlap() as any[], 15), true);
  assert.equal(stepAt(arrowIgnorePlacement() as any[], 8), false);
  assert.equal(stepAt(arrowPadding() as any[], 10) > 0 && stepAt(arrowPadding() as any[], 16) === 0, true);
});

test("symbol-sort-key: the largest flow/size wins a collision (lower key placed first)", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const key = map.layers.get("cm-arrows")!.layout["symbol-sort-key"];
  assert.deepEqual(key, ["*", -1, STYLE.radius]);
  assert.deepEqual(arrowSortKey(6), ["*", -1, ["to-number", ["get", "sim"], 0]], "constant radius (validation/comparison): by simulated flow");
  // an explicit key wins (e.g. worst GEH first)
  const custom = ["*", -1, ["get", "geh"]];
  const m2 = mount();
  m2.layer.update(fc, { ...STYLE, sortKey: custom }, coverage);
  assert.deepEqual(m2.map.layers.get("cm-arrows")!.layout["symbol-sort-key"], custom);
});

test("dots only for detectors without a coverage glyph; old Point-only packages draw every dot with no filter", () => {
  assert.deepEqual(dotFilter(true), ["!=", ["get", "cov"], true]);
  assert.equal(dotFilter(false), null);
  const { map, layer } = mount();
  const g = parseDetectorGeo(legacy);
  layer.update(buildFeatures(aggregateDetectors([row("E1", 10)]), g).fc, STYLE, buildCoverage([], g));
  assert.equal("filter" in map.layers.get("cm-pts")!, false);
  assert.equal(map.layers.get("cm-pts")!.paint["circle-radius"], STYLE.radius);
  assert.equal(map.layers.has("cm-arrows"), false);
  assert.equal(map.layers.has("cm-arrows-sel"), false);
  // coverage appearing later (run switch) filters the dots; disappearing restores them
  const d = c6Data();
  layer.update(d.fc, STYLE, d.coverage);
  assert.deepEqual(map.filters.get("cm-pts"), ["!=", ["get", "cov"], true]);
});

test("a map without queryRenderedFeatures cannot select (and does not throw)", () => {
  const map = new FakeMap();
  (map as { queryRenderedFeatures?: unknown }).queryRenderedFeatures = undefined;
  const { layer, selected } = mount(map);
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  map.fireMap("click", at());
  map.fireMap("mousemove", at());
  assert.deepEqual(selected, []);
});

test("hover moves resolve through the same query and leave resets the cursor", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  map.rendered = [];
  map.fireMap("mousemove", at());
  map.fireMap("mouseout", {});
  assert.equal(map.queries.length, 1);
});

// ---------- C14: tooltip direction ----------
test("tooltip direction line: bearing + cardinal for arrows, both ways for bidirectional, nothing when unknown", () => {
  const t = (_k: string, en: string, p?: Record<string, string | number>) => en.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(p?.[k]));
  assert.deepEqual(directionTip(t, { glyph: "arrow", bearing_deg: 75.3, direction: "forward" }), ["Direction: 75° (E)"]);
  assert.deepEqual(directionTip(t, { glyph: "arrow", bearing_deg: 255.3 }), ["Direction: 255° (W)"]);
  assert.deepEqual(directionTip(t, { glyph: "neutral", direction: "bidirectional", bearing_deg: 90 }), ["Direction: both ways"]);
  assert.deepEqual(directionTip(t, { glyph: "neutral", direction: "unknown", bearing_deg: null }), []);
  assert.deepEqual(directionTip(t, { eid: "dot" }), []);
  assert.equal(cardinal(359), "N");
  assert.equal(cardinal(-45), "NW");
});

// ---------- C14: legend ----------
test("legend model: colour ramp and size ramp with min/max, diverging for the difference mode", () => {
  const seq = countLegendModel({ colorBy: "sim", sizeBy: "sim", maxSize: 1200, maxColor: 1200, glyphs: true });
  assert.equal(seq.diverging, false);
  assert.deepEqual([seq.colorMin, seq.colorMax, seq.sizeMin, seq.sizeMax], [0, 1200, 0, 1200]);
  assert.equal(seq.colorStops.length, 3);
  assert.ok(seq.sizeMaxPx > seq.sizeMinPx);
  assert.ok(seq.colorTitle.en.includes("simulated flow") && seq.colorTitle.en.includes("veh/h"));
  const div = countLegendModel({ colorBy: "diff", sizeBy: "obs", maxSize: 800, maxColor: 150, glyphs: false });
  assert.equal(div.diverging, true);
  assert.deepEqual([div.colorMin, div.colorMax], [-150, 150]);
  assert.ok(div.sizeTitle.en.includes("observed"));
  assert.equal(div.sizeMinPx, 6, "dots: diameter of the 3 px radius");
  assert.equal(countLegendModel({ colorBy: "sim", sizeBy: "sim", maxSize: 0, maxColor: 0, glyphs: true }).colorMax, 1, "never a zero domain");
});

test("legend DOM: colour gradient, scale, size ramp, direction note (arrows) and none of it for dots-only packages", () => {
  const restore = installDomShim();
  try {
    const t = (_k: string, en: string) => en;
    const fmt = { int: (v: number | null | undefined) => (typeof v === "number" ? String(Math.round(v)) : "-") };
    const root = countLegend({ t, fmt }, { colorBy: "diff", sizeBy: "sim", maxSize: 1200, maxColor: 150, glyphs: true });
    const byId = (id: string) => root.querySelector(`[data-testid="${id}"]`)!;
    assert.equal(root.getAttribute("data-testid"), "count-legend");
    assert.ok(byId("legend-colour-ramp").getAttribute("style")!.startsWith("background:linear-gradient(to right, #2166ac"));
    assert.deepEqual(Array.from(byId("legend-colour-scale").children, (c) => c.textContent), ["-150", "0", "150"]);
    assert.ok(byId("legend-size-ramp").textContent.includes("1200"));
    assert.ok(byId("legend-size-ramp").textContent.includes("\u25B2"), "arrow glyph samples");
    assert.ok(byId("legend-direction").textContent.includes("direction of travel"));
    assert.ok(root.textContent.includes("Colour: difference sim - obs (veh/h)"));
    assert.ok(root.textContent.includes("Size: simulated flow (veh/h)"));
    const dots = countLegend({ t, fmt }, { colorBy: "sim", sizeBy: "obs", maxSize: 50, maxColor: 50, glyphs: false });
    assert.equal(dots.querySelector('[data-testid="legend-direction"]'), null);
    assert.equal(dots.querySelector('[data-testid="legend-size-ramp"]')!.textContent.includes("\u25B2"), false);
    assert.ok(directionNote({ t }).textContent.includes("Diamonds"));
  } finally {
    restore();
  }
});

// ---------- extents ----------
test("fit extent includes the polygon coverage of every oid, not just the anchors (RunFitter input)", () => {
  const g = parseDetectorGeo(c6);
  const aggs = aggregateDetectors(C6_ROWS);
  const pts = detectorExtentPoints(g, aggs);
  assert.ok(pts.length > aggs.length * 4, "ring vertices are included");
  const ring = c6.features[0].geometry.coordinates[0] as number[][];
  for (const v of ring) assert.ok(pts.some((p) => p[0] === v[0] && p[1] === v[1]));
  const multi = c6.features[4].geometry.coordinates as number[][][][];
  for (const poly of multi) for (const v of poly[0]) assert.ok(pts.some((p) => p[0] === v[0] && p[1] === v[1]), "MultiPolygon vertices too");
  // a single polygon detector is a real box (not a zero-size extent)
  const one = detectorExtentPoints(g, aggregateDetectors([row("C6_FWD", 5001)]));
  assert.ok(Math.max(...one.map((p) => p[0])) > Math.min(...one.map((p) => p[0])));
  // legacy Point-only: anchors only
  const lg = parseDetectorGeo(legacy);
  assert.deepEqual(detectorExtentPoints(lg, aggregateDetectors([row("E1", 10)])), [[55.1, 25.2]]);
  assert.deepEqual(detectorExtentPoints(null, aggs), []);
});

// ---------- real contract samples (when the lead drops them) ----------
const SAMPLES = process.env.CONTRACT_SAMPLES ?? fileURLToPath(new URL("../../../../../../../_tmp/scratch/contract_samples", import.meta.url));
const sampleFile = existsSync(SAMPLES) ? readdirSync(SAMPLES).find((f) => /detectors.*\.geojson$/i.test(f)) : undefined;
test("real contract sample detectors.geojson parses with coverage", { skip: !sampleFile && "no sample yet" }, () => {
  const g = parseDetectorGeo(JSON.parse(readFileSync(join(SAMPLES, sampleFile!), "utf8")));
  assert.ok(g.count > 0);
  assert.ok(g.parts.size > 0);
});
