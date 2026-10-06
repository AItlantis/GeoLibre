import assert from "node:assert/strict";
import test from "node:test";
import { parseTestudoAnimationManifest, parseTestudoPackageStructure } from "./testudo-package-data";
import { createTestudoLayerOwner } from "./testudo-package-renderer";
import { testudoVehiclePlaybackProvider } from "./testudo-vehicle-playback";
import { TestudoFeatureBridge } from "../testudo-feature-bridge";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const collection = (kind: "LineString" | "Point") => ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: kind === "Point"
  ? { type: "Point", coordinates: [1, 2] } : { type: "LineString", coordinates: [[1, 2], [2, 3]] }, properties: {} }] });

test("parses published package paths and sorted chunk ranges", () => {
  const structure = parseTestudoPackageStructure({ metadata: { dt: 0.5, n_ticks: 4 }, geometry: { sections: "geometry/sections.geojson", base_networks: { nodes: "geometry/nodes.geojson" } } },
    { animations: [{ manifestPath: "chunks/a/animation.json" }] });
  assert.equal(structure.sectionsPath, "geometry/sections.geojson");
  assert.equal(structure.nodesPath, "geometry/nodes.geojson");
  assert.equal(structure.maxTick, 3);
  assert.deepEqual(parseTestudoAnimationManifest({ chunks: [
    { path: "b.json", start_tick: 2, end_tick: 3 }, { path: "a.json", start_tick: 0, end_tick: 1 },
  ] }).map((chunk) => chunk.path), ["a.json", "b.json"]);
});

test("layer owner removes only its generation's source and layers", () => {
  const sources = new Map<string, { setData(data: unknown): void }>(); const layers = new Map<string, unknown>();
  const map = {
    getSource: (id: string) => sources.get(id), addSource: (id: string) => sources.set(id, { setData() {} }), removeSource: (id: string) => { sources.delete(id); },
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
    getSource: (id: string) => sources.get(id), addSource: (id: string, source: { data: any }) => sources.set(id, { data: source.data, setData(data) { this.data = data; } }), removeSource: (id: string) => { sources.delete(id); },
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
  assert.equal(await session.setMapControl?.("legend", false), true);
  assert.equal(session.getMapControlState?.().legendVisible, false);
  await session.onPlaybackTick?.("main", 1, { available: true, loading: false, playing: false, tick: 2, maxTick: 3, speed: 1, dt: 0.5, loop: false });
  assert.deepEqual(reads.slice(-1), ["chunks/base/1.json"]);
  const positions = sources.get("testudo-main-1-vehicle-positions")?.data;
  assert.equal(positions.features.length, 2);
  assert.deepEqual(positions.features.map((feature: any) => feature.geometry.coordinates), [[2, 3], [3, 4]]);
  await session.dispose?.(); assert.equal(sources.size, 0); assert.equal(layers.size, 0);
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
