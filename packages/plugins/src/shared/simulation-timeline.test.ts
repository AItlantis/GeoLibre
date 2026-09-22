import test from "node:test";
import assert from "node:assert/strict";
import { deriveSimulationTimeline, formatSimulationTime, timelineTimeAtSliceIndex } from "./simulation-timeline";

test("keeps missing clock fields unknown", () => {
    const timeline = deriveSimulationTimeline({ durationSeconds: 600, intervalCount: 2 });
    assert.equal(timeline?.initialTimeSeconds, null);
    assert.equal(timeline?.finalTimeSeconds, null);
    assert.equal(timelineTimeAtSliceIndex(timeline, 1), null);
});

test("maps a slice position, not a sparse interval id", () => {
    const timeline = deriveSimulationTimeline({ initialTimeSeconds: 28800, durationSeconds: 900, intervalCount: 3 });
    assert.equal(timelineTimeAtSliceIndex(timeline, 0), 28800);
    assert.equal(timelineTimeAtSliceIndex(timeline, 2), 29400);
});

test("formats simulation clock", () => {
  assert.equal(formatSimulationTime(28805), "08:00:05");
  assert.equal(formatSimulationTime(null), "—");
});

test("SIM_INFO field aliases preserve seconds-from-midnight semantics", () => {
  const timeline = deriveSimulationTimeline({ initialTimeSeconds: 25200, durationSeconds: 3600, intervalCount: 12, source: "SIM_INFO" });
  assert.equal(timeline?.initialTimeSeconds, 25200);
  assert.equal(timeline?.intervalDurationSeconds, 300);
  assert.equal(timeline?.finalTimeSeconds, 28800);
});
