import test from "node:test";
import assert from "node:assert/strict";
import { TestudoGenerationMount, TestudoGenerationResourceCache } from "../packages/plugins/src/shared/testudo-generation-resources";
import { TestudoPersistentNetwork } from "../packages/plugins/src/shared/testudo-persistent-network";
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
  const map = { getLayer: () => ({}), setLayoutProperty: (id: string, key: string, value: unknown) => changed.push([id, key, value]) };
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
  const geometry = { sections: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }] }, lanes: { type: "FeatureCollection", features: [] }, turns: { type: "FeatureCollection", features: [] }, nodes: { type: "FeatureCollection", features: [] } } as NetworkKpiGeometry;
  const owned = network as unknown as { context: TestudoFeatureContext; generation: number; geometry: NetworkKpiGeometry; isCurrent: () => boolean };
  owned.context = featureContext; owned.generation = 9; owned.geometry = geometry; owned.isCurrent = () => true;
  network.setVisible("sections", false);
  const firstMap = new FakeMap();
  network.reconcileMap(firstMap);
  assert.equal(firstMap.layers.size, 1);
  const replacementMap = new FakeMap();
  network.reconcileMap(replacementMap);
  assert.equal(replacementMap.layers.size, 1);
  replacementMap.reloadStyle();
  assert.equal(replacementMap.layers.size, 1);
  assert.equal(replacementMap.sources.size, 1);
  assert.equal(replacementMap.visibility.get("testudo-network-sections"), "none");
  assert.deepEqual(network.getVisibility(), { showSections: false, showLanes: true, showTurns: true, showNodes: true });
  network.clear();
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
