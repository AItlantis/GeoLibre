import test from "node:test";
import assert from "node:assert/strict";
import { declutterMapLabels, formatRoundedDifference, formatTripVolume, lineMidpoint, passesComparisonDifferenceFilter, passesDifferenceThreshold } from "./map-labels";

test("rounds differences to tens and hundreds while preserving direction", () => {
  assert.equal(formatRoundedDifference(146), "+150");
  assert.equal(formatRoundedDifference(-146), "−150");
  assert.equal(formatRoundedDifference(1_267), "+1,300");
  assert.equal(formatRoundedDifference(-145), "−150");
  assert.equal(formatRoundedDifference(-4), "0");
});

test("does not round a positive fractional trip volume down to zero", () => {
  assert.equal(formatTripVolume(0.04), "<0.1");
  assert.equal(formatTripVolume(0.14), "0.1");
});

test("keeps values on the threshold and hides values below it", () => {
  assert.equal(passesDifferenceThreshold(49.99, 50), false);
  assert.equal(passesDifferenceThreshold(-50, 50), true);
  assert.equal(passesDifferenceThreshold(99, 100), false);
  assert.equal(passesDifferenceThreshold(100, 100), true);
  assert.equal(passesDifferenceThreshold(null, 0), false);
});

test("applies the cutoff to the numeric deltas behind categorical comparison maps", () => {
  assert.equal(passesComparisonDifferenceFilter("cmp_flow_sign", "positive", 49, 0, 50), false);
  assert.equal(passesComparisonDifferenceFilter("cmp_flow_sign", "negative", -50, 0, 50), true);
  assert.equal(passesComparisonDifferenceFilter("cmp_flow_density_quadrant", "more_flow_less_density", 20, -100, 50), true);
  assert.equal(passesComparisonDifferenceFilter("cmp_flow_density_quadrant", "more_flow_less_density", 20, -40, 50), false);
});

test("finds the distance midpoint of a multi-segment line", () => {
  assert.deepEqual(lineMidpoint([[0, 0], [2, 0], [3, 0]]), [1.5, 0]);
});

test("declutters labels in screen space and prioritizes important labels", () => {
  const labels = [
    { position: [0, 0] as const, priority: 1 },
    { position: [1, 0] as const, priority: 2 },
    { position: [100, 0] as const, priority: 0 },
  ];
  const visible = declutterMapLabels(labels, ([x, y]) => ({ x, y }), 20);
  assert.deepEqual(visible, [labels[1], labels[2]]);
});

test("declutters using label bounds, not just their centers", () => {
  const labels = [
    { position: [0, 0] as const, text: "+100,000", widthPx: 84 },
    { position: [49, 0] as const, text: "−100,000", widthPx: 84 },
  ];
  assert.deepEqual(declutterMapLabels(labels, ([x, y]) => ({ x, y }), 48), [labels[0]]);
});
