import test from "node:test";
import assert from "node:assert/strict";
import { formatSimClock, tickTimelineProps } from "./useTickPlayback";

test("formatSimClock formats the scenario clock as hours, minutes, and seconds", () => {
  assert.equal(formatSimClock(0, 1), "00:00:00");
  assert.equal(formatSimClock(65, 1), "00:01:05");
  assert.equal(formatSimClock(3661, 1), "01:01:01");
});

test("formatSimClock scales by dt seconds-per-tick", () => {
  assert.equal(formatSimClock(30, 2), "00:01:00"); // 30 ticks * 2s/tick = 60s
});

test("formatSimClock uses the selected scenario's initial simulation time", () => {
  assert.equal(formatSimClock(5, 2, 28_800), "08:00:10");
});

test("formatSimClock clamps negative results to zero", () => {
  assert.equal(formatSimClock(-5, 1), "00:00:00");
});

test("formatSimClock rounds fractional seconds", () => {
  assert.equal(formatSimClock(1.6, 1), "00:00:02");
});

test("tickTimelineProps guards against a zero-width range before a package loads", () => {
  const props = tickTimelineProps(0, 0, false);
  assert.equal(props.max, 1);
  assert.equal(props.disabled, true);
});

test("tickTimelineProps reflects an active package", () => {
  const props = tickTimelineProps(12.4, 100, true);
  assert.equal(props.max, 100);
  assert.equal(props.value, 12);
  assert.equal(props.disabled, false);
  assert.equal(props.min, 0);
  assert.equal(props.step, 1);
});
