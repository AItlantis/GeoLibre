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

test("shared feature registry rejects duplicate live providers and enforces playback bounds", async () => {
  const registry = new SharedFeatureRegistry();
  const playback = { getState: () => ({ available: true, playing: false, tick: 0, maxTick: 2, speed: 1, dt: 1, loop: true }) };
  registry.register("first", { playback });
  assert.throws(() => registry.register("second", { playback }), /already provided/);
  await assert.rejects(registry.seekPlayback(-1), /non-negative/);
  await assert.rejects(registry.setPlaybackSpeed(21), /between 0.25 and 20/);
  registry.removeOwner("first");
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
