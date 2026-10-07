import assert from "node:assert/strict";
import test from "node:test";
import { ensurePathAnalysisMapObjects } from "./maplibre-path-analysis";

class MapDouble {
  sources = new Map<string, unknown>();
  layers = new Map<string, unknown>();
  addSourceCalls = new Map<string, number>();
  addLayerCalls = new Map<string, number>();
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, source: unknown) {
    this.addSourceCalls.set(id, (this.addSourceCalls.get(id) ?? 0) + 1);
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists.`);
    this.sources.set(id, source);
  }
  getLayer(id: string) { return this.layers.get(id); }
  addLayer(layer: { id: string }) {
    this.addLayerCalls.set(layer.id, (this.addLayerCalls.get(layer.id) ?? 0) + 1);
    if (this.layers.has(layer.id)) throw new Error(`Layer "${layer.id}" already exists.`);
    this.layers.set(layer.id, layer);
  }
}

test("re-entering Paths reuses existing sources and layers", () => {
  const map = new MapDouble();
  for (let cycle = 0; cycle < 5; cycle++) {
    // Testudo mode leaves these plugin objects on the shared map across exit.
    ensurePathAnalysisMapObjects(map, true);
    if (cycle < 4) {
      map.sources.get("geolibre-path-analysis-paths"); // exit does not own/remove shared-map objects
    }
  }
  assert.deepEqual([...map.addSourceCalls.values()], [1, 1, 1]);
  assert.deepEqual([...map.addLayerCalls.values()], [1, 1, 1]);
  assert.equal(map.sources.has("geolibre-path-analysis-paths"), true);
});

test("source and layer creation tolerates a concurrent add that wins the race", () => {
  const map = new MapDouble();
  const originalAddSource = map.addSource.bind(map);
  map.addSource = (id, source) => {
    map.sources.set(id, source);
    throw new Error(`Source "${id}" already exists.`);
  };
  const originalAddLayer = map.addLayer.bind(map);
  map.addLayer = layer => {
    map.layers.set(layer.id, layer);
    throw new Error(`Layer "${layer.id}" already exists.`);
  };
  ensurePathAnalysisMapObjects(map, true);
  assert.equal(map.sources.size, 3);
  assert.equal(map.layers.size, 3);
  map.addSource = originalAddSource;
  map.addLayer = originalAddLayer;
  ensurePathAnalysisMapObjects(map, true);
  assert.equal(map.sources.size, 3);
  assert.equal(map.layers.size, 3);
});
