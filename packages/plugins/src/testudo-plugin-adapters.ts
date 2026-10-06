import type { TestudoPlaybackFeature, TestudoPlaybackState } from "./shared/testudo-feature-session";

export interface TestudoVehiclePlaybackApi {
  getStatus(): { loading: boolean; maxTick: number; dt: number; error: string | null };
  getSettings(): { tick: number; playing: boolean; speed: number; loop: boolean };
  setTick(tick: number): void;
  setSettings(settings: { playing?: boolean; speed?: number }): boolean;
  setScenario?(index: number): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface TestudoIntervalPlaybackApi {
  getStatus(): { loading: boolean; intervals: number[]; error: string | null; dt?: number | null };
  getSettings(): { interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean };
  setSettings(settings: { interval?: number; intervalPlaying?: boolean; playbackSpeed?: number }): boolean | void;
  stepNetworkKpiInterval(direction: 1 | -1): void;
  setScenario?(index: number): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface TestudoScenarioComparisonApi {
  getStatus(): { loading: boolean; intervals: number[]; error: string | null; matchedIntervals: unknown[]; dt?: number | null };
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

function toShellState(loading: boolean, available: boolean, playing: boolean, tick: number, maxTick: number, speed: number, dt: number, loop: boolean): TestudoPlaybackState {
  return { available, loading, playing, tick: Number.isFinite(tick) ? Math.max(0, tick) : 0,
    maxTick: Number.isFinite(maxTick) ? Math.max(0, maxTick) : 0, speed: Number.isFinite(speed) ? speed : 1,
    dt: Number.isFinite(dt) && dt >= 0 ? dt : 0, loop };
}

/** Adapt the original vehicle-playback clock to the Testudo shell clock. */
export function createVehiclePlaybackAdapter(api: TestudoVehiclePlaybackApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const getPlaybackState = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const status = api.getStatus(); const settings = api.getSettings();
    return toShellState(status.loading, status.maxTick > 0, settings.playing, settings.tick, status.maxTick, settings.speed, status.dt, settings.loop);
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
    subscribe: listener => api.subscribe?.(() => listener(scope.tviewId, scope.generation, getPlaybackState(scope.tviewId, scope.generation))) ?? (() => {}),
  };
}

/** Adapt interval-based KPI settings to an ordinal shell tick. */
export function createNetworkKpiPlaybackAdapter(api: TestudoIntervalPlaybackApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const state = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const status = api.getStatus(); const settings = api.getSettings();
    const intervals = status.intervals.filter(value => Number.isFinite(value) && value !== 0);
    const tick = Math.max(0, intervals.indexOf(settings.interval));
    return toShellState(status.loading, intervals.length > 0 && !status.error, settings.intervalPlaying, tick, Math.max(0, intervals.length - 1), settings.playbackSpeed, status.dt ?? 1, settings.loop);
  };
  const set = (tviewId: string, generation: number, value: { intervalPlaying?: boolean; playbackSpeed?: number; interval?: number }) => {
    assertGeneration(isCurrent, tviewId, generation); api.setSettings(value); return state(tviewId, generation);
  };
  const seek = (tviewId: string, generation: number, tick: number) => {
    assertGeneration(isCurrent, tviewId, generation);
    const intervals = api.getStatus().intervals.filter(value => Number.isFinite(value) && value !== 0);
    const index = Math.max(0, Math.min(intervals.length - 1, Math.trunc(tick)));
    if (intervals.length) {
      const current = intervals.indexOf(api.getSettings().interval);
      const direction = index >= current ? 1 : -1;
      for (let step = current; step !== index; step += direction) api.stepNetworkKpiInterval(direction);
    }
    return state(tviewId, generation);
  };
  return {
    getPlaybackState: state,
    play: (id, generation) => set(id, generation, { intervalPlaying: true }),
    pause: (id, generation) => set(id, generation, { intervalPlaying: false }),
    restart: (id, generation) => { assertGeneration(isCurrent, id, generation); api.setSettings({ intervalPlaying: false }); return seek(id, generation, 0); },
    seek,
    setSpeed: (id, generation, playbackSpeed) => set(id, generation, { playbackSpeed }),
    subscribe: listener => api.subscribe?.(() => listener(scope.tviewId, scope.generation, state(scope.tviewId, scope.generation))) ?? (() => {}),
  };
}

/** Scenario comparison owns a pair of scenario indexes and the shared interval clock. */
export function createScenarioComparisonPlaybackAdapter(api: TestudoScenarioComparisonApi, isCurrent: TestudoGenerationGuard, scope: TestudoPlaybackScope = { tviewId: "main", generation: 1 }): TestudoPlaybackFeature {
  const state = (tviewId: string, generation: number) => {
    assertGeneration(isCurrent, tviewId, generation); const status = api.getStatus(); const settings = api.getSettings();
    const intervals = status.intervals.filter(value => Number.isFinite(value) && value !== 0); const tick = Math.max(0, intervals.indexOf(settings.interval));
    return toShellState(status.loading, status.matchedIntervals.length > 0 && !status.error, settings.intervalPlaying, tick, Math.max(0, intervals.length - 1), settings.playbackSpeed, status.dt ?? 1, settings.loop);
  };
  const patch = (id: string, generation: number, change: { intervalPlaying?: boolean; playbackSpeed?: number; interval?: number }) => {
    assertGeneration(isCurrent, id, generation); api.setSettings(change); return state(id, generation);
  };
  const seek = (id: string, generation: number, tick: number) => {
    assertGeneration(isCurrent, id, generation); const intervals = api.getStatus().intervals.filter(value => Number.isFinite(value) && value !== 0);
    const index = Math.max(0, Math.min(intervals.length - 1, Math.trunc(tick)));
    if (intervals.length) { const current = intervals.indexOf(api.getSettings().interval); const direction = index >= current ? 1 : -1; for (let step = current; step !== index; step += direction) api.stepScenarioComparisonInterval(direction); }
    return state(id, generation);
  };
  return { getPlaybackState: state, play: (id, gen) => patch(id, gen, { intervalPlaying: true }), pause: (id, gen) => patch(id, gen, { intervalPlaying: false }),
    restart: (id, gen) => { assertGeneration(isCurrent, id, gen); api.setSettings({ intervalPlaying: false }); return seek(id, gen, 0); }, seek,
    setSpeed: (id, gen, playbackSpeed) => patch(id, gen, { playbackSpeed }),
    subscribe: listener => api.subscribe?.(() => listener(scope.tviewId, scope.generation, state(scope.tviewId, scope.generation))) ?? (() => {}) };
}

/** Apply one selected scenario or an explicit comparison pair using plugin-owned settings. */
export function createScenarioSelectionAdapters(apis: {
  setNetworkKpiScenario(index: number): Promise<void>;
  setVehiclePlaybackScenario(index: number): Promise<void>;
  setScenarioComparisonSettings(settings: { scenarioA: number; scenarioB: number }): void;
}) {
  return {
    networkKpi: (index: number) => apis.setNetworkKpiScenario(index),
    vehiclePlayback: (index: number) => apis.setVehiclePlaybackScenario(index),
    comparison: (scenarioA: number, scenarioB: number) => apis.setScenarioComparisonSettings({ scenarioA, scenarioB }),
  };
}
