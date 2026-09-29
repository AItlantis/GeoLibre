import assert from "node:assert/strict";
import test from "node:test";
import { buildScenarioComparisonRows, defaultScenarioComparisonPair } from "../packages/plugins/src/plugins/scenario-comparison-data";
import { comparisonDifferenceColor, comparisonDifferenceLegend, comparisonThresholdDefault, isComparisonMetric } from "../packages/plugins/src/plugins/comparison-ramps";

test("comparison rows align by section ID and preserve missing side values", () => {
  const rows = buildScenarioComparisonRows(
    [{ key: 10, flow: 100, density: 20, speed: 40, delay: 2 }],
    [{ key: 10, flow: 150, density: null, speed: 30, delay: 4 }, { key: 11, flow: 20, density: 1 }],
  );
  assert.deepEqual(rows.map(({ key, hasReference, hasCompared, flow_delta, density_delta }) => ({ key, hasReference, hasCompared, flow_delta, density_delta })), [
    { key: 10, hasReference: true, hasCompared: true, flow_delta: 50, density_delta: null },
    { key: 11, hasReference: false, hasCompared: true, flow_delta: null, density_delta: null },
  ]);
});

test("difference thresholds and legend domains follow the selected metric and flow scale", () => {
  assert.equal(comparisonThresholdDefault("density_delta"), 5);
  assert.equal(comparisonThresholdDefault("speed_delta"), 5);
  const defaultColor = comparisonDifferenceColor("flow_delta", 100, 1000);
  const focusedColor = comparisonDifferenceColor("flow_delta", 100, 200);
  assert.notDeepEqual(focusedColor, defaultColor);
  assert.equal(comparisonDifferenceLegend("flow_delta", 200).domainMax, 200);
});

test("retired product delta is not a supported metric", () => {
  assert.equal(isComparisonMetric("flow_density_product_delta"), false);
});

test("a fresh comparison selects distinct reference and compared scenarios", () => {
  assert.deepEqual(defaultScenarioComparisonPair([0, 1], 0, 0, null, null), { scenarioA: 0, scenarioB: 1 });
  assert.equal(defaultScenarioComparisonPair([0, 1], 0, 0, 10, 11), null);
  assert.equal(defaultScenarioComparisonPair([0], 0, 0, null, null), null);
});
