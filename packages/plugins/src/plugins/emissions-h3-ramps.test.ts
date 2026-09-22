import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmissionsH3Metric,
  EMISSIONS_H3_METRICS,
  EMISSIONS_H3_RAMPS,
  EMISSIONS_H3_RESOLUTION_MIN,
  EMISSIONS_H3_RESOLUTION_MAX,
  clampEmissionsH3Resolution,
} from "./emissions-h3-ramps";

test("emissions metrics always resolve to a ramp", () => {
  for (const metric of EMISSIONS_H3_METRICS) assert.ok(EMISSIONS_H3_RAMPS[metric]);
  assert.equal(normalizeEmissionsH3Metric("invalid"), "noise");
});

test("noise ramp follows the green-to-red 55–80 dB reference bands", () => {
  const ramp = EMISSIONS_H3_RAMPS.noise;
  assert.deepEqual(ramp.stops, [35, 45, 55, 60, 65, 70, 75, 80]);
  assert.equal(ramp.colors[0], "#00b050");
  assert.equal(ramp.colors.at(-1), "#7f0000");
});

test("CO2 ramp follows the pale-warm-to-dark-blue map reference", () => {
  const ramp = EMISSIONS_H3_RAMPS.co2;
  assert.deepEqual(ramp.stops, [1, 10, 30, 100, 300, 1000, 3000, 10000]);
  assert.equal(ramp.colors[0], "#fff7f3");
  assert.equal(ramp.colors.at(-1), "#111c5c");
});

test("clampEmissionsH3Resolution accepts any resolution within the supported band", () => {
  assert.equal(clampEmissionsH3Resolution(5), 5);
  assert.equal(clampEmissionsH3Resolution(EMISSIONS_H3_RESOLUTION_MIN), EMISSIONS_H3_RESOLUTION_MIN);
  assert.equal(clampEmissionsH3Resolution(EMISSIONS_H3_RESOLUTION_MAX), EMISSIONS_H3_RESOLUTION_MAX);
});

test("clampEmissionsH3Resolution clamps out-of-band values instead of rejecting them", () => {
  assert.equal(clampEmissionsH3Resolution(0), EMISSIONS_H3_RESOLUTION_MIN);
  assert.equal(clampEmissionsH3Resolution(20), EMISSIONS_H3_RESOLUTION_MAX);
  assert.equal(clampEmissionsH3Resolution(-5), EMISSIONS_H3_RESOLUTION_MIN);
});

test("clampEmissionsH3Resolution truncates a fractional resolution", () => {
  assert.equal(clampEmissionsH3Resolution(7.9), 7);
});
