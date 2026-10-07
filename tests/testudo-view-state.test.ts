import test from "node:test";
import assert from "node:assert/strict";
import { comparisonStyleState, modeForScenarioChange, validateTestudoStyle } from "../apps/geolibre-desktop/src/lib/testudo-view-style";

test("Environment availability and preferred mode recover when scenario changes back", () => {
  const declared = ["results", "environment", "animation"] as const;
  const unavailable = modeForScenarioChange(declared, false, "environment", "environment");
  assert.deepEqual(unavailable.availableModes, ["results", "animation"]);
  assert.equal(unavailable.selectedMode, "results");
  const restored = modeForScenarioChange(declared, true, "environment", unavailable.selectedMode);
  assert.deepEqual(restored.availableModes, ["results", "environment", "animation"]);
  assert.equal(restored.selectedMode, "environment");
});

test("comparison style echo reports scenario ids and preserves the pair when difference is off", () => {
  const scenarios = [{ scid: 49320 }, { scid: 49414 }];
  const incoming = validateTestudoStyle({ display: "ramp", metric: "flow_delta", interval: 3, maxHeightM: 100, scenarioA: 0, scenarioB: 1, showDifference: false }, "comparison", 2, scenarios);
  assert.deepEqual(comparisonStyleState(incoming, scenarios, false), {
    display: "ramp", metric: "flow_delta", interval: 3, maxHeightM: 100,
    scenarioA: 49320, scenarioB: 49414, showDifference: false,
  });
  const idsAccepted = validateTestudoStyle({ ...incoming, scenarioA: 49320, scenarioB: "49414", showDifference: true }, "comparison", 2, scenarios);
  assert.equal(idsAccepted.scenarioA, 0);
  assert.equal(idsAccepted.scenarioB, 1);
  assert.deepEqual(comparisonStyleState(idsAccepted, scenarios, true), {
    display: "ramp", metric: "flow_delta", interval: 3, maxHeightM: 100,
    scenarioA: 49320, scenarioB: 49414, showDifference: true,
  });
});
