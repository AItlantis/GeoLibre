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
import { arrowSize, coverageLineWidth, DetectorMapLayer, dotOpacity, selectedAreaFilter, ZOOM } from "../src/common/map-layer.ts";
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
  /** setStyle(): sources, layers and images vanish; layer-bound listeners stay registered; styledata fires. */
  reloadStyle() {
    this.sources.clear();
    this.layers.clear();
    this.images.clear();
    for (const l of this.listeners.filter((x) => x.type === "styledata")) l.fn({});
  }
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
  assert.deepEqual([...map.layers.keys()].sort(), ["cm-arrows", "cm-cov-fill", "cm-cov-line", "cm-cov-sel", "cm-pts", "cm-sel"]);
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
  assert.equal(arrows.layout["icon-allow-overlap"], true);
  assert.deepEqual(arrows.layout["icon-image"], ["match", ["get", "glyph"], "arrow", "cm-arrow", "cm-neutral"]);
  assert.deepEqual(arrows.filter, ["==", ["get", "kind"], "arrow"]);
  const size = arrows.layout["icon-size"] as unknown[];
  assert.equal(size[0], "interpolate");
  assert.deepEqual(size[2], ["zoom"], "icon-size is a zoom expression");
  assert.equal(arrows.minzoom, ZOOM.arrowMin);
  // colour: the same metric colour as the circles
  assert.equal(arrows.paint["icon-color"], map.layers.get("cm-pts")!.paint["circle-color"]);
  assert.equal(map.layers.get("cm-cov-fill")!.paint["fill-color"], STYLE.color);
  assert.equal(map.layers.get("cm-cov-fill")!.type, "fill");
  assert.equal(map.layers.get("cm-cov-line")!.type, "line");
  // dots stay until ~z16 then fade (only where a coverage exists)
  const dots = map.layers.get("cm-pts")!.paint["circle-opacity"] as any[];
  assert.deepEqual(dots.slice(0, 3), ["interpolate", ["linear"], ["zoom"]]);
  assert.equal(dots[3], 16);
  assert.equal(dots[5], 17.5);
  assert.deepEqual(dots[6], ["case", ["==", ["get", "cov"], true], 0, 0.85]);
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
  assert.equal(map.listeners.filter((l) => l.layer === "cm-pts").length, 3);
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
});

test("style reload re-adds sources, layers and images without duplicating listeners", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  const before = map.listeners.length;
  map.reloadStyle();
  assert.deepEqual([...map.sources.keys()].sort(), ["cm-cov-src", "cm-sel-src", "cm-src"]);
  assert.equal(map.layers.size, 6);
  assert.deepEqual([...map.images.keys()].sort(), ["cm-arrow", "cm-neutral"]);
  assert.equal(map.listeners.length, before, "layer listeners survive setStyle and are not registered twice");
  assert.equal((map.sources.get("cm-cov-src")!.data as { features: unknown[] }).features.length, coverage.features.length);
  // a point-only layer survives the reload too
  const p = mount();
  const g = parseDetectorGeo(legacy);
  p.layer.update(buildFeatures(aggregateDetectors([row("E1", 10)]), g).fc, STYLE);
  p.map.reloadStyle();
  assert.equal(p.map.layers.size, 2);
  assert.equal(p.map.images.size, 0);
});

test("click on polygon, arrow or dot selects the eid; empty eid (unmatched) and hover are safe", () => {
  const { map, layer, selected } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  map.fire("click", "cm-cov-fill", { features: [{ properties: { eid: "C6_FWD", oid: "5001" } }] });
  map.fire("click", "cm-arrows", { features: [{ properties: { eid: "J383_A", oid: "5004" } }] });
  map.fire("click", "cm-pts", { features: [{ properties: { eid: "C6_REV" } }] });
  map.fire("click", "cm-cov-fill", { features: [{ properties: { eid: "" } }] });
  map.fire("click", "cm-pts", { features: [] });
  assert.deepEqual(selected, ["C6_FWD", "J383_A", "C6_REV"]);
  for (const l of ["cm-pts", "cm-cov-fill", "cm-arrows"]) {
    assert.deepEqual(map.listeners.filter((x) => x.layer === l).map((x) => x.type).sort(), ["click", "mouseleave", "mousemove"]);
  }
  map.fire("mouseleave", "cm-arrows", {});
});

test("selected highlight: halo at the anchor plus the eid's coverage outline", () => {
  const { map, layer } = mount();
  const { fc, coverage } = c6Data();
  layer.update(fc, STYLE, coverage);
  assert.deepEqual(map.filters.get("cm-cov-sel") ?? map.layers.get("cm-cov-sel")!.filter, selectedAreaFilter(null));
  layer.setSelected([55.2, 25.1], "J383_A");
  assert.deepEqual(map.filters.get("cm-cov-sel"), selectedAreaFilter("J383_A"));
  assert.equal((map.sources.get("cm-sel-src")!.data as { features: unknown[] }).features.length, 1);
  layer.setSelected(null);
  assert.deepEqual(map.filters.get("cm-cov-sel"), selectedAreaFilter(null));
  // the selection survives a style reload
  layer.setSelected([55.2, 25.1], "C6_FWD");
  map.reloadStyle();
  assert.deepEqual(map.layers.get("cm-cov-sel")!.filter, selectedAreaFilter("C6_FWD"));
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
  assert.deepEqual(map.layers.get("cm-pts")!.paint["circle-opacity"], dotOpacity(0.5, true));
  assert.deepEqual(map.layers.get("cm-arrows")!.paint["icon-opacity"], ["interpolate", ["linear"], ["zoom"], ZOOM.arrowStart, 0, ZOOM.arrowEnd, 0.5]);
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
  assert.equal((a.map.flown[0] as { zoom: number }).zoom, 18);
  const b = mount();
  b.layer.update(buildFeatures([], null).fc, STYLE);
  b.layer.zoomTo(55.2, 25.1);
  assert.equal((b.map.flown[0] as { zoom: number }).zoom, 16);
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
