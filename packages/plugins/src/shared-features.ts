/** Typed shared controls that plugin adapters can expose without copying their live state. */
export type ScenarioId = string | number;

export interface PlaybackSnapshot {
  available: boolean;
  playing: boolean;
  tick: number;
  maxTick: number;
  speed: number;
  dt: number;
  loop: boolean;
}

export interface ScenarioSnapshot {
  available: boolean;
  scenarios: Array<{ id: ScenarioId; label: string; replications?: Array<{ id: string | number; label?: string }> }>;
  selectedScenario?: ScenarioId;
  selectedReplication?: string | number;
}

export interface ViewModeSnapshot {
  available: boolean;
  modes: string[];
  selectedMode?: string;
}

export interface NetworkFilterSnapshot {
  available: boolean;
  filters: Record<string, string | number | boolean | null>;
}

export interface MeasuredProgressSnapshot {
  available: boolean;
  stage?: string;
  loadedBytes?: number;
  totalBytes?: number;
  loaded?: number;
  total?: number;
  value?: number;
}

export interface PlaybackProvider {
  getState(): PlaybackSnapshot;
  setPlaying?(playing: boolean): void | Promise<void>;
  restart?(): void | Promise<void>;
  seek?(tick: number): void | Promise<void>;
  setSpeed?(speed: number): void | Promise<void>;
}

export interface ScenarioProvider {
  getState(): ScenarioSnapshot;
  select?(scenarioId: ScenarioId, replicationId?: string | number): void | Promise<void>;
}

export interface ViewModeProvider {
  getState(): ViewModeSnapshot;
  setMode?(mode: string): void | Promise<void>;
}

export interface NetworkFilterProvider {
  getState(): NetworkFilterSnapshot;
  setFilters?(filters: Record<string, string | number | boolean | null>): void | Promise<void>;
}

export interface MeasuredProgressProvider {
  getState(): MeasuredProgressSnapshot;
}

export interface SharedFeatureContribution {
  playback?: PlaybackProvider;
  scenario?: ScenarioProvider;
  viewMode?: ViewModeProvider;
  networkFilters?: NetworkFilterProvider;
  progress?: MeasuredProgressProvider;
}

export interface SharedFeatureSnapshot {
  playback?: PlaybackSnapshot;
  scenario?: ScenarioSnapshot;
  viewMode?: ViewModeSnapshot;
  networkFilters?: NetworkFilterSnapshot;
  progress?: MeasuredProgressSnapshot;
}

/** Consumer API exposed on the plugin host. State always comes from its active provider. */
export interface SharedFeatureApi {
  getSnapshot(): SharedFeatureSnapshot;
  subscribe(listener: (snapshot: SharedFeatureSnapshot) => void): () => void;
  /** Providers call this when their live source changes outside a shared command. */
  notifyChanged(): void;
  setPlaybackPlaying(playing: boolean): Promise<PlaybackSnapshot>;
  restartPlayback(): Promise<PlaybackSnapshot>;
  seekPlayback(tick: number): Promise<PlaybackSnapshot>;
  setPlaybackSpeed(speed: number): Promise<PlaybackSnapshot>;
  selectScenario(scenarioId: ScenarioId, replicationId?: string | number): Promise<ScenarioSnapshot>;
  setViewMode(mode: string): Promise<ViewModeSnapshot>;
  setNetworkFilters(filters: Record<string, string | number | boolean | null>): Promise<NetworkFilterSnapshot>;
}

type FeatureKey = keyof SharedFeatureContribution;

/** Host side of SharedFeatureApi; PluginManager binds registrations to the active plugin owner. */
export class SharedFeatureRegistry implements SharedFeatureApi {
  private providers = new Map<FeatureKey, { owner: string; provider: SharedFeatureContribution[FeatureKey] }>();
  private listeners = new Set<(snapshot: SharedFeatureSnapshot) => void>();

  register(owner: string, contribution: SharedFeatureContribution): () => void {
    if (!owner) throw new Error("Shared feature providers require an owning plugin id.");
    const keys = (Object.keys(contribution) as FeatureKey[]).filter(key => contribution[key] !== undefined);
    if (keys.length === 0) throw new Error("A shared feature contribution must provide at least one capability.");
    const conflict = keys.find(key => this.providers.has(key));
    if (conflict) throw new Error(`Shared feature '${conflict}' is already provided by '${this.providers.get(conflict)!.owner}'.`);
    for (const key of keys) this.providers.set(key, { owner, provider: contribution[key] });
    this.notify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const key of keys) if (this.providers.get(key)?.owner === owner) this.providers.delete(key);
      this.notify();
    };
  }

  removeOwner(owner: string): void {
    let changed = false;
    for (const [key, entry] of this.providers) {
      if (entry.owner === owner) { this.providers.delete(key); changed = true; }
    }
    if (changed) this.notify();
  }

  getSnapshot(): SharedFeatureSnapshot {
    const playbackProvider = this.providers.get("playback")?.provider as PlaybackProvider | undefined;
    const scenarioProvider = this.providers.get("scenario")?.provider as ScenarioProvider | undefined;
    const viewModeProvider = this.providers.get("viewMode")?.provider as ViewModeProvider | undefined;
    const networkFilterProvider = this.providers.get("networkFilters")?.provider as NetworkFilterProvider | undefined;
    const progressProvider = this.providers.get("progress")?.provider as MeasuredProgressProvider | undefined;
    const playback = playbackProvider?.getState();
    const scenario = scenarioProvider?.getState();
    const viewMode = viewModeProvider?.getState();
    const networkFilters = networkFilterProvider?.getState();
    const progress = progressProvider?.getState();
    return {
      ...(playback ? { playback: structuredClone(playback) } : {}),
      ...(scenario ? { scenario: structuredClone(scenario) } : {}),
      ...(viewMode ? { viewMode: structuredClone(viewMode) } : {}),
      ...(networkFilters ? { networkFilters: structuredClone(networkFilters) } : {}),
      ...(progress ? { progress: compactProgress(progress) } : {}),
    };
  }

  subscribe(listener: (snapshot: SharedFeatureSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChanged(): void { this.notify(); }

  async setPlaybackPlaying(playing: boolean): Promise<PlaybackSnapshot> {
    const provider = this.require("playback");
    if (!provider.setPlaying) throw new Error("The active playback provider does not support play/pause commands.");
    await provider.setPlaying(playing);
    this.notify();
    return this.require("playback").getState();
  }
  async restartPlayback(): Promise<PlaybackSnapshot> {
    const provider = this.require("playback");
    if (!provider.restart) throw new Error("The active playback provider does not support restart.");
    await provider.restart();
    this.notify();
    return this.require("playback").getState();
  }
  async seekPlayback(tick: number): Promise<PlaybackSnapshot> {
    if (!Number.isFinite(tick) || tick < 0) throw new RangeError("Playback tick must be a finite non-negative number.");
    const provider = this.require("playback");
    if (!provider.seek) throw new Error("The active playback provider does not support seeking.");
    await provider.seek(tick);
    this.notify();
    return this.require("playback").getState();
  }
  async setPlaybackSpeed(speed: number): Promise<PlaybackSnapshot> {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 20) throw new RangeError("Playback speed must be between 0.25 and 20.");
    const provider = this.require("playback");
    if (!provider.setSpeed) throw new Error("The active playback provider does not support speed control.");
    await provider.setSpeed(speed);
    this.notify();
    return this.require("playback").getState();
  }
  async selectScenario(scenarioId: ScenarioId, replicationId?: string | number): Promise<ScenarioSnapshot> {
    const provider = this.require("scenario");
    if (!provider.select) throw new Error("The active scenario provider does not support selection.");
    await provider.select(scenarioId, replicationId);
    this.notify();
    return this.require("scenario").getState();
  }
  async setViewMode(mode: string): Promise<ViewModeSnapshot> {
    const provider = this.require("viewMode");
    if (!provider.setMode) throw new Error("The active view-mode provider does not support changing modes.");
    await provider.setMode(mode);
    this.notify();
    return this.require("viewMode").getState();
  }
  async setNetworkFilters(filters: Record<string, string | number | boolean | null>): Promise<NetworkFilterSnapshot> {
    const provider = this.require("networkFilters");
    if (!provider.setFilters) throw new Error("The active network-filter provider does not support changing filters.");
    await provider.setFilters(structuredClone(filters));
    this.notify();
    return this.require("networkFilters").getState();
  }

  private require<K extends FeatureKey>(key: K): NonNullable<SharedFeatureContribution[K]> {
    const provider = this.providers.get(key)?.provider;
    if (!provider) throw new Error(`No plugin currently provides the shared '${key}' capability.`);
    return provider as NonNullable<SharedFeatureContribution[K]>;
  }
  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function compactProgress(value: MeasuredProgressSnapshot): MeasuredProgressSnapshot {
  const result: MeasuredProgressSnapshot = { available: value.available === true };
  if (typeof value.stage === "string") result.stage = value.stage.slice(0, 120);
  for (const key of ["loadedBytes", "totalBytes", "loaded", "total", "value"] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) result[key] = number;
  }
  return result;
}

/** One host registry shared by all bundled and external plugin adapters. */
export const sharedFeatureRegistry = new SharedFeatureRegistry();
