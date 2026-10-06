import assert from "node:assert/strict";
import { test } from "node:test";
import { createNetworkKpiPlaybackAdapter, createScenarioComparisonPlaybackAdapter, createScenarioSelectionAdapters, createVehiclePlaybackAdapter } from "../packages/plugins/src/testudo-plugin-adapters";

const current = (id: string, generation: number) => id === "main" && generation === 4;

test("vehicle adapter maps plugin ticks and settings to shell playback state", async () => {
  let tick = 2; let playing = false; let speed = 1.5;
  const adapter = createVehiclePlaybackAdapter({
    getStatus: () => ({ loading: false, maxTick: 20, dt: 0.8, error: null }),
    getSettings: () => ({ tick, playing, speed, loop: true }), setTick: value => { tick = value; },
    setSettings: value => { if (value.playing !== undefined) playing = value.playing; if (value.speed !== undefined) speed = value.speed; return true; },
    setScenario: async () => {},
  }, current);
  assert.deepEqual(adapter.getPlaybackState("main", 4), { available: true, loading: false, playing: false, tick: 2, maxTick: 20, speed: 1.5, dt: 0.8, loop: true });
  await adapter.seek("main", 4, 30); assert.equal(tick, 20);
  await adapter.play("main", 4); assert.equal(playing, true);
  await adapter.restart("main", 4); assert.equal(tick, 0);
  assert.throws(() => adapter.getPlaybackState("main", 3), /stale/);
});

test("KPI interval adapter exposes ordinal ticks and advances with the original interval API", async () => {
  const intervals = [0, 5, 10]; let interval = 0; let playing = false; let playbackSpeed = 2; const steps: number[] = [];
  const adapter = createNetworkKpiPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals, error: null, dt: 60 }),
    getSettings: () => ({ interval, intervalPlaying: playing, playbackSpeed, loop: true }),
    setSettings: value => { if (value.interval !== undefined) interval = value.interval; if (value.intervalPlaying !== undefined) playing = value.intervalPlaying; if (value.playbackSpeed !== undefined) playbackSpeed = value.playbackSpeed; return true; },
    stepNetworkKpiInterval: direction => { steps.push(direction); const i = intervals.indexOf(interval); interval = intervals[(i + direction + intervals.length) % intervals.length]; },
    setScenario: async () => {},
  }, current);
  assert.equal(adapter.getPlaybackState("main", 4).maxTick, 1);
  assert.equal(adapter.getPlaybackState("main", 4).dt, 60);
  await adapter.seek("main", 4, 2); assert.equal(interval, 10); assert.deepEqual(steps, [1, 1]);
  await adapter.setSpeed("main", 4, 3); assert.equal(playbackSpeed, 3);
  await adapter.pause("main", 4); assert.equal(playing, false);
});

test("comparison playback maps matched intervals and scenario selection updates the pair", async () => {
  const intervals = [0, 2]; let interval = 0; let scenarioA = 0; let scenarioB = 1; const steps: number[] = [];
  const adapter = createScenarioComparisonPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals, error: null, matchedIntervals: [{}, {}] }),
    getSettings: () => ({ interval, intervalPlaying: false, playbackSpeed: 1, loop: true, scenarioA, scenarioB }),
    setSettings: value => { if (value.interval !== undefined) interval = value.interval; if (value.scenarioA !== undefined) scenarioA = value.scenarioA; if (value.scenarioB !== undefined) scenarioB = value.scenarioB; },
    stepScenarioComparisonInterval: direction => { steps.push(direction); interval = intervals[1 - intervals.indexOf(interval)]; },
  }, current);
  assert.equal(adapter.getPlaybackState("main", 4).available, true);
  await adapter.seek("main", 4, 1); assert.equal(interval, 2); assert.deepEqual(steps, [1]);
  const selected: unknown[] = [];
  const scenarios = createScenarioSelectionAdapters({ setNetworkKpiScenario: async i => { selected.push(["kpi", i]); }, setVehiclePlaybackScenario: async i => { selected.push(["vehicle", i]); }, setScenarioComparisonSettings: pair => selected.push(["comparison", pair]) });
  await scenarios.networkKpi(2); await scenarios.vehiclePlayback(1); scenarios.comparison(1, 2);
  assert.deepEqual(selected, [["kpi", 2], ["vehicle", 1], ["comparison", { scenarioA: 1, scenarioB: 2 }]]);
});
