import test from "node:test";
import assert from "node:assert/strict";
import { OD_COLORS, barsGeoJson, barOffset, beforeAfterBarsGeoJson, barHeight, barSquare } from "../src/_od/map-logic.ts";
import {
  BAR_DEFAULTS, autoBarScale, barLegendInfo, centroidTotalsSql, labelFeatures, labelMinZoom, labelOffsetExpression, labelSizeExpression, labelTextField,
  layoutDomLabels, legendEntries, liftEm, mapHintText, niceTripsRef, nodesFromTotals, resolveLabelFont, topNNotice, tripsLayerIds, type NodeTotals,
} from "../src/_od/trips-map.ts";
import { MapOverlay, styleHasGlyphs } from "../src/_od/overlay.ts";
import { TRIPS_OVERLAY, createTripsView } from "../src/views/trips.ts";

const t = (_k: string, d: string, p?: Record<string, string | number>): string => d.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(p?.[k] ?? ""));
const fi = (n: number): string => Math.round(n).toLocaleString("en-US");

test("bars on hide the centroid / group / end dot layers; bars off show them", () => {
  const on = tripsLayerIds({ bars: true, grouped: false, lineStyle: "2d", labels: true });
  assert.deepEqual(on, ["lines", "bars", "labels"]);
  for (const dot of ["centroids", "groups", "ends"]) assert.ok(!on.includes(dot), dot);
  assert.deepEqual(tripsLayerIds({ bars: true, grouped: true, lineStyle: "3d", labels: false }), ["3d-lines", "bars"]);
  assert.deepEqual(tripsLayerIds({ bars: false, grouped: false, lineStyle: "2d", labels: true }), ["centroids", "lines", "ends", "labels"]);
  assert.deepEqual(tripsLayerIds({ bars: false, grouped: true, lineStyle: "3d", labels: false }), ["groups", "3d-lines", "ends"]);
});

test("every layer id the view can ask for exists in TRIPS_OVERLAY", () => {
  const ids = new Set(TRIPS_OVERLAY.map((s) => s.id));
  for (const bars of [true, false]) for (const grouped of [true, false]) for (const lineStyle of ["2d", "3d"] as const)
    for (const id of tripsLayerIds({ bars, grouped, lineStyle, labels: true })) assert.ok(ids.has(id), id);
  assert.equal(TRIPS_OVERLAY.find((s) => s.id === "labels")?.type, "symbol");
});

test("bars: origin/destination offsets scale with size and never overlap; colours unified", () => {
  for (const size of [24, 50, 120, 400]) {
    const off = barOffset(size);
    assert.ok(off > size / 2, `offset ${off} must exceed half the side ${size / 2}`);
    const fc = barsGeoJson([{ id: "x", name: "X", lon: 2, lat: 41, origins: 5000, destinations: 3000 }], 3, 400, false, size);
    const [o, d] = fc.features.map((f) => (f.geometry as any).coordinates[0] as number[][]);
    const oMaxLon = Math.max(...o.map((p) => p[0])), dMinLon = Math.min(...d.map((p) => p[0]));
    assert.ok(oMaxLon < dMinLon, "origin prism must end before the destination prism starts");
    const metres = (dMinLon - oMaxLon) * 111320 * Math.cos(41 * Math.PI / 180);
    assert.ok(metres > 0.05 * size - 1e-6, `gap ${metres}`);
  }
  const fc = barsGeoJson([{ id: "x", name: "X", lon: 0, lat: 0, origins: 10, destinations: 20 }], 3, 400);
  assert.deepEqual(fc.features.map((f) => f.properties.c), [OD_COLORS.origin, OD_COLORS.destination]);
  assert.equal(OD_COLORS.origin, "#e66100");
  assert.equal(OD_COLORS.destination, "#1c71d8");
  assert.equal(OD_COLORS.both, "#7e3fa8");
  assert.equal(barSquare(0, 0, 0, 50).length, 5);
  const ba = beforeAfterBarsGeoJson([{ id: "x", name: "X", lon: 0, lat: 0, prodBefore: 1, prodAfter: 2, attrBefore: 3, attrAfter: 4 }], 1, 10);
  assert.equal(ba.features[1].properties.c, OD_COLORS.origin);
  assert.equal(ba.features[3].properties.c, OD_COLORS.destination);
  assert.ok(!JSON.stringify([fc, ba]).match(/2878c8|29934a/i));
});

test("default bar size is larger and auto scale makes the tallest bar ~150 m", () => {
  assert.ok(BAR_DEFAULTS.size >= 40 && BAR_DEFAULTS.size <= 60);
  assert.ok(BAR_DEFAULTS.cap > 250);
  for (const max of [800, 12_345, 2_000_000]) {
    const s = autoBarScale(max);
    assert.ok(Math.abs(barHeight(max, s, 1e9) - 150) < 1e-6, String(max));
    const sl = autoBarScale(max, 150, true);
    assert.ok(Math.abs(barHeight(max, sl, 1e9, true) - 150) < 1e-6, `log ${max}`);
  }
});

test("height legend: nice reference trips, height in metres, capped flag", () => {
  assert.equal(niceTripsRef(48_000), 20_000);
  assert.equal(niceTripsRef(100_000), 100_000);
  assert.equal(niceTripsRef(7), 5);
  assert.equal(niceTripsRef(0), 1);
  const info = barLegendInfo(30_000, autoBarScale(30_000), 400, false);
  assert.equal(info.refTrips, 20_000);
  assert.equal(info.heightM, 100);
  assert.equal(barLegendInfo(30_000, 100, 400, false).capped, true);
  const lg = legendEntries({ bars: true, labels: true, grouped: false, lineStyle: "2d", barInfo: info, fmtInt: fi, t });
  assert.ok(lg.some((e) => e.key === "bar-scale" && e.text === "20,000 trips = 100 m"));
});

test("label features use the FULL selection totals, formatted, sorted by total, ranked", () => {
  const nodes: NodeTotals[] = [
    { id: "a", name: "Alpha", lon: 1, lat: 1, out: 1234567, in: 89 },
    { id: "b", name: "Beta", lon: 2, lat: 2, out: 10, in: 5 },
    { id: "z", name: "Zero", lon: 3, lat: 3, out: 0, in: 0 },
    { id: "n", name: "NoCoord", lon: NaN, lat: 3, out: 99, in: 99 },
    { id: "c", name: "", lon: 4, lat: 4, out: 500, in: 600 },
  ];
  const f = labelFeatures(nodes, { fmtInt: fi, barHeightM: (n) => (n.id === "a" ? 149.6 : 0) });
  assert.deepEqual(f.map((x) => x.properties.id), ["a", "c", "b"]);
  const a = f[0].properties;
  assert.equal(a.name, "Alpha");
  assert.equal(a.out_s, "out 1,234,567");
  assert.equal(a.in_s, "in 89");
  assert.equal(a.total, 1234656);
  assert.equal(a.hm, 150);
  const sk = f.map((x) => Number(x.properties.sk));
  assert.ok(sk[0] < sk[1] && sk[1] < sk[2], "largest wins collisions (lowest sort key)");
  assert.equal(f[1].properties.name, "c", "falls back to the id");
  assert.equal(a.tip, "Alpha\nout 1,234,567 / in 89");
  assert.deepEqual(f.map((x) => x.properties.rank), [0, 1, 2]);
  assert.equal(labelFeatures(nodes, { fmtInt: fi, maxLabels: 1 }).length, 1);
  // top-K by zoom: big ranks only from higher zoom
  assert.equal(labelMinZoom(0), 0);
  assert.ok(labelMinZoom(10) > labelMinZoom(0));
  assert.ok(labelMinZoom(500) >= labelMinZoom(100));
});

test("full-selection totals SQL and mapping (not the top-N pairs)", () => {
  const sql = centroidTotalsSql("v_od_before_norm", "t.trips >= 1");
  assert.match(sql, /UNION ALL/);
  assert.equal((sql.match(/WHERE t\.trips >= 1/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /LIMIT/i);
  assert.doesNotMatch(centroidTotalsSql("v", ""), /WHERE/);
  const nodes = nodesFromTotals([{ id: "1", out_trips: "10", in_trips: 4 }, { id: "2", out_trips: 1, in_trips: 1 }, { id: "9", out_trips: 1, in_trips: 1 }], [
    { id: "1", name: "One", lon: 1, lat: 2 }, { id: "2", name: "Two", lon: null, lat: null },
  ]);
  assert.deepEqual(nodes, [{ id: "1", name: "One", lon: 1, lat: 2, out: 10, in: 4 }]);
});

test("label layout expressions: collision props and valid structure", () => {
  const off = labelOffsetExpression(100) as any[];
  assert.equal(off[0], "step");
  assert.deepEqual(off[1], ["zoom"]);
  const inner = off[2] as any[];
  assert.equal(inner[0], "step");
  assert.deepEqual(inner[1], ["get", "hm"]);
  assert.deepEqual(inner[2], ["literal", [0, -0.6]]);
  assert.ok(liftEm(150, 14) > liftEm(0, 14) && liftEm(150, 16) > liftEm(150, 14));
  const size = labelSizeExpression() as any[];
  assert.deepEqual(size[1], ["zoom"]);
  assert.deepEqual(size[2][0], "case");
  const tf = labelTextField() as any[];
  assert.equal(tf[0], "format");
  assert.ok(JSON.stringify(tf).includes(OD_COLORS.origin) && JSON.stringify(tf).includes(OD_COLORS.destination));
});

test("font stack is borrowed from the style; glyph detection", () => {
  assert.deepEqual(resolveLabelFont([{ type: "fill" }, { type: "symbol", layout: { "text-field": "{name}", "text-font": ["Noto Sans Bold"] } }]), ["Noto Sans Bold"]);
  assert.deepEqual(resolveLabelFont([{ type: "symbol", layout: { "text-field": "x", "text-font": ["literal", ["Open Sans Regular"]] } }]), ["Open Sans Regular"]);
  assert.deepEqual(resolveLabelFont([]), ["Noto Sans Regular"]);
  assert.equal(styleHasGlyphs({ getStyle: () => ({ glyphs: "https://x/{fontstack}/{range}.pbf" }) } as any), true);
  assert.equal(styleHasGlyphs({ getStyle: () => ({ layers: [] }) } as any), false);
  assert.equal(styleHasGlyphs({ getStyle: () => { throw new Error("loading"); } } as any), true);
});

test("DOM label fallback: collision, top-K by zoom, lift above bars", () => {
  const items = [
    { id: "big", x: 100, y: 100, sk: -1000, minz: 0, lift: 20 },
    { id: "near", x: 130, y: 110, sk: -10, minz: 0, lift: 20 },
    { id: "far", x: 400, y: 300, sk: -5, minz: 0, lift: 0 },
    { id: "late", x: 300, y: 50, sk: -1, minz: 13, lift: 0 },
    { id: "off", x: 5000, y: 50, sk: -1, minz: 0, lift: 0 },
  ];
  const out = layoutDomLabels(items, 10, { w: 800, h: 600 });
  assert.deepEqual(out.map((o) => o.id), ["big", "far"]);
  assert.equal(out[0].y, 80, "label sits above the bar");
  assert.deepEqual(layoutDomLabels(items, 14, { w: 800, h: 600 }).map((o) => o.id), ["big", "far", "late"]);
});

test("legend lists bars, lines, labels and dots; group hint no longer mentions grey dots", () => {
  const base = { labels: true, fmtInt: fi, t, lineStyle: "2d" as const };
  const bars = legendEntries({ ...base, bars: true, grouped: false });
  assert.deepEqual(bars.filter((e) => e.kind === "bar").map((e) => e.color), [OD_COLORS.origin, OD_COLORS.destination]);
  assert.ok(bars.some((e) => e.kind === "line") && bars.some((e) => e.key === "labels"));
  assert.ok(!bars.some((e) => e.kind === "dot"));
  const dots = legendEntries({ ...base, bars: false, grouped: false });
  assert.deepEqual(dots.filter((e) => e.kind === "dot").map((e) => e.color), [OD_COLORS.origin, OD_COLORS.destination, OD_COLORS.both]);
  assert.ok(legendEntries({ ...base, bars: false, grouped: true }).some((e) => /group/.test(e.text)));
  assert.ok(!legendEntries({ ...base, labels: false, bars: false, grouped: false }).some((e) => e.key === "labels"));
  assert.doesNotMatch(mapHintText({ grouped: true, bars: false, t }), /Grey dots/i);
  assert.match(mapHintText({ grouped: true, bars: false, t }), /group/i);
  assert.match(mapHintText({ grouped: false, bars: false, t }), /centroids/i);
});

test("top-N truncation is stated in centroid mode only", () => {
  assert.equal(topNNotice({ grouped: true, shown: 200, sharePct: "40%", t, fmtInt: fi }), null);
  assert.equal(topNNotice({ grouped: false, shown: 200, sharePct: "40%", t, fmtInt: fi }), "Showing the 200 largest pairs (40% of the selection's trips); dots, bars and labels use full-selection totals.");
});

test("unified colours in the trips view source (no legacy palette)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/views/trips.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/_od/map-logic.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /#2878c8|#29934a/i);
  assert.equal(typeof createTripsView, "function");
});

// ---- overlay symbol spec ----
function fakeMap(style: Record<string, unknown> | null) {
  const layers = new Map<string, any>();
  const sources = new Map<string, any>();
  const paints: Array<[string, string, unknown]> = [];
  return {
    layers, sources, paints,
    addSource: (id: string, spec: any) => void sources.set(id, { ...spec, setData() {} }),
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => void sources.delete(id),
    addLayer: (spec: any) => void layers.set(spec.id, spec),
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => void layers.delete(id),
    setLayoutProperty() {}, setPaintProperty: (l: string, k: string, v: unknown) => void paints.push([l, k, v]),
    on() {}, off() {}, getContainer: () => ({}), getCanvas: () => ({ style: {} }), getZoom: () => 12, flyTo() {},
    ...(style ? { getStyle: () => style } : {}),
  };
}
const specs = [{ id: "bars", source: "bars", type: "fill-extrusion" as const }, { id: "labels", source: "labels", type: "symbol" as const }];
const fc = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "a", name: "A", out_s: "out 1", in_s: "in 2", sk: -3, minz: 0, hm: 0 } }] };

test("overlay builds a symbol layer with collision, sort key, halo and text opacity", () => {
  const map = fakeMap({ glyphs: "https://f/{fontstack}/{range}.pbf", layers: [{ type: "symbol", layout: { "text-field": "{name}", "text-font": ["Noto Sans Italic"] } }] });
  const registered: any[] = [];
  const ov = new MapOverlay({ getMap: () => map as any, registerExternalNativeLayer: (l) => void registered.push(l) }, "od", "OD", specs);
  ov.setLayers(["bars", "labels"]);
  ov.set("labels", fc as any);
  const l = map.layers.get("od-labels");
  assert.ok(l, "symbol layer added");
  assert.equal(l.type, "symbol");
  assert.equal(l.layout["text-allow-overlap"], false);
  assert.equal(l.layout["text-optional"], true);
  assert.deepEqual(l.layout["symbol-sort-key"], ["get", "sk"]);
  assert.deepEqual(l.layout["text-font"], ["Noto Sans Italic"]);
  assert.equal(l.paint["text-halo-width"], 2);
  assert.ok(Array.isArray(l.paint["text-opacity"]));
  assert.ok(registered.at(-1).nativeLayerIds.includes("od-labels"));
  ov.setLayerOpacity("labels", 0.4);
  assert.equal(map.paints.at(-1)![1], "text-opacity");
  ov.dispose();
});

test("overlay skips the symbol layer (DOM fallback) when the style has no glyphs", () => {
  const map = fakeMap({ layers: [] });
  const registered: any[] = [];
  const ov = new MapOverlay({ getMap: () => map as any, registerExternalNativeLayer: (l) => void registered.push(l) }, "od", "OD", specs);
  ov.setLayers(["bars", "labels"]);
  ov.set("labels", fc as any);
  assert.equal(map.layers.has("od-labels"), false);
  assert.equal(map.layers.has("od-bars"), true, "other layers still drawn");
  assert.ok(!registered.at(-1).nativeLayerIds.includes("od-labels"));
  ov.dispose();
});
