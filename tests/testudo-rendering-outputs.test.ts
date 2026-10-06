import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureCollection } from "geojson";
import { mountRenderingOutputs } from "../packages/plugins/src/plugins/rendering-outputs/index";
import { switchTestudoModeLayers, testudoModeOwnedIds, testudoNetworkOwnedIds, testudoOwnedIds } from "../packages/plugins/src/testudo-layer-ownership";
import type { TestudoFeatureContext, TestudoMapHandle } from "../packages/plugins/src/shared/testudo-feature-session";
import { getTestudoPackageProviderSuite, registerTestudoPackageProvider } from "../packages/plugins/src/testudo-provider-registry";
import type { TestudoPackageBootstrap } from "../packages/plugins/src/testudo-feature-bridge";

const context = (generation: number): TestudoFeatureContext => ({ tviewId: "network-view", packageId: "fixture", versionId: "v1", pluginId: "vehicle-playback", generation });
const geojson = (line: number[][]): FeatureCollection => ({
  type: "FeatureCollection", features: [{ type: "Feature", properties: { oid: "section-1", lane_id: "lane-1", width: 3.5 }, geometry: { type: "LineString", coordinates: line } }],
});
function fakeMap(zoom = 14) {
  const sources = new Map<string, { data: unknown; setData(data: unknown): void }>();
  const layers = new Map<string, Record<string, unknown>>(); const visibility = new Map<string, unknown>();
  const map: TestudoMapHandle & { getZoom(): number } = {
    getZoom: () => zoom,
    getSource: (id) => sources.get(id), addSource: (id, source) => {
      const item = { data: source.data, setData(data: unknown) { this.data = data; } }; sources.set(id, item);
    }, removeSource: (id) => { sources.delete(id); },
    getLayer: (id) => layers.get(id), addLayer: (layer) => { layers.set(String(layer.id), layer); },
    removeLayer: (id) => { layers.delete(id); }, setLayoutProperty: (id, key, value) => { visibility.set(`${id}:${key}`, value); },
    fitBounds() {}, jumpTo() {},
  };
  return { map, sources, layers, visibility };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

test("rendering outputs remains mounted across repeated mode changes with permanent network ownership", () => {
  const namespace = "testudo-network-view-1";
  const networkIds = testudoNetworkOwnedIds(namespace);
  const sources = new Set<string>(); const layers = new Set<string>();
  const own = (ids: string[]) => ids.forEach((id) => (id.endsWith("-layer") ? layers : sources).add(id));
  own(networkIds);
  let active: "animation" | "results" | "comparison" | "paths" = "animation";
  own(testudoModeOwnedIds(namespace, active));
  const map = {
    getSource: (id: string) => sources.has(id) ? { setData() {} } : undefined,
    removeSource: (id: string) => { sources.delete(id); },
    getLayer: (id: string) => layers.has(id) ? { id } : undefined,
    removeLayer: (id: string) => { layers.delete(id); },
  } as unknown as TestudoMapHandle;
  const sequence = ["results", "comparison", "animation", "results"] as const;
  for (const next of sequence) {
    const currentIds = switchTestudoModeLayers(map, namespace, active, next);
    own(testudoModeOwnedIds(namespace, next));
    assert.deepEqual([...sources, ...layers].sort(), [...currentIds].sort());
    assert.deepEqual(currentIds, [...networkIds, ...testudoModeOwnedIds(namespace, next)]);
    assert.deepEqual(currentIds.filter((id) => networkIds.includes(id)), networkIds);
    active = next;
  }
  assert.deepEqual(testudoOwnedIds(namespace, active), [...networkIds, ...testudoModeOwnedIds(namespace, "results")]);
});

test("package network loads sections, per-lane geometry and turns only through fetchArtifact, then tears down by generation", async () => {
  const { map, sources, layers, visibility } = fakeMap(); const requested: string[] = []; const progress: string[] = [];
  const artifacts: Record<string, unknown> = {
    "geometry/sections.geojson": geojson([[-0.2, 51.5], [-0.1, 51.6]]),
    "geometry/lanes.geojson": geojson([[-0.2, 51.5], [-0.1, 51.6]]),
    "geometry/turns.geojson": geojson([[-0.15, 51.55], [-0.14, 51.56]]),
  };
  const manifest = { geometry: { sections: "geometry/sections.geojson", lanes: "geometry/lanes.geojson", turns: "geometry/turns.geojson" } };
  const service = await mountRenderingOutputs({
    map, context: context(1), manifest, packageInfo: {}, fetchArtifact: async (ref) => { requested.push(ref); return bytes(artifacts[ref]); },
    onProgress: (value) => { if (value.label) progress.push(value.label); }, cameraWasOverridden: () => false,
  });
  try {
    assert.deepEqual(requested, Object.keys(artifacts));
    assert.equal(sources.size, 6);
    assert.equal(layers.size, 6);
    assert.equal(service.showLanes, true);
    assert.equal(service.showSections, false);
    assert.deepEqual(service.setGeometry("sections", true), { showLanes: true, showSections: true });
    assert.equal(visibility.get("rendering-outputs.network-view-1.line:visibility"), "visible");
    assert.equal(sources.get("rendering-outputs.network-view-1.turn.source")?.data && layers.has("rendering-outputs.network-view-1.turn"), true);
    assert.equal(service.setLegend(false), false);
    assert.ok(progress.some((label) => label.includes("Network ready")));
  } finally { service.dispose(); }
  assert.equal(sources.size, 0); assert.equal(layers.size, 0);
  const reload = await mountRenderingOutputs({
    map, context: context(2), manifest: { geometry: { sections: "geometry/sections.geojson" } }, packageInfo: {},
    fetchArtifact: async () => bytes(artifacts["geometry/sections.geojson"]), onProgress() {}, cameraWasOverridden: () => true,
  });
  assert.ok(reload.ownedIds.every((id) => id.includes("network-view-2")));
  reload.dispose();
});

test("section-only fallback reports absent lanes and turns without failing package load", async () => {
  const { map, sources } = fakeMap(10); const progress: string[] = [];
  const service = await mountRenderingOutputs({
    map, context: context(1), manifest: { geometry: { section: { path: "geometry/sections.geojson" } } }, packageInfo: {},
    fetchArtifact: async (ref) => { assert.equal(ref, "geometry/sections.geojson"); return bytes(geojson([[-0.2, 51.5], [-0.1, 51.6]])); },
    onProgress: (value) => { if (value.label) progress.push(value.label); }, cameraWasOverridden: () => true,
  });
  assert.equal(service.showLanes, false); assert.equal(service.showSections, true);
  assert.ok(progress.some((label) => label.includes("section-only network")));
  assert.equal(sources.size, 3);
  service.dispose(); assert.equal(sources.size, 0);
});

test("provider suite mounts network once for a generation, preserves IDs across mode switches, then unloads it", async () => {
  const { map, sources, layers } = fakeMap(); const requests: string[] = [];
  const sourceMap = new Map<string, unknown>([
    ["manifest.json", { geometry: { sections: "geometry/sections.geojson" } }],
    ["geolibre/package.json", {}],
    ["geometry/sections.geojson", geojson([[-0.2, 51.5], [-0.1, 51.6]])],
  ]);
  const makeProvider = (id: "vehicle-playback" | "network-kpi") => ({
    async open(_bootstrap: TestudoPackageBootstrap, context: TestudoFeatureContext) {
      return { context, capabilities: [{ id, available: true }], onActivate() {}, onDeactivate() {} };
    },
  });
  const unregisterAnimation = registerTestudoPackageProvider({ capability: "vehicle-playback", factory: makeProvider("vehicle-playback") }, "render-outputs-test-animation");
  const unregisterResults = registerTestudoPackageProvider({ capability: "network-kpi", factory: makeProvider("network-kpi") }, "render-outputs-test-results");
  const bootstrap: TestudoPackageBootstrap = {
    packageId: "fixture", versionId: "v1", label: "fixture", artifactEndpoint: "/artifact/", selectedPlugin: "vehicle-playback",
    capabilities: [{ id: "vehicle-playback", available: true }, { id: "network-kpi", available: true }],
  };
  try {
    const suite = getTestudoPackageProviderSuite(bootstrap)!;
    const session = await suite.open(bootstrap, context(4), () => {}, async (ref) => {
      requests.push(ref); return bytes(sourceMap.get(ref));
    }, map);
    const mounted = [...sources.keys()].sort(); const networkIds = testudoNetworkOwnedIds("testudo-network-view-4").filter((id) => sources.has(id) || layers.has(id)).sort();
    assert.deepEqual(requests, ["manifest.json", "geolibre/package.json", "geometry/sections.geojson"]);
    for (const next of ["network-kpi", "vehicle-playback", "network-kpi"]) {
      await session.selectPlugin?.(next);
      assert.deepEqual([...sources.keys()].sort(), mounted);
      assert.deepEqual(testudoNetworkOwnedIds("testudo-network-view-4").filter((id) => sources.has(id) || layers.has(id)).sort(), networkIds);
    }
    assert.equal(requests.filter((ref) => ref === "geometry/sections.geojson").length, 1);
    await session.dispose?.();
    assert.equal(sources.size, 0); assert.equal(layers.size, 0);
  } finally { unregisterResults(); unregisterAnimation(); }
});
