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
