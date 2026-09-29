import assert from "node:assert/strict";
import test from "node:test";
import { deriveSimulationTimeline } from "../packages/plugins/src/shared/simulation-timeline";
import { matchScenarioIntervals, scenarioIntervalTime } from "../packages/plugins/src/plugins/scenario-comparison-timeline";

const timeline = (initial: number, step: number, count: number) => deriveSimulationTimeline({
  initialTimeSeconds: initial,
  durationSeconds: step * count,
  intervalDurationSeconds: step,
  intervalCount: count,
  source: "SIM_INFO",
});

test("Aimsun ent 1 maps to the first timeline slice and ent 0 is not a point", () => {
  const value = timeline(28_800, 300, 3);
  assert.equal(scenarioIntervalTime(0, value), null);
  assert.equal(scenarioIntervalTime(1, value), 28_800);
  assert.equal(scenarioIntervalTime(3, value), 29_400);
  assert.equal(scenarioIntervalTime(4, value), null);
});

test("matching accepts different ent IDs when their absolute times and full periods match", () => {
  const result = matchScenarioIntervals([1, 2, 3], timeline(0, 300, 3), [1, 3, 5], timeline(0, 150, 6));
  assert.deepEqual(result.intervals, [
    { entA: 1, entB: 1, timeSeconds: 0 },
    { entA: 2, entB: 3, timeSeconds: 300 },
    { entA: 3, entB: 5, timeSeconds: 600 },
  ]);
});

test("period mismatch rejects even overlapping interval times", () => {
  const result = matchScenarioIntervals([1, 2], timeline(0, 300, 3), [1, 2], timeline(0, 300, 2));
  assert.deepEqual(result.intervals, []);
  assert.equal(result.aggregateAvailable, false);
  assert.equal(result.reason, "period-mismatch");
});

test("matching rejects equal ent IDs when they resolve to different absolute times", () => {
  const result = matchScenarioIntervals([1, 2], timeline(0, 300, 2), [1, 2], timeline(60, 300, 2));
  assert.deepEqual(result.intervals, []);
  assert.equal(result.reason, "period-mismatch");
});

test("matching rejects sparse/out-of-range ent values instead of ranking observed IDs", () => {
  const result = matchScenarioIntervals([1, 20], timeline(0, 300, 2), [1, 2], timeline(0, 300, 2));
  assert.deepEqual(result.intervals, [{ entA: 1, entB: 1, timeSeconds: 0 }]);
});

test("aggregate comparison is available only when both complete periods align", () => {
  assert.equal(matchScenarioIntervals([0, 1], timeline(0, 300, 2), [0, 1], timeline(0, 600, 1)).aggregateAvailable, true);
  assert.equal(matchScenarioIntervals([0, 1], timeline(0, 300, 2), [0, 1], timeline(60, 300, 2)).aggregateAvailable, false);
});

test("missing timeline metadata fails closed", () => {
  const result = matchScenarioIntervals([1], null, [1], timeline(0, 300, 1));
  assert.deepEqual(result.intervals, []);
  assert.equal(result.aggregateAvailable, false);
  assert.equal(result.reason, "missing-timeline");
});
