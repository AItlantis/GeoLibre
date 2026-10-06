import assert from "node:assert/strict";
import test from "node:test";
import { parseTestudoAnimationManifest, parseTestudoPackageStructure } from "./testudo-package-data";
import { createTestudoLayerOwner } from "./testudo-package-renderer";
import { testudoVehiclePlaybackProvider } from "./testudo-vehicle-playback";
import { declaredDefaultCamera, networkBounds, validateTestudoCameraView } from "./testudo-camera";
import { TestudoFeatureBridge } from "../testudo-feature-bridge";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const collection = (kind: "LineString" | "Point") => ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: kind === "Point"
  ? { type: "Point", coordinates: [1, 2] } : { type: "LineString", coordinates: [[1, 2], [2, 3]] }, properties: {} }] });

function fakeCameraMap() {
  const sources = new Map<string, { definition: Record<string, unknown>; setData(data: unknown): void }>();
  const layers = new Map<string, Record<string, unknown>>();
  const layouts = new Map<string, unknown>(); const listeners = new Set<(event?: { originalEvent?: unknown }) => void>();
  const calls: Array<{ kind: string; value: unknown }> = [];
  let center: [number, number] = [0, 0]; let zoom = 1; let bearing = 0; let pitch = 0;
  return {
    calls, sources, layers, layouts,
    get listenerCount() { return listeners.size; },
    getCenter: () => ({ lng: center[0], lat: center[1] }), getZoom: () => zoom, getBearing: () => bearing, getPitch: () => pitch,
    jumpTo(options: { center: [number, number]; zoom: number; bearing: number; pitch: number }) {
      calls.push({ kind: "jumpTo", value: options }); center = options.center; zoom = options.zoom; bearing = options.bearing; pitch = options.pitch;
    },
    fitBounds(bounds: unknown, options: unknown) { calls.push({ kind: "fitBounds", value: { bounds, options } }); },
    on(_type: "movestart", listener: (event?: { originalEvent?: unknown }) => void) { listeners.add(listener); },
    off(_type: "movestart", listener: (event?: { originalEvent?: unknown }) => void) { listeners.delete(listener); },
    emitUserMove() { for (const listener of listeners) listener({ originalEvent: {} }); },
    getSource: (id: string) => sources.get(id),
    addSource(id: string, definition: Record<string, unknown>) { sources.set(id, { definition, setData(data) { this.definition.data = data; } }); },
    removeSource: (id: string) => { sources.delete(id); },
    getLayer: (id: string) => layers.get(id),
    addLayer(layer: Record<string, unknown>) { layers.set(String(layer.id), layer); },
    removeLayer: (id: string) => { layers.delete(id); },
    setLayoutProperty(id: string, name: string, value: unknown) { layouts.set(`${id}:${name}`, value); },
  };
}

async function openFakePackage(options: { map?: ReturnType<typeof fakeCameraMap>; geometry?: unknown; lanes?: unknown; nodes?: unknown; centroids?: unknown; metadata?: Record<string, unknown>; onReadGeometry?: () => void } = {}) {
  const files: Record<string, unknown> = {
    "manifest.json": { geometry: { sections: "geometry/sections.geojson", lanes: "geometry/lanes.geojson", base_networks: { nodes: "geometry/nodes.geojson" } }, model_inputs: { centroids: { path: "geometry/centroids.geojson" } }, ...(options.metadata ? { metadata: options.metadata } : {}) },
    "geolibre/package.json": { ...(options.metadata ? { defaultView: options.metadata.defaultView } : {}) },
    "geometry/sections.geojson": options.geometry ?? collection("LineString"),
    "geometry/lanes.geojson": options.lanes ?? collection("LineString"),
    "geometry/nodes.geojson": options.nodes ?? collection("Point"),
    "geometry/centroids.geojson": options.centroids ?? collection("Point"),
  };
  const session = await testudoVehiclePlaybackProvider.open({ packageId: "pkg", versionId: "v1", label: "Fixture", artifactEndpoint: "proxy", capabilities: [] },
    { tviewId: "main", packageId: "pkg", versionId: "v1", pluginId: "vehicle-playback", generation: 1 }, () => {}, async (path) => {
      if (path === "geometry/sections.geojson") options.onReadGeometry?.();
      if (!(path in files)) throw new Error(`Missing fixture: ${path}`);
      return bytes(files[path]);
    }, options.map ?? null);
  return session;
}

test("parses published package paths and sorted chunk ranges", () => {
  const structure = parseTestudoPackageStructure({ metadata: { dt: 0.5, n_ticks: 4 }, geometry: { sections: "geometry/sections.geojson", base_networks: { nodes: "geometry/nodes.geojson" } } },
    { animations: [{ manifestPath: "chunks/a/animation.json" }] });
  assert.equal(structure.sectionsPath, "geometry/sections.geojson");
  assert.equal(structure.lanesPath, null);
  assert.equal(structure.nodesPath, "geometry/nodes.geojson");
  assert.equal(structure.maxTick, 3);
  assert.deepEqual(parseTestudoAnimationManifest({ chunks: [
    { path: "b.json", start_tick: 2, end_tick: 3 }, { path: "a.json", start_tick: 0, end_tick: 1 },
  ] }).map((chunk) => chunk.path), ["a.json", "b.json"]);
});

test("layer owner removes only its generation's source and layers", () => {
  const sources = new Map<string, { setData(data: unknown): void }>(); const layers = new Map<string, unknown>();
  const map = {
    getSource: (id: string) => sources.get(id), addSource: (id: string, _source: Record<string, unknown>) => sources.set(id, { setData() {} }), removeSource: (id: string) => { sources.delete(id); },
    getLayer: (id: string) => layers.get(id), addLayer: (layer: Record<string, unknown>) => layers.set(String(layer.id), layer), removeLayer: (id: string) => { layers.delete(id); },
    setLayoutProperty() {},
  };
  const first = createTestudoLayerOwner(map, "first"); const second = createTestudoLayerOwner(map, "second");
  first.addGeoJson("sections", collection("LineString"), "line"); second.addGeoJson("sections", collection("LineString"), "line");
  first.remove();
  assert.equal(sources.has("first-sections"), false); assert.equal(sources.has("second-sections"), true);
  second.remove(); assert.equal(sources.size, 0); assert.equal(layers.size, 0);
});

test("provider loads network and animation chunks lazily in order and follows seek ticks", async () => {
  const reads: string[] = []; const sources = new Map<string, { data: any; setData(data: unknown): void }>(); const layers = new Map<string, unknown>();
  const map = {
    getSource: (id: string) => sources.get(id), addSource: (id: string, source: Record<string, unknown>) => sources.set(id, { data: source.data, setData(data) { this.data = data; } }), removeSource: (id: string) => { sources.delete(id); },
    getLayer: (id: string) => layers.get(id), addLayer: (layer: Record<string, unknown>) => layers.set(String(layer.id), layer), removeLayer: (id: string) => { layers.delete(id); }, setLayoutProperty() {},
  };
  const files: Record<string, unknown> = {
    "manifest.json": { metadata: { dt: 0.5, n_ticks: 4 }, geometry: { sections: "geometry/sections.geojson" } },
    "geolibre/package.json": { animations: [{ name: "base", scid: 10, manifestPath: "chunks/base/animation.json" }] },
    "chunks/base/animation.json": { chunks: [
      { path: "chunks/base/0.json", start_tick: 0, end_tick: 1 }, { path: "chunks/base/1.json", start_tick: 2, end_tick: 3 },
    ] },
    "geometry/sections.geojson": collection("LineString"),
    "chunks/base/0.json": { events: { "0": [{ event: "spawn", id: 7, state: { WorldX: 1, WorldY: 2 } }], "1": [{ event: "move", id: 7, state: { WorldX: 2, WorldY: 3 } }] } },
    "chunks/base/1.json": { events: { "2": [{ event: "spawn", id: 8, state: { WorldX: 3, WorldY: 4 } }] } },
  };
  const session = await testudoVehiclePlaybackProvider.open({ packageId: "pkg", versionId: "v1", label: "Fixture", artifactEndpoint: "proxy", capabilities: [] },
    { tviewId: "main", packageId: "pkg", versionId: "v1", pluginId: "vehicle-playback", generation: 1 }, () => {}, async (path) => {
      reads.push(path); if (!(path in files)) throw new Error(`Missing fixture: ${path}`); return bytes(files[path]);
    }, map);
  assert.deepEqual(reads.slice(-1), ["chunks/base/0.json"]);
  assert.equal(session.capabilities?.[0].available, true);
  assert.equal(session.capabilities?.find((item) => item.id === "network-kpi")?.available, false);
  assert.throws(() => session.setKpiGeometry?.("lanes", true), /Lane geometry is unavailable/);
  assert.equal(await session.setMapControl?.("legend", false), true);
  assert.equal(session.getMapControlState?.().legendVisible, false);
  await session.onPlaybackTick?.("main", 1, { available: true, loading: false, playing: false, tick: 2, maxTick: 3, speed: 1, dt: 0.5, loop: false });
  assert.deepEqual(reads.slice(-1), ["chunks/base/1.json"]);
  const positions = sources.get("testudo-main-1-vehicle-positions")?.data;
  assert.equal(positions.features.length, 2);
  assert.deepEqual(positions.features.map((feature: any) => feature.geometry.coordinates), [[2, 3], [3, 4]]);
  await session.dispose?.(); assert.equal(sources.size, 0); assert.equal(layers.size, 0);
});

test("provider fits the combined package network bounds once and retains zero pitch and bearing", async () => {
  const map = fakeCameraMap();
  const session = await openFakePackage({ map,
    geometry: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[1, 2], [2, 3]] }, properties: {} }] },
    nodes: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [4, 5] }, properties: {} }] },
    centroids: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-2, 0] }, properties: {} }] },
  });
  const fits = map.calls.filter((call) => call.kind === "fitBounds");
  assert.equal(fits.length, 1);
  assert.deepEqual((fits[0]!.value as { bounds: unknown }).bounds, [[-2, 0], [4, 5]]);
  assert.deepEqual((fits[0]!.value as { options: unknown }).options, { padding: 48, maxZoom: 16, bearing: 0, pitch: 0 });
  assert.equal(await session.setMapControl?.("legend", false), true);
  // Hiding the legend also hides the network sections layer, so sections report hidden until re-enabled.
  assert.deepEqual(await session.setKpiGeometry?.("lanes", true), { showLanes: true, showSections: false });
  assert.equal(map.layouts.get("testudo-main-1-network-lanes-layer:visibility"), "visible");
  assert.deepEqual(await session.setKpiGeometry?.("sections", false), { showLanes: true, showSections: false });
  assert.equal(map.calls.filter((call) => call.kind === "fitBounds").length, 1);
  assert.equal(map.listenerCount, 1);
  await session.dispose?.();
  assert.equal(map.listenerCount, 0);
});

test("provider honors a declared package camera and suppresses the initial fit after a user move", async () => {
  const declaredMap = fakeCameraMap();
  const declared = await openFakePackage({ map: declaredMap, metadata: { defaultView: { center: [-0.12, 51.5], zoom: 11, bearing: 20, pitch: 25 } } });
  assert.deepEqual(declaredMap.calls.map((call) => call.kind), ["jumpTo"]);
  assert.deepEqual(declaredMap.calls[0]!.value, { center: [-0.12, 51.5], zoom: 11, bearing: 20, pitch: 25 });
  await declared.dispose?.();

  const bboxMap = fakeCameraMap();
  const bounded = await openFakePackage({ map: bboxMap, metadata: { defaultView: { bbox: [-2, 40, 2, 44] } } });
  assert.deepEqual((bboxMap.calls[0]!.value as { bounds: unknown }).bounds, [[-2, 40], [2, 44]]);
  await bounded.dispose?.();

  const userMap = fakeCameraMap();
  const moved = await openFakePackage({ map: userMap, onReadGeometry: () => userMap.emitUserMove() });
  assert.equal(userMap.calls.filter((call) => call.kind === "fitBounds").length, 0);
  await moved.dispose?.();
});

test("provider does not move the camera when package network geometry has no valid coordinates", async () => {
  const map = fakeCameraMap();
  const empty = { type: "FeatureCollection", features: [] };
  const session = await openFakePackage({ map, geometry: empty, lanes: empty, nodes: empty, centroids: empty });
  assert.equal(map.calls.length, 0);
  assert.equal(networkBounds({ type: "FeatureCollection", features: [] }), null);
  await session.dispose?.();
});

test("camera getter and setter round-trip a validated live map view", async () => {
  const map = fakeCameraMap(); const session = await openFakePackage({ map });
  const view = { center: [-0.1, 51.5] as [number, number], zoom: 12, bearing: 35, pitch: 40 };
  session.setCameraView?.(view);
  assert.deepEqual(session.getCameraView?.(), view);
  assert.throws(() => validateTestudoCameraView({ center: [181, 0], zoom: 5 }), /longitude/);
  assert.throws(() => session.setCameraView?.({ center: [0, 0], zoom: 25 }), /zoom/);
  assert.throws(() => session.setCameraView?.({ center: [0, 0], zoom: 5, pitch: 86 }), /pitch/);
  await session.dispose?.();
});

test("Camera panel controls mutate the real package layers or fail with an honest unavailable error", async () => {
  const map = fakeCameraMap(); const session = await openFakePackage({ map });
  assert.deepEqual(session.getMapControlState?.(), { legendVisible: true, esriWorldImageryVisible: false, renderer: "maplibre" });
  assert.equal(await session.setMapControl?.("legend", false), true);
  assert.equal(map.layouts.get("testudo-main-1-network-sections-layer:visibility"), "none");
  assert.deepEqual(session.getMapControlState?.(), { legendVisible: false, esriWorldImageryVisible: false, renderer: "maplibre" });
  await session.setMapControl?.("esri-world-imagery", true);
  assert.equal(session.getMapControlState?.().esriWorldImageryVisible, true);
  assert.equal(map.sources.get("testudo-main-1-esri-world-imagery")?.definition.type, "raster");
  await session.setMapControl?.("esri-world-imagery", false);
  assert.equal(session.getMapControlState?.().esriWorldImageryVisible, false);
  assert.equal(map.sources.has("testudo-main-1-esri-world-imagery"), false);
  assert.deepEqual(await session.setKpiGeometry?.("sections", false), { showLanes: false, showSections: false });
  assert.deepEqual(await session.setKpiGeometry?.("lanes", true), { showLanes: true, showSections: false });
  assert.equal(session.setRenderer?.("maplibre"), "maplibre");
  assert.throws(() => session.setRenderer?.("cesium"), /Cesium rendering is unavailable/);
  await session.dispose?.();
});

test("package camera declarations accept bbox and ignore malformed values", () => {
  assert.deepEqual(declaredDefaultCamera({ defaultView: { bbox: [-1, 50, 1, 52] } }), [[-1, 50], [1, 52]]);
  assert.equal(declaredDefaultCamera({ default_view: { center: [181, 0], zoom: 10 } }), null);
});

test("closing a package generation aborts its in-flight animation chunk proxy request", async () => {
  let aborted = false;
  const bridge = new TestudoFeatureBridge({ async open(_bootstrap, _context, _progress, fetchArtifact) {
    await fetchArtifact("chunks/animation/0.json.gz");
    throw new Error("fixture should be cancelled before completion");
  } }, (_request, signal) => new Promise<ArrayBuffer>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }));
  bridge.createTView("main");
  const load = bridge.loadPackage("main", {
    packageId: "pkg", versionId: "v1", label: "Fixture", artifactEndpoint: "proxy", selectedPlugin: "vehicle-playback",
    capabilities: [{ id: "vehicle-playback", available: true }],
  }).catch((error) => error);
  await Promise.resolve();
  bridge.close("main");
  await load;
  assert.equal(aborted, true);
});
