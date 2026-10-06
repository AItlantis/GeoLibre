import type {
  TestudoFeatureContext,
  TestudoFeatureSession,
  TestudoPackageProgress,
  TestudoPlaybackState,
  TestudoScenario,
} from "../shared/testudo-feature-session";
import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "../testudo-feature-bridge";
import { registerTestudoPackageProvider } from "../testudo-provider-registry";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseScenarios(raw: JsonObject): TestudoScenario[] {
  const source = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  return source.flatMap((value, index) => {
    const item = record(value);
    const rawId = item.scid ?? item.id;
    if (typeof rawId !== "string" && typeof rawId !== "number") return [];
    const replications = Array.isArray(item.replications) ? item.replications : [];
    return [{
      id: String(rawId),
      label: typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : `Scenario ${index + 1}`,
      replications: replications.flatMap((replication) => {
        const row = record(replication);
        const id = Number(row.did ?? row.id);
        return Number.isSafeInteger(id) ? [{ id, ...(typeof row.didname === "string" ? { label: row.didname } : {}) }] : [];
      }),
    }];
  });
}

function playbackLimits(raw: JsonObject): { maxTick: number; dt: number } {
  const maxFromCount = finite(raw.n_ticks ?? raw.tick_count, 1) - 1;
  return {
    maxTick: Math.max(0, Math.trunc(finite(raw.maxTick ?? raw.max_tick, maxFromCount))),
    dt: Math.max(0.001, finite(raw.dt ?? raw.step_seconds, 1)),
  };
}

function initialPlaybackState(maxTick: number, dt: number): TestudoPlaybackState {
  return { available: true, loading: false, playing: false, tick: 0, maxTick, speed: 1, dt, loop: false };
}

/**
 * The bridge adapter for a published vehicle playback package. The package
 * manifest is fetched through the host artifact proxy; the iframe receives
 * only its bytes and never needs an artifact credential.
 */
export const testudoVehiclePlaybackProvider: TestudoFeatureProviderFactory = {
  async open(
    bootstrap: TestudoPackageBootstrap,
    context: TestudoFeatureContext,
    onProgress: (progress: TestudoPackageProgress) => void,
    fetchArtifact: (artifactRef: string) => Promise<ArrayBuffer>,
  ): Promise<TestudoFeatureSession> {
    const bytes = await fetchArtifact("manifest.json");
    onProgress({ value: 0, loaded: 0, total: bytes.byteLength, label: "Reading playback manifest" });
    let manifest: JsonObject;
    try {
      manifest = record(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new Error("The vehicle playback manifest is not valid JSON.");
    }
    const scenarios = parseScenarios(manifest);
    const { maxTick, dt } = playbackLimits(manifest);
    let state = initialPlaybackState(maxTick, dt);
    let selectedScenarioId = scenarios[0]?.id;
    let interval: ReturnType<typeof setInterval> | undefined;
    const listeners = new Set<(tviewId: string, generation: number, playback: TestudoPlaybackState) => void>();
    const assertScope = (tviewId: string, generation: number) => {
      if (tviewId !== context.tviewId || generation !== context.generation) {
        throw new Error("Playback command belongs to a stale Testudo package.");
      }
    };
    const publish = () => {
      const snapshot = { ...state };
      for (const listener of listeners) listener(context.tviewId, context.generation, snapshot);
      return snapshot;
    };
    const stopTimer = () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    };
    const setPlaying = (tviewId: string, generation: number, playing: boolean) => {
      assertScope(tviewId, generation);
      stopTimer();
      state = { ...state, playing: playing && state.tick < state.maxTick };
      if (state.playing) {
        const period = Math.max(16, Math.round(1000 * state.dt / state.speed));
        interval = setInterval(() => {
          if (state.tick >= state.maxTick) {
            state = { ...state, tick: state.maxTick, playing: false };
            stopTimer();
          } else state = { ...state, tick: Math.min(state.maxTick, state.tick + 1) };
          publish();
        }, period);
      }
      return publish();
    };
    onProgress({ value: 100, loaded: bytes.byteLength, total: bytes.byteLength, label: bootstrap.label || "Playback ready" });
    return {
      context,
      capabilities: bootstrap.capabilities,
      scenarios,
      ...(selectedScenarioId ? { selectedScenarioId } : {}),
      selectScenario(id) {
        if (!scenarios.some((scenario) => scenario.id === id)) throw new Error(`Scenario ${id} is not declared in this package.`);
        selectedScenarioId = id;
        return id;
      },
      playback: {
        getPlaybackState(tviewId, generation) {
          assertScope(tviewId, generation);
          return { ...state };
        },
        play: (tviewId, generation) => setPlaying(tviewId, generation, true),
        pause: (tviewId, generation) => setPlaying(tviewId, generation, false),
        restart(tviewId, generation) {
          assertScope(tviewId, generation);
          stopTimer();
          state = { ...state, playing: false, tick: 0 };
          return publish();
        },
        seek(tviewId, generation, tick) {
          assertScope(tviewId, generation);
          stopTimer();
          state = { ...state, playing: false, tick: Math.min(maxTick, tick) };
          return publish();
        },
        setSpeed(tviewId, generation, speed) {
          assertScope(tviewId, generation);
          const playing = state.playing;
          stopTimer();
          state = { ...state, playing: false, speed };
          if (playing) return setPlaying(tviewId, generation, true);
          return publish();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose() {
        stopTimer();
        listeners.clear();
      },
    };
  },
};

/** Register the built-in provider once when the desktop plugin foundation starts. */
let unregisterProvider: (() => void) | undefined;
export function registerTestudoVehiclePlaybackProvider(): () => void {
  if (!unregisterProvider) {
    unregisterProvider = registerTestudoPackageProvider({
      capability: "vehicle-playback",
      factory: testudoVehiclePlaybackProvider,
    }, "geolibre-vehicle-playback");
  }
  return () => {
    unregisterProvider?.();
    unregisterProvider = undefined;
  };
}
