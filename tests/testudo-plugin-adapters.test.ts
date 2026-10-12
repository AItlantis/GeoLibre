import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createNetworkKpiPlaybackAdapter, createScenarioComparisonPlaybackAdapter, createScenarioSelectionAdapters, createVehiclePlaybackAdapter, testudoScenarioCatalog, vehiclePlaybackVariantIndex, vehiclePlaybackVariantSelectionId, vehiclePlaybackScenarioRoster, subscribeToPlaybackSources, scenarioRosterMatches } from "../packages/plugins/src/testudo-plugin-adapters";
import { initializeFirstAnimationScenarioIfNeeded, routeTestudoPluginSelection } from "../apps/geolibre-desktop/src/lib/testudo-view-style";

const current = (id: string, generation: number) => id === "main" && generation === 4;

test("vehicle adapter maps plugin ticks and settings to shell playback state", async () => {
  let tick = 2; let playing = false; let speed = 1.5;
  const adapter = createVehiclePlaybackAdapter({
    getStatus: () => ({ loading: false, maxTick: 20, dt: 0.8, error: null, available: true, initialTimeSeconds: 100, simulationDurationSeconds: 30 }),
    getSettings: () => ({ tick, playing, speed, loop: true }), setTick: value => { tick = value; },
    setSettings: value => { if (value.playing !== undefined) playing = value.playing; if (value.speed !== undefined) speed = value.speed; return true; },
    setScenario: async () => {},
  }, current);
  assert.deepEqual(adapter.getPlaybackState("main", 4), { available: true, loading: false, playing: false, tick: 2, maxTick: 20, speed: 1.5, dt: 0.8, loop: true, canPlay: true, timeline: { currentTimeSeconds: 101.6, sampledStartSeconds: 100, sampledEndSeconds: 116, simulationDurationSeconds: 30, isAggregate: false } });
  await adapter.seek("main", 4, 30); assert.equal(tick, 20);
  await adapter.play("main", 4); assert.equal(playing, true);
  await adapter.restart("main", 4); assert.equal(tick, 0);
  assert.throws(() => adapter.getPlaybackState("main", 3), /stale/);
});

test("host Results scenario roster keeps each SCID's own replication metadata", () => {
  const controls = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(controls, /const declared = new Map\(declaredScenarioRoster\.map\(row => \[String\(row\.scenarioId \?\? row\.id\), row\]\)\)/);
  assert.match(controls, /return rows\.map\(row => \{\s*const own = declared\.get\(String\(row\.scid\)\);\s*return \{ \...\(own \?\? \{\}\), id: String\(row\.scid\)/);
  const roster = testudoScenarioCatalog([
    { scid: 45001, name: "A1", replications: [{ did: 49342, didname: "A1" }] },
    { scid: 49414, name: "B", replications: [{ did: 49418, didname: "B" }] },
    { scid: 45002, name: "A2", replications: [{ did: 49468, didname: "A2" }] },
  ]);
  assert.deepEqual(roster.map(({ scenarioId, did, replications }) => ({ scenarioId, did, replications })), [
    { scenarioId: 45001, did: 49342, replications: [{ id: 49342, label: "A1" }] },
    { scenarioId: 49414, did: 49418, replications: [{ id: 49418, label: "B" }] },
    { scenarioId: 45002, did: 49468, replications: [{ id: 49468, label: "A2" }] },
  ]);
});

test("Results to Animation plugin-tab route initializes a scenario and enables advancing playback", async () => {
  const receiver = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(receiver, /if \(mode === "animation"\)[\s\S]*initializeFirstAnimationScenarioIfNeeded\(playback\.scenarioIndex, playback\.scenarios\.length[\s\S]*plugins\.setVehiclePlaybackScenario\(index\)/);
  const modes = ["results", "animation"] as const;
  let selectedMode: string = "results";
  const scenarios = [{ scid: 4101 }, { scid: 4102 }];
  let selectedScenario = -1; let tick = 0; let playing = false;
  const setScenario = async (index: number) => { selectedScenario = index; tick = 0; };
  const adapter = createVehiclePlaybackAdapter({
    getStatus: () => ({ loading: false, maxTick: selectedScenario >= 0 ? 8 : 0, dt: 0.8, error: null, available: selectedScenario >= 0, initialTimeSeconds: 100, simulationDurationSeconds: 6.4 }),
    getSettings: () => ({ tick, playing, speed: 1, loop: false }),
    setTick: value => { tick = value; },
    setSettings: value => { if (value.playing !== undefined) playing = value.playing; return true; },
  }, current, { tviewId: "main", generation: 4 });
  await routeTestudoPluginSelection("network-kpi", async mode => { assert.ok(modes.includes(mode as typeof modes[number])); selectedMode = mode; return selectedMode; }, async plugin => plugin);
  assert.equal(selectedMode, "results", "the Results tab uses the mode path");
  await routeTestudoPluginSelection("vehicle-playback", async mode => {
    assert.ok(modes.includes(mode as typeof modes[number]));
    selectedMode = mode;
    if (mode === "animation") await initializeFirstAnimationScenarioIfNeeded(selectedScenario, scenarios.length, setScenario);
    return selectedMode;
  }, async plugin => plugin);
  const initialized = adapter.getPlaybackState("main", 4);
  assert.equal(selectedMode, "animation");
  assert.equal(selectedScenario, 0, "Animation mode selection initializes the first declared scenario");
  assert.ok(initialized.maxTick > 0);
  assert.equal(initialized.canPlay, true);
  await adapter.seek("main", 4, 2);
  assert.equal(adapter.getPlaybackState("main", 4).tick, 2, "playback advances after the plugin tab routes through Animation mode");
});

test("KPI interval adapter exposes ordinal ticks and advances with the original interval API", async () => {
  const intervals = [0, 5, 10]; let interval = 0; let playing = false; let playbackSpeed = 2; const steps: number[] = [];
  const adapter = createNetworkKpiPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals, error: null, dt: 60, sampleTimes: [{ value: 5, timeSeconds: 100 }, { value: 10, timeSeconds: 220 }], simulationDurationSeconds: 300 }),
    getSettings: () => ({ interval, intervalPlaying: playing, playbackSpeed, loop: true }),
    setSettings: value => { if (value.interval !== undefined) interval = value.interval; if (value.intervalPlaying !== undefined) playing = value.intervalPlaying; if (value.playbackSpeed !== undefined) playbackSpeed = value.playbackSpeed; return true; },
    stepNetworkKpiInterval: direction => { steps.push(direction); const i = intervals.indexOf(interval); interval = intervals[(i + direction + intervals.length) % intervals.length]; },
    setScenario: async () => {},
  }, current);
  assert.equal(adapter.getPlaybackState("main", 4).maxTick, 1);
  assert.equal(adapter.getPlaybackState("main", 4).dt, 60);
  await adapter.seek("main", 4, 2); assert.equal(interval, 10); assert.deepEqual(steps, [1, 1]);
  assert.deepEqual(adapter.getPlaybackState("main", 4).timeline, { currentTimeSeconds: 220, sampledStartSeconds: 100, sampledEndSeconds: 220, simulationDurationSeconds: 300, isAggregate: false });
  await adapter.setSpeed("main", 4, 3); assert.equal(playbackSpeed, 3);
  await adapter.pause("main", 4); assert.equal(playing, false);
});

test("single real interval remains seekable from aggregate while playback is disabled", async () => {
  const intervals = [0, 7]; let interval = 0; let playing = false;
  const adapter = createNetworkKpiPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals, error: null, sampleTimes: [{ value: 7, timeSeconds: 12 }], simulationDurationSeconds: 30 }),
    getSettings: () => ({ interval, intervalPlaying: playing, playbackSpeed: 1, loop: true }),
    setSettings: value => { if (value.interval !== undefined) interval = value.interval; if (value.intervalPlaying !== undefined) playing = value.intervalPlaying; },
    stepNetworkKpiInterval: () => { throw new Error("single sample must be selected directly"); },
  }, current);
  assert.equal(adapter.getPlaybackState("main", 4).canPlay, false);
  await adapter.seek("main", 4, 0); assert.equal(interval, 7);
  assert.equal(adapter.getPlaybackState("main", 4).timeline.isAggregate, false);
  await adapter.restart("main", 4); assert.equal(interval, 7); assert.equal(playing, false);
});

test("comparison playback maps matched intervals and scenario selection updates the pair", async () => {
  const intervals = [0, 2, 4]; let interval = 2; let scenarioA = 0; let scenarioB = 1; const steps: number[] = [];
  const adapter = createScenarioComparisonPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals, error: null, matchedIntervals: [{ entA: 2, timeSeconds: 145 }, { entA: 4, timeSeconds: 205 }] }),
    getSettings: () => ({ interval, intervalPlaying: false, playbackSpeed: 1, loop: true, scenarioA, scenarioB }),
    setSettings: value => { if (value.interval !== undefined) interval = value.interval; if (value.scenarioA !== undefined) scenarioA = value.scenarioA; if (value.scenarioB !== undefined) scenarioB = value.scenarioB; },
    stepScenarioComparisonInterval: direction => { steps.push(direction); interval = intervals[(intervals.indexOf(interval) + 1) % intervals.length]; },
  }, current);
  assert.equal(adapter.getPlaybackState("main", 4).available, true);
  await adapter.seek("main", 4, 1); assert.equal(interval, 4); assert.deepEqual(steps, [1]);
  assert.deepEqual(adapter.getPlaybackState("main", 4).timeline, { currentTimeSeconds: 205, sampledStartSeconds: 145, sampledEndSeconds: 205, simulationDurationSeconds: null, isAggregate: false });
  const selected: unknown[] = [];
  const scenarios = createScenarioSelectionAdapters({ setNetworkKpiScenario: async i => { selected.push(["kpi", i]); }, setVehiclePlaybackScenario: async i => { selected.push(["vehicle", i]); }, setScenarioComparisonSettings: pair => selected.push(["comparison", pair]) });
  await scenarios.networkKpi(2); await scenarios.vehiclePlayback(1); scenarios.comparison(1, 2);
  assert.deepEqual(selected, [["kpi", 2], ["vehicle", 1], ["comparison", { scenarioA: 1, scenarioB: 2 }]]);
});


test("scenario selection adapter awaits failures instead of acknowledging success", async () => {
  const adapter = createScenarioSelectionAdapters({
    setNetworkKpiScenario: async () => { throw new Error("KPI read failed"); },
    setVehiclePlaybackScenario: async () => { throw new Error("animation chunk failed"); },
    setScenarioComparisonSettings: async () => { throw new Error("comparison read failed"); },
  });
  await assert.rejects(adapter.networkKpi(0), /KPI read failed/);
  await assert.rejects(adapter.vehiclePlayback(0), /animation chunk failed/);
  await assert.rejects(adapter.comparison(0, 1), /comparison read failed/);
});


test("aggregate interval has no point time and one sampled result is viewable but cannot play", async () => {
  let playing = false; const one = createNetworkKpiPlaybackAdapter({
    getStatus: () => ({ loading: false, intervals: [0, 7], error: null, sampleTimes: [{ value: 7, timeSeconds: 555 }], simulationDurationSeconds: 600 }),
    getSettings: () => ({ interval: 0, intervalPlaying: playing, playbackSpeed: 1, loop: true }),
    setSettings: value => { if (value.intervalPlaying !== undefined) playing = value.intervalPlaying; },
    stepNetworkKpiInterval: () => {},
  }, current);
  const aggregate = one.getPlaybackState("main", 4);
  assert.equal(aggregate.available, true); assert.equal(aggregate.canPlay, false);
  assert.equal(aggregate.timeline.currentTimeSeconds, null);
  assert.equal(aggregate.timeline.sampledStartSeconds, 555);
  assert.equal(aggregate.timeline.sampledEndSeconds, 555);
  assert.equal(aggregate.timeline.simulationDurationSeconds, 600);
  await one.play("main", 4); assert.equal(playing, false);
});

test("vehicle variant IDs remain distinct for shared SCID/DID and stable across row reorder", () => {
  const am = { id: "AM", variantId: "animations/am.json", scid: 41, did: 8 };
  const pm = { id: "PM", variantId: "animations/pm.json", scid: 41, did: 8 };
  const amId = vehiclePlaybackVariantSelectionId(am); const pmId = vehiclePlaybackVariantSelectionId(pm);
  assert.notEqual(amId, pmId);
  assert.equal(vehiclePlaybackVariantSelectionId({ ...am }), amId);
  assert.equal(vehiclePlaybackVariantIndex([pm, am], amId), 1);
  assert.equal(vehiclePlaybackVariantIndex([pm, am], pmId), 0);
  const roster = vehiclePlaybackScenarioRoster([am, pm]);
  assert.deepEqual(roster.map(({ id, scenarioId, did, variantId }) => ({ id, scenarioId, did, variantId })), [
    { id: amId, scenarioId: 41, did: 8, variantId: "animations/am.json" },
    { id: pmId, scenarioId: 41, did: 8, variantId: "animations/pm.json" },
  ]);
});


test("vehicle playback subscription relays advancing ticks even when status counts stay unchanged", () => {
  const stateListeners: Array<() => void> = []; const statusListeners: Array<() => void> = [];
  const removed = { state: 0, status: 0 }; let tick = 0; const observed: number[] = [];
  const adapter = createVehiclePlaybackAdapter({
    getStatus: () => ({ loading: false, maxTick: 20, dt: 0.1, error: null, available: true }),
    getSettings: () => ({ tick, playing: true, speed: 1, loop: true }),
    setTick: value => { tick = value; }, setSettings: () => true,
    subscribe: listener => subscribeToPlaybackSources([
      stateListener => { stateListeners.push(stateListener); return () => { removed.state++; }; },
      statusListener => { statusListeners.push(statusListener); return () => { removed.status++; }; },
    ], listener),
  }, current, { tviewId: "main", generation: 4 });
  const unsubscribe = adapter.subscribe((_, __, playback) => observed.push(playback.tick));
  tick = 1; stateListeners[0]();
  assert.deepEqual(observed, [1], "state ticks reach the host without a status change");
  statusListeners[0](); assert.deepEqual(observed, [1], "an unchanged status callback does not duplicate the full playback snapshot");
  unsubscribe(); assert.deepEqual(removed, { state: 1, status: 1 });
});

test("scenario roster comparison detects only actual identity or label changes", () => {
  const rows = [{ id: "variant-a", label: "AM" }, { id: "variant-b", label: "PM" }];
  assert.equal(scenarioRosterMatches(rows, [...rows]), true);
  assert.equal(scenarioRosterMatches(rows, [rows[1], rows[0]]), false);
  assert.equal(scenarioRosterMatches(rows, [{ ...rows[0], label: "Morning" }, rows[1]]), false);
});


test("scenario catalog publishes manifest names while retaining SCID identity", () => {
  const roster = testudoScenarioCatalog([{ scid: 41, name: "Morning peak" }, { scid: "42", name: "Evening peak" }]);
  assert.deepEqual(roster, [
    { id: "41", label: "Morning peak", scenarioId: 41 },
    { id: "42", label: "Evening peak", scenarioId: "42" },
  ]);
});


test("vehicle playback event source fans state and status changes into timeline updates", () => {
  let tick = 0; let stateChanged: (() => void) | undefined; let statusChanged: (() => void) | undefined;
  const emitted: number[] = [];
  const adapter = createVehiclePlaybackAdapter({
    getStatus: () => ({ loading: false, maxTick: 4, dt: 2, error: null, available: true, initialTimeSeconds: 10, simulationDurationSeconds: 8 }),
    getSettings: () => ({ tick, playing: true, speed: 1, loop: false }),
    setTick: value => { tick = value; }, setSettings: () => true,
  }, current);
  const unsubscribe = subscribeToPlaybackSources([
    listener => { stateChanged = listener; return () => { stateChanged = undefined; }; },
    listener => { statusChanged = listener; return () => { statusChanged = undefined; }; },
  ], () => emitted.push(adapter.getPlaybackState("main", 4).timeline.currentTimeSeconds ?? -1));
  tick = 1; stateChanged?.();
  tick = 3; statusChanged?.();
  assert.deepEqual(emitted, [12, 16]);
  unsubscribe();
  assert.equal(stateChanged, undefined); assert.equal(statusChanged, undefined);
});

test("KPI playback observes settings and status, deduplicates snapshots, and drops stale callbacks before reading", () => {
  let loading = false; let interval = 5; let playing = false; let reads = 0; let current = true;
  let stateChanged: (() => void) | undefined; let statusChanged: (() => void) | undefined;
  const observed: Array<{ tick: number; loading: boolean; playing: boolean }> = [];
  const adapter = createNetworkKpiPlaybackAdapter({
    getStatus: () => { reads++; if (!current) throw new Error("stale status read"); return { loading, intervals: [5, 10], error: null }; },
    getSettings: () => { reads++; if (!current) throw new Error("stale settings read"); return { interval, intervalPlaying: playing, playbackSpeed: 1, loop: true }; },
    setSettings: () => {}, stepNetworkKpiInterval: () => {},
    subscribe: listener => subscribeToPlaybackSources([
      next => { stateChanged = next; return () => { stateChanged = undefined; }; },
      next => { statusChanged = next; return () => { statusChanged = undefined; }; },
    ], listener),
  }, (_id, generation) => current && generation === 4, { tviewId: "main", generation: 4 });
  const unsubscribe = adapter.subscribe((_id, _generation, state) => observed.push({ tick: state.tick, loading: state.loading, playing: state.playing }));
  interval = 10; playing = true; stateChanged?.();
  stateChanged?.(); // Full duplicate snapshot is suppressed.
  loading = true; statusChanged?.();
  assert.deepEqual(observed, [{ tick: 1, loading: false, playing: true }, { tick: 1, loading: true, playing: true }]);
  const readsBeforeStaleCallback = reads;
  current = false;
  assert.doesNotThrow(() => { stateChanged?.(); statusChanged?.(); });
  assert.equal(reads, readsBeforeStaleCallback, "stale callbacks must be fenced before plugin getters run");
  unsubscribe();
  assert.equal(stateChanged, undefined); assert.equal(statusChanged, undefined);
});
