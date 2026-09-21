import test from "node:test";
import assert from "node:assert/strict";
import {
  registerDuckDbLayer,
  releaseDuckDbLayer,
  getActiveDuckDbLayers,
  configureDuckDbLayerRegistry,
  __resetDuckDbLayerRegistryForTests,
} from "./duckdb-layer-registry";

function trackedHandle(pluginId: string, disposed: string[]) {
  return { pluginId, dispose: () => { disposed.push(pluginId); } };
}

test.beforeEach(() => {
  __resetDuckDbLayerRegistryForTests();
});

test("registering a layer makes it active", () => {
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("network-kpi", disposed));
  assert.deepEqual(getActiveDuckDbLayers(), ["network-kpi"]);
  assert.deepEqual(disposed, []);
});

test("default maxConcurrent of 1 evicts the previous plugin's layer on registering a second", () => {
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("network-kpi", disposed));
  registerDuckDbLayer(trackedHandle("emissions-h3", disposed));
  assert.deepEqual(getActiveDuckDbLayers(), ["emissions-h3"]);
  assert.deepEqual(disposed, ["network-kpi"]);
});

test("eviction happens after the new handle is registered, not before", () => {
  // A same-plugin re-register must never be treated as an eviction victim of
  // its own registration call: register plugin A, then re-register A again —
  // A's OWN previous handle is replaced (disposed), but A itself remains
  // active afterward, it is not evicted by the cap logic.
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("path-analysis", disposed));
  registerDuckDbLayer(trackedHandle("path-analysis", disposed));
  assert.deepEqual(getActiveDuckDbLayers(), ["path-analysis"]);
  assert.deepEqual(disposed, ["path-analysis"]); // the first handle, not the second
});

test("releaseDuckDbLayer removes a plugin from the active set", () => {
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("vehicle-playback", disposed));
  releaseDuckDbLayer("vehicle-playback");
  assert.deepEqual(getActiveDuckDbLayers(), []);
});

test("releaseDuckDbLayer is idempotent", () => {
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("scenario-comparison", disposed));
  releaseDuckDbLayer("scenario-comparison");
  // Calling again (e.g. unrelated close + registry eviction both targeting
  // the same plugin) must not throw and must remain a no-op.
  assert.doesNotThrow(() => releaseDuckDbLayer("scenario-comparison"));
  assert.deepEqual(getActiveDuckDbLayers(), []);
});

test("releaseDuckDbLayer on an unknown plugin id is a no-op", () => {
  assert.doesNotThrow(() => releaseDuckDbLayer("never-registered"));
  assert.deepEqual(getActiveDuckDbLayers(), []);
});

test("getActiveDuckDbLayers reflects a higher configured maxConcurrent", () => {
  configureDuckDbLayerRegistry({ maxConcurrent: 2 });
  const disposed: string[] = [];
  registerDuckDbLayer(trackedHandle("network-kpi", disposed));
  registerDuckDbLayer(trackedHandle("emissions-h3", disposed));
  assert.deepEqual(getActiveDuckDbLayers(), ["network-kpi", "emissions-h3"]);
  assert.deepEqual(disposed, []);
  registerDuckDbLayer(trackedHandle("vehicle-playback", disposed));
  assert.deepEqual(getActiveDuckDbLayers(), ["emissions-h3", "vehicle-playback"]);
  assert.deepEqual(disposed, ["network-kpi"]);
});
