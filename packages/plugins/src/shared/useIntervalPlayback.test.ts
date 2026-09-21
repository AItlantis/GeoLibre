import test from "node:test";
import assert from "node:assert/strict";
import { deriveIntervalPlayback, stepInterval, toggleAggregateInterval } from "./useIntervalPlayback";

test("deriveIntervalPlayback filters out the aggregate sentinel", () => {
  const result = deriveIntervalPlayback([0, 10, 20, 30], 20);
  assert.deepEqual(result.realIntervals, [10, 20, 30]);
  assert.equal(result.scrubberIndex, 1);
  assert.equal(result.hasRealIntervals, true);
  assert.equal(result.isAggregate, false);
});

test("deriveIntervalPlayback reports the aggregate as active when interval is 0", () => {
  const result = deriveIntervalPlayback([0, 10, 20], 0);
  assert.equal(result.isAggregate, true);
  assert.equal(result.scrubberIndex, 0); // clamped, since 0 isn't in realIntervals
});

test("deriveIntervalPlayback with no real intervals reports hasRealIntervals false", () => {
  const result = deriveIntervalPlayback([0], 0);
  assert.deepEqual(result.realIntervals, []);
  assert.equal(result.hasRealIntervals, false);
});

test("stepInterval returns null with fewer than two real intervals", () => {
  assert.equal(stepInterval([0], 0, 1), null);
  assert.equal(stepInterval([0, 10], 10, 1), null);
});

test("stepInterval wraps forward and backward", () => {
  const intervals = [0, 10, 20, 30];
  assert.equal(stepInterval(intervals, 10, 1), 20);
  assert.equal(stepInterval(intervals, 30, 1), 10); // wraps
  assert.equal(stepInterval(intervals, 10, -1), 30); // wraps backward
});

test("stepInterval starting from the aggregate begins at the first/last real frame", () => {
  const intervals = [0, 10, 20, 30];
  assert.equal(stepInterval(intervals, 0, 1), 10);
  assert.equal(stepInterval(intervals, 0, -1), 30);
});

test("toggleAggregateInterval checked selects the sentinel", () => {
  assert.equal(toggleAggregateInterval([0, 10, 20], true), 0);
});

test("toggleAggregateInterval unchecked falls back to the first real interval", () => {
  assert.equal(toggleAggregateInterval([0, 10, 20], false), 10);
});

test("toggleAggregateInterval unchecked with no real intervals falls back to 0", () => {
  assert.equal(toggleAggregateInterval([0], false), 0);
});
