import test from "node:test";
import assert from "node:assert/strict";
import { TestudoGenerationMount, TestudoGenerationResourceCache } from "../packages/plugins/src/shared/testudo-generation-resources";
import { mountTestudoComparisonGeometry, TESTUDO_NETWORK_LAYERS, TestudoPersistentNetwork } from "../packages/plugins/src/shared/testudo-persistent-network";
import type { TestudoFeatureContext, TestudoMapHandle } from "../packages/plugins/src/shared/testudo-feature-session";
import type { NetworkKpiGeometry } from "../packages/plugins/src/plugins/network-kpi-data";
import { selectScenarioPathIndex } from "../packages/plugins/src/shared/scenario-path-index";
import {
  __resetDuckDbLayerRegistryForTests,
  configureDuckDbLayerRegistry,
  getActiveDuckDbLayers,
  registerDuckDbLayer,
} from "../packages/plugins/src/shared/duckdb-layer-registry";

test("persistent network mounts once and remains mounted across mode changes", async () => {
  const mount = new TestudoGenerationMount();
  let mounts = 0;
  const apply = () => { mounts += 1; };
  assert.equal(await mount.mount(1, () => true, apply), true);
  // A mode change does not clear the package-owned mount.
  assert.equal(await mount.mount(1, () => true, apply), true);
  assert.equal(mounts, 1);
  assert.equal(mount.isMounted(1), true);
});

test("persistent network rejects a late mount from an old package generation", async () => {
  const mount = new TestudoGenerationMount();
  let resolveMount!: () => void;
  const pending = mount.mount(1, () => false, () => new Promise<void>(resolve => { resolveMount = resolve; }));
  mount.clear();
  resolveMount();
  assert.equal(await pending, false);
  assert.equal(mount.isMounted(1), false);
});

test("persistent network geometry toggles update the owned layer visibility", () => {
  const network = new TestudoPersistentNetwork();
  const changed: Array<[string, string, unknown]> = [];
  const map = { getLayer: () => ({}), getSource: () => ({}), removeLayer: () => {}, removeSource: () => {}, setLayoutProperty: (id: string, key: string, value: unknown) => changed.push([id, key, value]) };
  (network as unknown as { map: typeof map }).map = map;
  assert.deepEqual(network.setVisible("sections", false), { showSections: false, showLanes: true, showTurns: true, showNodes: true });
  assert.deepEqual(network.setVisible("lanes", false), { showSections: false, showLanes: false, showTurns: true, showNodes: true });
  assert.deepEqual(network.setVisible("turns", false), { showSections: false, showLanes: false, showTurns: false, showNodes: true });
  assert.deepEqual(network.setVisible("nodes", false), { showSections: false, showLanes: false, showTurns: false, showNodes: false });
  assert.deepEqual(changed.map(([id, key, value]) => [id, key, value]), [
    ["testudo-network-sections", "visibility", "none"], ["testudo-network-lanes", "visibility", "none"],
    ["testudo-network-turns", "visibility", "none"], ["testudo-network-nodes", "visibility", "none"],
  ]);
});

test("persistent network reattaches once after map replacement and style reload", async () => {
  class FakeMap implements TestudoMapHandle {
    sources = new Set<string>();
    layers = new Map<string, Record<string, unknown>>();
    visibility = new Map<string, unknown>();
    listeners = new Map<string, Set<(event?: { originalEvent?: unknown }) => void>>();
    loaded = true;
    getSource(id: string) { return this.sources.has(id) ? { setData: () => {} } : undefined; }
    addSource(id: string) { this.sources.add(id); }
    removeSource(id: string) { this.sources.delete(id); }
    getLayer(id: string) { return this.layers.get(id); }
    addLayer(layer: Record<string, unknown>) { this.layers.set(String(layer.id), layer); }
    removeLayer(id: string) { this.layers.delete(id); }
    setLayoutProperty(id: string, _key: string, value: unknown) { this.visibility.set(id, value); }
    getStyle() { return { layers: [] }; }
    isStyleLoaded() { return this.loaded; }
    on(type: string, listener: (event?: { originalEvent?: unknown }) => void) {
      let listeners = this.listeners.get(type); if (!listeners) this.listeners.set(type, listeners = new Set()); listeners.add(listener);
    }
    off(type: string, listener: (event?: { originalEvent?: unknown }) => void) { this.listeners.get(type)?.delete(listener); }
    fire(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
    reloadStyle() { this.sources.clear(); this.layers.clear(); this.loaded = false; this.fire("styledata"); this.loaded = true; this.fire("styledata"); }
  }
  const network = new TestudoPersistentNetwork();
  const mountState = (network as unknown as { mountState: { mount(generation: number, current: () => boolean, apply: () => void): Promise<boolean> } }).mountState;
  await mountState.mount(9, () => true, () => {});
  const featureContext: TestudoFeatureContext = { tviewId: "main", packageId: "pkg", versionId: "v1", pluginId: "network-kpi", generation: 9 };
  const geometry = { sections: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }] }, lanes: { type: "FeatureCollection", features: [{ type: "Feature", properties: { width: 3 }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }] }, turns: { type: "FeatureCollection", features: [] }, nodes: { type: "FeatureCollection", features: [] } } as NetworkKpiGeometry;
  const owned = network as unknown as { context: TestudoFeatureContext; generation: number; geometry: NetworkKpiGeometry; isCurrent: () => boolean };
  owned.context = featureContext; owned.generation = 9; owned.geometry = geometry; owned.isCurrent = () => true;
  network.setVisible("sections", false);
  const firstMap = new FakeMap();
  network.reconcileMap(firstMap);
  assert.equal(firstMap.layers.size, 2);
  const sectionLayer = firstMap.layers.get(TESTUDO_NETWORK_LAYERS.sections)!;
  const laneLayer = firstMap.layers.get(TESTUDO_NETWORK_LAYERS.lanes)!;
  assert.equal(sectionLayer.maxzoom, 17);
  assert.equal(laneLayer.minzoom, 17);
  assert.match(JSON.stringify((sectionLayer.paint as Record<string, unknown>)["line-width"]), /total_width/);
  assert.match(JSON.stringify((sectionLayer.paint as Record<string, unknown>)["line-width"]), /num_lanes/);
  assert.match(JSON.stringify((laneLayer.paint as Record<string, unknown>)["line-width"]), /width/);
  const replacementMap = new FakeMap();
  network.reconcileMap(replacementMap);
  assert.equal(replacementMap.layers.size, 2);
  replacementMap.reloadStyle();
  assert.equal(replacementMap.layers.size, 2);
  assert.equal(replacementMap.sources.size, 2);
  assert.equal(replacementMap.visibility.get("testudo-network-sections"), "none");
  assert.deepEqual(network.getVisibility(), { showSections: false, showLanes: true, showTurns: true, showNodes: true });
  network.clear();
});

test("real persistent mount resolves before style readiness and attaches current geometry once when ready", async () => {
  class UnreadyMap implements TestudoMapHandle {
    sources = new Map<string, Record<string, unknown>>();
    layers = new Map<string, Record<string, unknown>>();
    listeners = new Map<string, Set<(event?: { originalEvent?: unknown }) => void>>();
    loaded = false;
    addLayerCount = 0;
    getSource(id: string) { return this.sources.has(id) ? { setData: () => {} } : undefined; }
    addSource(id: string, source: Record<string, unknown>) { this.sources.set(id, source); }
    removeSource(id: string) { this.sources.delete(id); }
    getLayer(id: string) { return this.layers.get(id); }
    addLayer(layer: Record<string, unknown>) { this.addLayerCount++; this.layers.set(String(layer.id), layer); }
    removeLayer(id: string) { this.layers.delete(id); }
    setLayoutProperty(id: string, _name: string, value: unknown) {
      const layer = this.layers.get(id); if (layer) layer.layout = { ...(layer.layout as Record<string, unknown>), visibility: value };
    }
    getStyle() { return { layers: [] }; }
    isStyleLoaded() { return this.loaded; }
    on(type: "movestart" | "styledata", listener: (event?: { originalEvent?: unknown }) => void) {
      let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener);
    }
    off(type: "movestart" | "styledata", listener: (event?: { originalEvent?: unknown }) => void) { this.listeners.get(type)?.delete(listener); }
    fireStyleData() { for (const listener of this.listeners.get("styledata") ?? []) listener(); }
  }
  const feature = (width: number) => JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { total_width: width, width }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }],
  });
  const directory = (files: Record<string, string>): NetworkKpiDirectoryHandle => ({
    name: "memory-package",
    async getFileHandle(name: string) {
      const content = files[name];
      if (content === undefined) throw new Error(`Missing fixture file ${name}`);
      return { getFile: async () => new Blob([content]) };
    },
    async getDirectoryHandle(name: string) { throw new Error(`Unexpected nested directory ${name}`); },
  });
  const manifest = (prefix: string) => ({ geometry: {
    sections: `${prefix}-sections.json`, lanes: `${prefix}-lanes.json`, turns: `${prefix}-turns.json`,
  } });
  const files = (prefix: string, width: number) => ({
    [`${prefix}-sections.json`]: feature(width),
    [`${prefix}-lanes.json`]: feature(width),
    [`${prefix}-turns.json`]: feature(width),
  });
  const map = new UnreadyMap();
  const network = new TestudoPersistentNetwork();
  let currentGeneration = 31;
  const firstContext: TestudoFeatureContext = { tviewId: "main", packageId: "old", versionId: "v1", pluginId: "network-kpi", generation: 31 };
  const firstMount = network.mount(firstContext, directory(files("old", 3)), manifest("old"), map, context => context.generation === currentGeneration);
  assert.equal(await firstMount, true, "mount must resolve without waiting for the map's style event");
  assert.equal(map.layers.size, 0);
  assert.equal(map.listeners.get("styledata")?.size, 1, "the active map retains one readiness listener");

  // Replace the generation before the style becomes ready. The old listener
  // and geometry must be discarded, and only the replacement may attach.
  currentGeneration = 32;
  const nextContext: TestudoFeatureContext = { ...firstContext, packageId: "new", versionId: "v2", generation: 32 };
  assert.equal(await network.mount(nextContext, directory(files("new", 6)), manifest("new"), map, context => context.generation === currentGeneration), true);
  assert.equal(map.listeners.get("styledata")?.size, 1, "generation replacement leaves no stale style listener");
  assert.equal(map.layers.size, 0);

  map.loaded = true;
  map.fireStyleData();
  assert.deepEqual([...map.layers.keys()].sort(), [TESTUDO_NETWORK_LAYERS.lanes, TESTUDO_NETWORK_LAYERS.sections, TESTUDO_NETWORK_LAYERS.turns].sort());
  assert.equal(map.addLayerCount, 3, "sections, lanes and turns attach exactly once");
  const sectionSource = map.sources.get(TESTUDO_NETWORK_LAYERS.sections);
  assert.equal((sectionSource?.data as { features: Array<{ properties: { total_width: number } }> }).features[0].properties.total_width, 6, "only the replacement generation geometry attaches");
  map.fireStyleData();
  assert.equal(map.addLayerCount, 3, "repeated readiness events do not duplicate owned layers");
  network.clear();
  assert.equal(map.listeners.get("styledata")?.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);

  // A clear before readiness also detaches the callback and prevents any late
  // style event from creating package-owned layers.
  currentGeneration = 33;
  map.loaded = false;
  const clearContext: TestudoFeatureContext = { ...firstContext, packageId: "cleared", generation: 33 };
  assert.equal(await network.mount(clearContext, directory(files("clear", 9)), manifest("clear"), map, context => context.generation === currentGeneration), true);
  network.clear();
  map.fireStyleData();
  assert.equal(map.listeners.get("styledata")?.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
});

test("comparison geometry stays isolated per map and reloads with the map style", () => {
  class GeometryMap {
    sources = new Set<string>(); layers = new Map<string, Record<string, unknown>>();
    listeners = new Set<() => void>(); loaded = true;
    getSource(id: string) { return this.sources.has(id) ? {} : undefined; }
    addSource(id: string) { this.sources.add(id); }
    removeSource(id: string) { this.sources.delete(id); }
    getLayer(id: string) { return this.layers.get(id); }
    addLayer(layer: Record<string, unknown>) { this.layers.set(String(layer.id), layer); }
    removeLayer(id: string) { this.layers.delete(id); }
    getStyle() { return { layers: [] }; }
    isStyleLoaded() { return this.loaded; }
    on(_type: string, listener: () => void) { this.listeners.add(listener); }
    off(_type: string, listener: () => void) { this.listeners.delete(listener); }
    reloadStyle() { this.sources.clear(); this.layers.clear(); for (const listener of this.listeners) listener(); }
  }
  const data = (properties: Record<string, unknown>) => ({ type: "FeatureCollection", features: [{ type: "Feature", properties, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }] }) as never;
  const geometryA = { sections: data({ total_width: 12 }), lanes: data({ width: 3 }), turns: data({}) } as NetworkKpiGeometry;
  const geometryB = { sections: data({ total_width: 24 }), lanes: data({ width: 4 }), turns: data({}) } as NetworkKpiGeometry;
  const mapA = new GeometryMap(); const mapB = new GeometryMap();
  const disposeA = mountTestudoComparisonGeometry(mapA as unknown as TestudoMapHandle, geometryA, "comparison-pane-a");
  const disposeB = mountTestudoComparisonGeometry(mapB as unknown as TestudoMapHandle, geometryB, "comparison-pane-b");
  assert.deepEqual([...mapA.layers.keys()].sort(), ["comparison-pane-a-lanes", "comparison-pane-a-sections", "comparison-pane-a-turns"]);
  assert.deepEqual([...mapB.layers.keys()].sort(), ["comparison-pane-b-lanes", "comparison-pane-b-sections", "comparison-pane-b-turns"]);
  assert.match(JSON.stringify(mapA.layers.get("comparison-pane-a-sections")?.paint), /total_width/);
  assert.match(JSON.stringify(mapB.layers.get("comparison-pane-b-lanes")?.paint), /width/);
  assert.ok(JSON.stringify(mapB.layers.get("comparison-pane-b-lanes")?.paint).includes('["case",[">",["to-number",["get","width"],0],0],["to-number",["get","width"],0],3]'), "zero or missing lane width must fall back to 3 m");
  const stableLayerCount = mapA.layers.size;
  for (const listener of mapA.listeners) listener();
  assert.equal(mapA.layers.size, stableLayerCount, "repeated styledata must leave healthy owned layers untouched");
  mapA.reloadStyle(); mapB.reloadStyle();
  assert.equal(mapA.layers.size, 3); assert.equal(mapB.layers.size, 3);
  disposeA(); disposeB();
  assert.equal(mapA.layers.size, 0); assert.equal(mapA.sources.size, 0); assert.equal(mapA.listeners.size, 0);
  assert.equal(mapB.layers.size, 0); assert.equal(mapB.sources.size, 0); assert.equal(mapB.listeners.size, 0);
});

test("comparison geometry ignores empty geometry types during styledata recovery", () => {
  class EmptyGeometryMap {
    sources = new Set<string>(); layers = new Map<string, Record<string, unknown>>();
    listeners = new Set<() => void>(); addLayerCount = 0; removeLayerCount = 0;
    getSource(id: string) { return this.sources.has(id) ? {} : undefined; }
    addSource(id: string) { this.sources.add(id); }
    removeSource(id: string) { this.sources.delete(id); }
    getLayer(id: string) { return this.layers.get(id); }
    addLayer(layer: Record<string, unknown>) { this.addLayerCount++; this.layers.set(String(layer.id), layer); }
    removeLayer(id: string) { this.removeLayerCount++; this.layers.delete(id); }
    getStyle() { return { layers: [] }; }
    isStyleLoaded() { return true; }
    on(_type: string, listener: () => void) { this.listeners.add(listener); }
    off(_type: string, listener: () => void) { this.listeners.delete(listener); }
  }
  const feature = { type: "Feature", properties: { total_width: 9 }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } };
  const map = new EmptyGeometryMap();
  const dispose = mountTestudoComparisonGeometry(map as unknown as TestudoMapHandle, {
    sections: { type: "FeatureCollection", features: [feature] },
    lanes: { type: "FeatureCollection", features: [] }, turns: null,
  } as unknown as NetworkKpiGeometry, "comparison-empty");
  assert.deepEqual([...map.layers.keys()], ["comparison-empty-sections"]);
  const initialAdds = map.addLayerCount;
  for (const listener of map.listeners) listener();
  assert.equal(map.addLayerCount, initialAdds, "empty geometry IDs are not retried as missing resources");
  assert.equal(map.removeLayerCount, 0, "styledata must not remove healthy geometry");
  dispose();
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(map.listeners.size, 0);
});

test("results resource cache reuses one database resource per package generation", async () => {
  const cache = new TestudoGenerationResourceCache<{ generation: number }>();
  let opens = 0;
  const open = async (generation: number) => cache.get(`package:${generation}`, async () => ({ generation: ++opens }));
  const [first, second] = await Promise.all([open(4), open(4)]);
  const nextGeneration = await open(5);
  assert.equal(first, second);
  assert.notEqual(first, nextGeneration);
  assert.equal(opens, 2);
});

test("network KPI timeline reads all per-did SIM_INFO catalog partitions", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(process.cwd(), "packages/plugins/src/plugins/network-kpi-parquet-data.ts"), "utf8");
  assert.match(source, /const parquetSource = handles\.length === 1[\s\S]*read_parquet\(\[\$\{handles\.map\(q\)\.join\("\, "\)\}\]\)/);
  assert.match(source, /WHERE did = \$\{did\}/);
  const provider = fs.readFileSync(path.join(process.cwd(), "packages/plugins/src/plugins/testudo-dataset-provider.ts"), "utf8");
  assert.match(provider, /testudoDatasetSessions\.get\(sessionKey, create\)/);
  assert.match(provider, /Plugin deactivation releases its view, while the package owner disposes/);
});

test("path analysis prefers the selected scenario index and keeps the legacy default", () => {
  const indices = { "0": "indexed_paths/0", "49320": "indexed_paths/49320", "49414": "indexed_paths/49414" };
  assert.equal(selectScenarioPathIndex(indices, 49414), "indexed_paths/49414");
  assert.equal(selectScenarioPathIndex(indices), "indexed_paths/0");
  assert.equal(selectScenarioPathIndex({ "49320": "indexed_paths/49320" }, 49414), "indexed_paths/49320");
});

test("vehicle playback stays registered without evicting or consuming a DuckDB slot", () => {
  __resetDuckDbLayerRegistryForTests();
  configureDuckDbLayerRegistry({ maxConcurrent: 1 });
  const disposed: string[] = [];
  registerDuckDbLayer({ pluginId: "network-kpi", family: "duckdb", dispose: () => { disposed.push("network-kpi"); } });
  registerDuckDbLayer({ pluginId: "vehicle-playback", family: "non-duckdb", dispose: () => { disposed.push("vehicle-playback"); } });
  registerDuckDbLayer({ pluginId: "emissions-h3", family: "duckdb", dispose: () => { disposed.push("emissions-h3"); } });
  assert.deepEqual(getActiveDuckDbLayers(), ["vehicle-playback", "emissions-h3"]);
  assert.deepEqual(disposed, ["network-kpi"]);
  __resetDuckDbLayerRegistryForTests();
});


test("Paths geometry preset restores user visibility after successful or interrupted transitions", () => {
  const network = new TestudoPersistentNetwork();
  const changed: Array<[string, string, unknown]> = [];
  const map = { getLayer: () => ({}), getSource: () => ({}), removeLayer: () => {}, removeSource: () => {}, setLayoutProperty: (id: string, key: string, value: unknown) => changed.push([id, key, value]) };
  (network as unknown as { map: typeof map }).map = map;
  network.setVisible("lanes", false);
  network.setVisible("nodes", false);
  const beforePaths = network.getVisibility();
  assert.deepEqual(network.setPathsMode(true, 12), { showSections: true, showLanes: false, showTurns: true, showNodes: false });
  // Re-entering the same Paths generation must not replace the saved user state.
  network.setPathsMode(true, 12);
  assert.deepEqual(network.setPathsMode(false, 12), beforePaths);
  network.setPathsMode(true, 12);
  // A stale generation cannot restore settings into the active package.
  network.setPathsMode(false, 11);
  assert.deepEqual(network.getVisibility(), { showSections: true, showLanes: false, showTurns: true, showNodes: false });
  network.clear();
  assert.deepEqual(network.getVisibility(), { showSections: true, showLanes: true, showTurns: true, showNodes: true });
});
