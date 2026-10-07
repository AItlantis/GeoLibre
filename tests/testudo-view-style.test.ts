import assert from "node:assert/strict";
import { test } from "node:test";
import { availableTestudoModes } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
import { pluginForTestudoMode, validateTestudoStyle } from "../apps/geolibre-desktop/src/lib/testudo-view-style";

test("shell modes map to persistent KPI views, animation and paths", () => {
  assert.equal(pluginForTestudoMode("results"), "network-kpi");
  assert.equal(pluginForTestudoMode("comparison"), "scenario-comparison");
  assert.equal(pluginForTestudoMode("environment"), "emissions-h3");
  assert.equal(pluginForTestudoMode("animation"), "vehicle-playback");
  assert.equal(pluginForTestudoMode("paths"), "path-analysis");
  assert.equal(pluginForTestudoMode("flow"), "network-kpi");
  assert.deepEqual(availableTestudoModes({ animation: true, flow: true, density: true, paths: true, results: true, comparison: false, environment: true }), ["animation", "flow", "paths", "density", "results", "environment"]);
});

test("style validation accepts current generation settings and rejects bad metrics, intervals, heights and scenario indexes", () => {
  assert.deepEqual(validateTestudoStyle({ display: "extrusion", metric: "flow_delta", interval: 1, maxHeightM: 80, scenarioA: 0, scenarioB: 1 }, "comparison", 2), {
    display: "extrusion", metric: "flow_delta", interval: 1, maxHeightM: 80, scenarioA: 0, scenarioB: 1,
  });
  for (const style of [
    { display: "heat", metric: "flow", interval: 0, maxHeightM: 10 },
    { display: "ramp", metric: "co2", interval: 0, maxHeightM: 10 },
    { display: "ramp", metric: "flow", interval: -1, maxHeightM: 10 },
    { display: "ramp", metric: "flow", interval: 0, maxHeightM: 10001 },
    { display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, scenarioA: 2 },
  ]) assert.throws(() => validateTestudoStyle(style, "results", 2));
});
