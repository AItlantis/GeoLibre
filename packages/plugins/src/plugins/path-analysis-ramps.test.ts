import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSelectedPathPercentages, PATH_RAMPS, pathColorRgb, pathMetricRampExpression, pathMetricValue } from "./path-analysis-ramps";

test("normalizes route percentages to the selected section", () => {
  const result = normalizeSelectedPathPercentages([
    { demand: 30, percentage: 0.12 },
    { demand: 70, percentage: 0.08 },
  ]);
  assert.deepEqual(result.map((row) => row.percentage), [0.3, 0.7]);
  assert.equal(result.reduce((sum, row) => sum + row.percentage, 0), 1);
});

test("uses the selected metric value and its matching MapLibre ramp", () => {
  assert.equal(pathMetricValue({ demand: 500, percentage: 0.12 }, "percentage"), 12);
  assert.equal(pathMetricValue({ demand: 500, percentage: 0.12 }, "trips"), 500);
  assert.notDeepEqual(PATH_RAMPS.trips.stops, PATH_RAMPS.percentage.stops);
  assert.deepEqual(pathColorRgb(500, "trips"), pathColorRgb(PATH_RAMPS.trips.stops[3], "trips"));
  assert.deepEqual(pathMetricRampExpression("trips"), [
    "interpolate", ["linear"], ["get", "value"],
    0, "#dbeafe", 25, "#60a5fa", 100, "#22c55e", 500, "#f59e0b", 2000, "#dc2626",
  ]);
});
