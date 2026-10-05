import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedFeatureRegistry } from "../packages/plugins/src/shared-features";

test("shared feature commands read and mutate provider-owned playback and scenario state", async () => {
  const registry = new SharedFeatureRegistry();
  const source = {
    playback: { available: true, playing: false, tick: 0, maxTick: 9, speed: 1, dt: 1, loop: true },
    scenario: { available: true, scenarios: [{ id: 1, label: "Base" }, { id: 2, label: "Scheme" }], selectedScenario: 1 as string | number },
    viewMode: { available: true, modes: ["animation", "flow"], selectedMode: "animation" },
    networkFilters: { available: true, filters: { interval: 0 as number | string | boolean | null } },
    progress: { available: true, stage: "artifact-download", loadedBytes: 12, totalBytes: 0 },
  };
  const release = registry.register("test-playback", {
    playback: {
      getState: () => source.playback,
      setPlaying: playing => { source.playback.playing = playing; },
      restart: () => { source.playback.playing = false; source.playback.tick = 0; },
      seek: tick => { source.playback.tick = tick; },
      setSpeed: speed => { source.playback.speed = speed; },
    },
    scenario: {
      getState: () => source.scenario,
      select: scenarioId => { source.scenario.selectedScenario = scenarioId; },
    },
    viewMode: {
      getState: () => source.viewMode,
      setMode: mode => { source.viewMode.selectedMode = mode; },
    },
    networkFilters: {
      getState: () => source.networkFilters,
      setFilters: filters => { source.networkFilters.filters = filters; },
    },
    progress: { getState: () => source.progress },
  });
  const observed: string[] = [];
  const unsubscribe = registry.subscribe(snapshot => observed.push(`${snapshot.playback?.tick}:${snapshot.scenario?.selectedScenario}:${snapshot.viewMode?.selectedMode}`));

  assert.equal(registry.getSnapshot().playback?.tick, 0);
  await registry.setPlaybackPlaying(true);
  assert.equal(registry.getSnapshot().playback?.playing, true);
  await registry.seekPlayback(6);
  assert.equal(source.playback.tick, 6);
  assert.equal(registry.getSnapshot().playback?.tick, 6);
  await registry.selectScenario(2);
  assert.equal(source.scenario.selectedScenario, 2);
  await registry.setViewMode("flow");
  await registry.setNetworkFilters({ interval: 3, section_id: "12" });
  assert.deepEqual(registry.getSnapshot().networkFilters?.filters, { interval: 3, section_id: "12" });
  assert.deepEqual(registry.getSnapshot().progress, { available: true, stage: "artifact-download", loadedBytes: 12, totalBytes: 0 });
  assert.ok(observed.length >= 5);

  unsubscribe();
  release();
  assert.deepEqual(registry.getSnapshot(), {});
});

test("map controls, view modes, and filters share stable provider command seams", async () => {
  const registry = new SharedFeatureRegistry();
  let controlVisible = false;
  let viewMode = "animation";
  let filters: Record<string, string | number | boolean | null> = {};
  const release = registry.register("map-plugin", {
    mapControls: {
      getState: () => ({ available: true, renderer: "maplibre", controls: { navigation: controlVisible } }),
      setControl: (_control, visible) => { controlVisible = visible; },
    },
    viewMode: {
      getState: () => ({ available: true, modes: ["animation", "flow"], selectedMode: viewMode }),
      setMode: mode => { viewMode = mode; },
    },
    networkFilters: {
      getState: () => ({ available: true, filters }),
      setFilters: value => { filters = value; },
    },
  });

  assert.equal((await registry.setMapControl("navigation", true)).controls.navigation, true);
  assert.equal((await registry.setViewMode("flow")).selectedMode, "flow");
  assert.deepEqual((await registry.setNetworkFilters({ scenario: 2 })).filters, { scenario: 2 });
  await assert.rejects(registry.setMapControl("bad control", true), /invalid/i);

  release();
  assert.deepEqual(registry.getSnapshot(), {});
});

test("shared feature arbitration prefers available higher-priority providers and restores fallback after cleanup", async () => {
  const registry = new SharedFeatureRegistry();
  let packageAvailable = false;
  const routePlayback = { getState: () => ({ available: true, playing: false, tick: 2, maxTick: 2, speed: 1, dt: 1, loop: true }) };
  const packagePlayback = {
    getState: () => ({ available: packageAvailable, playing: false, tick: 0, maxTick: 8, speed: 1, dt: 0.8, loop: true }),
    subscribe: (listener: () => void) => { packageChanged = listener; return () => { packageChanged = undefined; }; },
  };
  let packageChanged: (() => void) | undefined;
  const releaseRoute = registry.register("route-animation", { playback: routePlayback });
  const releasePackage = registry.register("testudo-package", { playback: packagePlayback }, { priority: 100 });
  assert.equal(registry.getSnapshot().playback?.tick, 2);
  packageAvailable = true;
  packageChanged?.();
  assert.equal(registry.getSnapshot().playback?.tick, 0);
  await assert.rejects(registry.seekPlayback(-1), /non-negative/);
  await assert.rejects(registry.setPlaybackSpeed(21), /between 0.25 and 20/);
  releasePackage();
  assert.equal(registry.getSnapshot().playback?.tick, 2);
  releaseRoute();
  assert.equal(registry.getSnapshot().playback, undefined);
});

test("provider activation order cannot hide the route fallback or let one disposer remove another", () => {
  const registry = new SharedFeatureRegistry();
  let packageAvailable = false;
  const releasePackage = registry.register("testudo-package", {
    playback: { getState: () => ({ available: packageAvailable, playing: false, tick: 0, maxTick: 8, speed: 1, dt: 1, loop: true }) },
  }, { priority: 100 });
  const releaseRoute = registry.register("route-animation", {
    playback: { getState: () => ({ available: true, playing: false, tick: 7, maxTick: 1000, speed: 1, dt: 0.001, loop: true }) },
  });
  assert.equal(registry.getSnapshot().playback?.tick, 7);
  packageAvailable = true;
  assert.equal(registry.getSnapshot().playback?.tick, 0);
  releaseRoute();
  assert.equal(registry.getSnapshot().playback?.tick, 0);
  releasePackage();
  assert.equal(registry.getSnapshot().playback, undefined);
});

test("different plugins can contribute separate capabilities and clean up by owner", () => {
  const registry = new SharedFeatureRegistry();
  const releasePlayback = registry.register("playback-plugin", {
    playback: { getState: () => ({ available: true, playing: true, tick: 2, maxTick: 4, speed: 1, dt: 1, loop: false }) },
  });
  registry.register("scenario-plugin", {
    scenario: { getState: () => ({ available: true, scenarios: [{ id: "base", label: "Base" }], selectedScenario: "base" }) },
  });

  assert.equal(registry.getSnapshot().playback?.tick, 2);
  assert.equal(registry.getSnapshot().scenario?.selectedScenario, "base");
  registry.removeOwner("playback-plugin");
  assert.equal(registry.getSnapshot().playback, undefined);
  assert.equal(registry.getSnapshot().scenario?.selectedScenario, "base");
  releasePlayback(); // A stale disposer must not remove another owner's capability.
  assert.equal(registry.getSnapshot().scenario?.selectedScenario, "base");
  registry.removeOwner("scenario-plugin");
  assert.deepEqual(registry.getSnapshot(), {});
});

test("observable playback providers publish state changes and unsubscribe with their owner", () => {
  const registry = new SharedFeatureRegistry();
  let playing = false;
  let changed: (() => void) | undefined;
  let providerUnsubscribed = false;
  const release = registry.register("observable-playback", {
    playback: {
      getState: () => ({ available: true, playing, tick: 0, maxTick: 1, speed: 1, dt: 1, loop: false }),
      subscribe: listener => { changed = listener; return () => { providerUnsubscribed = true; }; },
    },
  });
  const states: boolean[] = [];
  registry.subscribe(snapshot => states.push(snapshot.playback?.playing ?? false));

  playing = true;
  changed?.();
  assert.deepEqual(states, [true]);
  release();
  assert.equal(providerUnsubscribed, true);
  playing = false;
  changed?.();
  assert.deepEqual(states, [true, false, false]); // Registry removal emits the final empty snapshot.
  assert.deepEqual(registry.getSnapshot(), {});
});
