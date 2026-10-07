import assert from "node:assert/strict";
import test from "node:test";
import type { TestudoDemoMode } from "@geolibre/embed";
import { comparisonStyleState, environmentAvailableForScenario, modeForScenarioChange, testudoViewerStyleState, validateTestudoStyle } from "./testudo-view-style";

const scenarios = [{ id: "49320" }, { id: "49414" }];

function shellValidStyle(style: unknown): boolean {
  if (!style || typeof style !== "object" || Array.isArray(style)) return false;
  const value = style as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  const allowed = ["display", "interval", "maxHeightM", "metric", "scenarioA", "scenarioB", "showDifference"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.display !== "ramp" && value.display !== "extrusion") return false;
  if (typeof value.metric !== "string" || !Number.isSafeInteger(value.interval) || Number(value.interval) < 0
    || typeof value.maxHeightM !== "number" || !Number.isFinite(value.maxHeightM) || value.maxHeightM <= 0) return false;
  if (value.scenarioA !== undefined && typeof value.scenarioA !== "string") return false;
  if (value.scenarioB !== undefined && typeof value.scenarioB !== "string") return false;
  if (value.showDifference !== undefined && typeof value.showDifference !== "boolean") return false;
  return keys.length > 0;
}

test("emitted style in every mode satisfies the shell exact-key style contract", () => {
  const fields = { interval: 0, maxHeightM: 10 };
  for (const mode of ["animation", "results", "flow", "density", "comparison", "environment", "paths"] as const) {
    const emitted = testudoViewerStyleState({ display: "ramp", metric: mode === "environment" ? "co2" : mode === "paths" ? "trips" : "flow", ...fields,
      ...(mode === "comparison" ? { scenarioA: 49320, scenarioB: 1, showDifference: true } : {}),
      strayPluginKey: "must not escape" } as any, scenarios);
    assert.equal(shellValidStyle(emitted), true, mode);
    assert.deepEqual(Object.keys(emitted).sort(), mode === "comparison"
      ? ["display", "interval", "maxHeightM", "metric", "scenarioA", "scenarioB", "showDifference"]
      : ["display", "interval", "maxHeightM", "metric"]);
    if (mode === "comparison") {
      assert.equal(emitted.scenarioA, "49320");
      assert.equal(emitted.scenarioB, "49414");
    }
  }
  assert.equal(shellValidStyle({ display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, surprise: true }), false);
  assert.equal(shellValidStyle({ display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, scenarioA: 49320 }), false);
});

test("comparison accepts ids and legacy indexes and emits scenario ids as strings", () => {
  const idInput = validateTestudoStyle({ display: "ramp", metric: "flow_delta", interval: 0, maxHeightM: 10, scenarioA: "49414", scenarioB: "49320" }, "comparison", 2, scenarios);
  assert.deepEqual([idInput.scenarioA, idInput.scenarioB], [1, 0]);
  const indexInput = validateTestudoStyle({ display: "ramp", metric: "flow_delta", interval: 0, maxHeightM: 10, scenarioA: 1, scenarioB: 0 }, "comparison", 2, scenarios);
  const emitted = comparisonStyleState(indexInput, scenarios, true);
  assert.deepEqual([emitted.scenarioA, emitted.scenarioB], ["49414", "49320"]);
  assert.equal(shellValidStyle(emitted), true);
});

test("Environment returns after scenario coverage returns and restores the preferred mode", () => {
  const coverage = [{ scid: "A1", did: 101 }, { scid: "A2", did: 202 }];
  const modes = ["animation", "results", "paths", "environment"] as const;
  let selected: TestudoDemoMode = "environment";
  let preferred: TestudoDemoMode = "environment";
  const sequence = ["A1", "B", "A1", "A2", "B", "A2"];
  const expected = [true, false, true, true, false, true];
  sequence.forEach((scenario, index) => {
    const environmentAvailable = environmentAvailableForScenario(coverage, scenario);
    const state = modeForScenarioChange(modes, environmentAvailable, preferred, selected);
    assert.equal(state.availableModes.includes("environment"), expected[index], scenario);
    selected = state.selectedMode!;
    if (!environmentAvailable) assert.notEqual(selected, "environment");
    else assert.equal(selected, "environment");
  });
});

test("Paths accepts its metrics and both displays, with volume aliased to trips", () => {
  for (const display of ["ramp", "extrusion"] as const) {
    const style = validateTestudoStyle({ display, metric: "volume", interval: 0, maxHeightM: 20 }, "paths", 0);
    assert.equal(style.metric, "trips");
    assert.equal(style.display, display);
  }
  assert.equal(validateTestudoStyle({ display: "ramp", metric: "percentage", interval: 0, maxHeightM: 20 }, "paths", 0).metric, "percentage");
  assert.throws(() => validateTestudoStyle({ display: "ramp", metric: "flow", interval: 0, maxHeightM: 20 }, "paths", 0), /Style metric "flow" is unavailable for the selected mode/);
});
