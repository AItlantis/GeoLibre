import type { TestudoPlaybackFeature, TestudoPlaybackState, TestudoScenario } from "./shared/testudo-feature-session";

export function subscribeToPlaybackSources(sources: readonly (((listener: () => void) => () => void) | undefined)[], listener: () => void): () => void {
  const unsubscribers = sources.flatMap(source => source ? [source(listener)] : []);
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}

export function scenarioRosterMatches(left: readonly { id: string; label: string }[], right: readonly { id: string; label: string }[]): boolean {
  return left.length === right.length && left.every((row, index) => row.id === right[index]?.id && row.label === right[index]?.label);
}

export interface TestudoVehiclePlaybackApi {
  getStatus(): { loading: boolean; maxTick: number; dt: number; error: string | null; available?: boolean; initialTimeSeconds?: number | null; simulationDurationSeconds?: number | null };
  getSettings(): { tick: number; playing: boolean; speed: number; loop: boolean };
  setTick(tick: number): void;
  setSettings(settings: { playing?: boolean; speed?: number }): boolean;
  setScenario?(index: number): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface TestudoIntervalPlaybackApi {
  getStatus(): { loading: boolean; intervals: number[]; error: string | null; dt?: number | null; sampleTimes?: Array<{ value: number; timeSeconds: number }>; simulationDurationSeconds?: number | null };
  getSettings(): { interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean };
  setSettings(settings: { interval?: number; intervalPlaying?: boolean; playbackSpeed?: number }): boolean | void;
  stepNetworkKpiInterval(direction: 1 | -1): void;
  setScenario?(index: number): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface TestudoScenarioComparisonApi {
  getStatus(): { loading: boolean; intervals: number[]; error: string | null; matchedIntervals: Array<{ entA: number; timeSeconds: number }>; dt?: number | null; simulationDurationSeconds?: number | null };
  getSettings(): { interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean; scenarioA: number; scenarioB: number };
  setSettings(settings: { interval?: number; intervalPlaying?: boolean; playbackSpeed?: number; scenarioA?: number; scenarioB?: number }): void;
  stepScenarioComparisonInterval(direction: 1 | -1): void;
  subscribe?(listener: () => void): () => void;
}

export type TestudoGenerationGuard = (tviewId: string, generation: number) => boolean;
export interface TestudoPlaybackScope { tviewId: string; generation: number }

function assertGeneration(isCurrent: TestudoGenerationGuard, tviewId: string, generation: number): void {
  if (!isCurrent(tviewId, generation)) throw new Error("Playback command belongs to a stale Testudo package.");
}

function subscribePlaybackSnapshot(
  subscribe: ((listener: () => void) => () => void) | undefined,
  isCurrent: TestudoGenerationGuard,
  scope: TestudoPlaybackScope,
  read: () => TestudoPlaybackState,
  listener: (tviewId: string, generation: number, state: TestudoPlaybackState) => void,
): () => void {
  if (!subscribe) return () => {};
  let lastSignature: string | undefined;
  return subscribe(() => {
    // Timer callbacks may arrive after package replacement. Fence before the
    // adapter touches plugin settings/status, whose getters are package scoped.
    if (!isCurrent(scope.tviewId, scope.generation)) return;
    const state = read();
    const signature = JSON.stringify(state);
    if (signature === lastSignature) return;
    lastSignature = signature;
    listener(scope.tviewId, scope.generation, state);
  });
}

type PlaybackTime = { currentTimeSeconds: number | null; sampledStartSeconds: number | null; sampledEndSeconds: number | null; simulationDurationSeconds: number | null; isAggregate: boolean };
type TimeSample = { value: number; timeSeconds: number };

function playbackTime(samples: readonly TimeSample[], selectedValue: number, durationSeconds: number | null): PlaybackTime {
  const valid = samples.filter(sample => sample.value !== 0 && Number.isFinite(sample.timeSeconds)).map(sample => sample.timeSeconds);
  const currentTimeSeconds = selectedValue === 0 ? null : samples.find(sample => sample.value === selectedValue)?.timeSeconds ?? null;
  return { currentTimeSeconds, sampledStartSeconds: valid.length ? valid.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY) : null, sampledEndSeconds: valid.length ? valid.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY) : null, simulationDurationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null, isAggregate: selectedValue === 0 };
}

function toShellState(loading: boolean, available: boolean, playing: boolean, tick: number, maxTick: number, speed: number, dt: number, loop: boolean, time: PlaybackTime, canPlay: boolean): TestudoPlaybackState {
  return { available, loading, playing, tick: Number.isFinite(tick) ? Math.max(0, tick) : 0,
    maxTick: Number.isFinite(maxTick) ? Math.max(0, maxTick) : 0, speed: Number.isFinite(speed) ? speed : 1,
    dt: Number.isFinite(dt) && dt >= 0 ? dt : 0, loop, timeline: time, canPlay };
}

/** Adapt the original vehicle-playback clock to the Testudo shell clock. */
export function createVehiclePlaybackAdapter(api: TestudoVehiclePlaybackApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const getPlaybackState = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const status = api.getStatus(); const settings = api.getSettings();
    const origin = status.initialTimeSeconds ?? null;
    const sampleEnd = origin === null ? null : origin + Math.max(0, status.maxTick) * status.dt;
    const current = origin !== null && settings.tick >= 0 && settings.tick <= status.maxTick ? origin + settings.tick * status.dt : null;
    const time = { currentTimeSeconds: current, sampledStartSeconds: origin, sampledEndSeconds: sampleEnd, simulationDurationSeconds: status.simulationDurationSeconds ?? Math.max(0, status.maxTick) * status.dt, isAggregate: false };
    return toShellState(status.loading, status.available ?? status.maxTick > 0, settings.playing, settings.tick, status.maxTick, settings.speed, status.dt, settings.loop, time, status.maxTick > 0);
  };
  const patch = (tviewId: string, generation: number, change: { playing?: boolean; speed?: number }) => {
    assertGeneration(isCurrent, tviewId, generation); api.setSettings(change); return getPlaybackState(tviewId, generation);
  };
  return {
    getPlaybackState,
    play: (id, generation) => patch(id, generation, { playing: true }),
    pause: (id, generation) => patch(id, generation, { playing: false }),
    restart: (id, generation) => { assertGeneration(isCurrent, id, generation); api.setSettings({ playing: false }); api.setTick(0); return getPlaybackState(id, generation); },
    seek: (id, generation, tick) => { assertGeneration(isCurrent, id, generation); api.setTick(Math.min(api.getStatus().maxTick, tick)); return getPlaybackState(id, generation); },
    setSpeed: (id, generation, speed) => patch(id, generation, { speed }),
    subscribe: listener => subscribePlaybackSnapshot(api.subscribe, isCurrent, scope,
      () => getPlaybackState(scope.tviewId, scope.generation), listener),
  };
}

/** Adapt interval-based KPI settings to an ordinal shell tick. */
export function createNetworkKpiPlaybackAdapter(api: TestudoIntervalPlaybackApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const state = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const status = api.getStatus(); const settings = api.getSettings();
    const intervals = status.intervals.filter(value => Number.isFinite(value) && value !== 0);
    const tick = Math.max(0, intervals.indexOf(settings.interval));
    const samples = status.sampleTimes ?? [];
    const time = playbackTime(samples, settings.interval, status.simulationDurationSeconds ?? null);
    return toShellState(status.loading, intervals.length > 0 && !status.error, settings.intervalPlaying, tick, Math.max(0, intervals.length - 1), settings.playbackSpeed, status.dt ?? 1, settings.loop, time, intervals.length > 1);
  };
  const set = (tviewId: string, generation: number, value: { intervalPlaying?: boolean; playbackSpeed?: number; interval?: number }) => {
    assertGeneration(isCurrent, tviewId, generation); api.setSettings(value); return state(tviewId, generation);
  };
  const seek = (tviewId: string, generation: number, tick: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const intervals = api.getStatus().intervals.filter(value => Number.isFinite(value) && value !== 0);
    const index = Math.max(0, Math.min(intervals.length - 1, Math.trunc(tick)));
    if (intervals.length === 1) {
      api.setSettings({ interval: intervals[0] });
    } else if (intervals.length) {
      const current = intervals.indexOf(api.getSettings().interval);
      const direction = index >= current ? 1 : -1;
      for (let step = current; step !== index; step += direction) api.stepNetworkKpiInterval(direction);
    }
    return state(tviewId, generation);
  };
  return {
    getPlaybackState: state,
    play: (id, generation) => state(id, generation).canPlay ? set(id, generation, { intervalPlaying: true }) : state(id, generation),
    pause: (id, generation) => set(id, generation, { intervalPlaying: false }),
    restart: (id, generation) => { assertGeneration(isCurrent, id, generation); api.setSettings({ intervalPlaying: false }); return seek(id, generation, 0); },
    seek,
    setSpeed: (id, generation, playbackSpeed) => set(id, generation, { playbackSpeed }),
    subscribe: listener => subscribePlaybackSnapshot(api.subscribe, isCurrent, scope,
      () => state(scope.tviewId, scope.generation), listener),
  };
}

/** Scenario comparison owns a pair of scenario indexes and the shared interval clock. */
export function createScenarioComparisonPlaybackAdapter(api: TestudoScenarioComparisonApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const state = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation); const status = api.getStatus(); const settings = api.getSettings();
    const intervals = status.intervals.filter(value => Number.isFinite(value) && value !== 0); const tick = Math.max(0, intervals.indexOf(settings.interval));
    const samples = status.matchedIntervals.map(item => ({ value: item.entA, timeSeconds: item.timeSeconds }));
    const time = playbackTime(samples, settings.interval, status.simulationDurationSeconds ?? null);
    return toShellState(status.loading, status.matchedIntervals.length > 0 && !status.error, settings.intervalPlaying, tick, Math.max(0, intervals.length - 1), settings.playbackSpeed, status.dt ?? 1, settings.loop, time, intervals.length > 1);
  };
  const patch = (id: string, generation: number, change: { intervalPlaying?: boolean; playbackSpeed?: number; interval?: number }) => {
    assertGeneration(isCurrent, id, generation); api.setSettings(change); return state(id, generation);
  };
  const seek = (id: string, generation: number, tick: number) => {
    assertGeneration(isCurrent, id, generation); const intervals = api.getStatus().intervals.filter(value => Number.isFinite(value) && value !== 0);
    const index = Math.max(0, Math.min(intervals.length - 1, Math.trunc(tick)));
    if (intervals.length === 1) api.setSettings({ interval: intervals[0] });
    else if (intervals.length) { const current = intervals.indexOf(api.getSettings().interval); const direction = index >= current ? 1 : -1; for (let step = current; step !== index; step += direction) api.stepScenarioComparisonInterval(direction); }
    return state(id, generation);
  };
  return { getPlaybackState: state, play: (id, gen) => state(id, gen).canPlay ? patch(id, gen, { intervalPlaying: true }) : state(id, gen), pause: (id, gen) => patch(id, gen, { intervalPlaying: false }),
    restart: (id, gen) => { assertGeneration(isCurrent, id, gen); api.setSettings({ intervalPlaying: false }); return seek(id, gen, 0); }, seek,
    setSpeed: (id, gen, playbackSpeed) => patch(id, gen, { playbackSpeed }),
    subscribe: listener => subscribePlaybackSnapshot(api.subscribe, isCurrent, scope,
      () => state(scope.tviewId, scope.generation), listener) };
}

/** Apply one selected scenario or an explicit comparison pair using plugin-owned settings. */
export function createScenarioSelectionAdapters(apis: {
  setNetworkKpiScenario(index: number): Promise<void>;
  setVehiclePlaybackScenario(index: number): Promise<void>;
  setScenarioComparisonSettings(settings: { scenarioA: number; scenarioB: number }): void | Promise<void>;
}) {
  return {
    networkKpi: (index: number) => apis.setNetworkKpiScenario(index),
    vehiclePlayback: (index: number) => apis.setVehiclePlaybackScenario(index),
    comparison: async (scenarioA: number, scenarioB: number) => { await apis.setScenarioComparisonSettings({ scenarioA, scenarioB }); },
  };
}


/** Build one visible/selectable row per animation variant while preserving base model identity. */
export function testudoScenarioCatalog(scenarios: readonly { scid: string | number; name?: string; replications?: readonly { did: number; didname?: string }[] }[]): TestudoScenario[] {
  return scenarios.map(scenario => {
    const replications = (scenario.replications ?? []).filter(replication => Number.isSafeInteger(replication.did))
      .map(replication => ({ id: replication.did, ...(replication.didname ? { label: replication.didname } : {}) }));
    return { id: String(scenario.scid), label: scenario.name?.trim() || `Scenario ${scenario.scid}`, scenarioId: scenario.scid,
      ...(replications.length ? { did: replications[0].id, replications } : {}) };
  });
}

export function vehiclePlaybackScenarioRoster(scenarios: readonly { variantId?: string; manifestPath?: string; id: string; label?: string; scid?: string | number; did?: string | number }[]): TestudoScenario[] {
  return scenarios.map(scenario => ({
    id: vehiclePlaybackVariantSelectionId(scenario),
    label: scenario.label ?? scenario.id,
    ...(scenario.scid !== undefined ? { scenarioId: scenario.scid } : {}),
    ...(Number.isSafeInteger(Number(scenario.did)) ? { did: Number(scenario.did) } : {}),
    ...(scenario.variantId ? { variantId: scenario.variantId } : {}),
  }));
}

/** Stable host-visible identity for one animation variant, independent of SCID/DID and list order. */
export function vehiclePlaybackVariantSelectionId(scenario: { variantId?: string; manifestPath?: string; id: string; scid?: string | number; did?: string | number }): string {
  const variant = scenario.variantId ?? scenario.manifestPath ?? scenario.id;
  return `vehicle-variant:${encodeURIComponent(JSON.stringify([String(scenario.scid ?? ""), String(scenario.did ?? ""), variant]))}`;
}

export function vehiclePlaybackVariantIndex(scenarios: readonly { variantId?: string; manifestPath?: string; id: string; scid?: string | number; did?: string | number }[], selectionId: string): number {
  return scenarios.findIndex(scenario => vehiclePlaybackVariantSelectionId(scenario) === selectionId);
}
