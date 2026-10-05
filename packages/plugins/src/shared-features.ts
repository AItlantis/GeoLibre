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

export interface MapControlSnapshot {
  available: boolean;
  renderer: string;
  controls: Record<string, boolean>;
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
  subscribe?(listener: () => void): () => void;
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

export interface MapControlProvider {
  getState(): MapControlSnapshot;
  setControl?(control: string, visible: boolean): void | Promise<void>;
}

export interface MeasuredProgressProvider {
  getState(): MeasuredProgressSnapshot;
}

export interface SharedFeatureContribution {
  playback?: PlaybackProvider;
  scenario?: ScenarioProvider;
  viewMode?: ViewModeProvider;
  networkFilters?: NetworkFilterProvider;
  mapControls?: MapControlProvider;
  progress?: MeasuredProgressProvider;
}

export interface SharedFeatureSnapshot {
  playback?: PlaybackSnapshot;
  scenario?: ScenarioSnapshot;
  viewMode?: ViewModeSnapshot;
  networkFilters?: NetworkFilterSnapshot;
  mapControls?: MapControlSnapshot;
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
  setMapControl(control: string, visible: boolean): Promise<MapControlSnapshot>;
}

type FeatureKey = keyof SharedFeatureContribution;
type ProviderEntry = { owner: string; provider: NonNullable<SharedFeatureContribution[FeatureKey]>; priority: number; order: number };

export interface SharedFeatureRegistrationOptions { priority?: number }

/** Host side of SharedFeatureApi; PluginManager binds registrations to the active plugin owner. */
export class SharedFeatureRegistry implements SharedFeatureApi {
  private providers = new Map<FeatureKey, ProviderEntry[]>();
  private providerSubscriptions = new Map<ProviderEntry, () => void>();
  private listeners = new Set<(snapshot: SharedFeatureSnapshot) => void>();
  private registrationOrder = 0;

  register(owner: string, contribution: SharedFeatureContribution, options: SharedFeatureRegistrationOptions = {}): () => void {
    if (!owner) throw new Error("Shared feature providers require an owning plugin id.");
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error("Shared feature provider priority must be finite.");
    const keys = (Object.keys(contribution) as FeatureKey[]).filter(key => contribution[key] !== undefined);
    if (keys.length === 0) throw new Error("A shared feature contribution must provide at least one capability.");
    const entries: Array<{ key: FeatureKey; entry: ProviderEntry }> = [];
    for (const key of keys) {
      const provider = contribution[key];
      const entry: ProviderEntry = { owner, provider: provider as ProviderEntry["provider"], priority, order: ++this.registrationOrder };
      const stack = this.providers.get(key) ?? [];
      stack.push(entry);
      this.providers.set(key, stack);
      entries.push({ key, entry });
      const observable = provider as { subscribe?: (listener: () => void) => () => void } | undefined;
      if (observable?.subscribe) {
        this.providerSubscriptions.set(entry, observable.subscribe(() => this.notify()));
      }
    }
    this.notify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const { key, entry } of entries) {
        this.providerSubscriptions.get(entry)?.();
        this.providerSubscriptions.delete(entry);
        const remaining = (this.providers.get(key) ?? []).filter(candidate => candidate !== entry);
        if (remaining.length) this.providers.set(key, remaining);
        else this.providers.delete(key);
      }
      this.notify();
    };
  }

  removeOwner(owner: string): void {
    let changed = false;
    for (const [key, stack] of this.providers) {
      const removed = stack.filter(entry => entry.owner === owner);
      if (!removed.length) continue;
      changed = true;
      for (const entry of removed) {
        this.providerSubscriptions.get(entry)?.();
        this.providerSubscriptions.delete(entry);
      }
      const remaining = stack.filter(entry => entry.owner !== owner);
      if (remaining.length) this.providers.set(key, remaining);
      else this.providers.delete(key);
    }
    if (changed) this.notify();
  }

  getSnapshot(): SharedFeatureSnapshot {
    const playbackProvider = this.getProvider("playback") as PlaybackProvider | undefined;
    const scenarioProvider = this.getProvider("scenario") as ScenarioProvider | undefined;
    const viewModeProvider = this.getProvider("viewMode") as ViewModeProvider | undefined;
    const networkFilterProvider = this.getProvider("networkFilters") as NetworkFilterProvider | undefined;
    const mapControlProvider = this.getProvider("mapControls") as MapControlProvider | undefined;
    const progressProvider = this.getProvider("progress") as MeasuredProgressProvider | undefined;
    const playback = playbackProvider?.getState();
    const scenario = scenarioProvider?.getState();
    const viewMode = viewModeProvider?.getState();
    const networkFilters = networkFilterProvider?.getState();
    const mapControls = mapControlProvider?.getState();
    const progress = progressProvider?.getState();
    return {
      ...(playback ? { playback: structuredClone(playback) } : {}),
      ...(scenario ? { scenario: structuredClone(scenario) } : {}),
      ...(viewMode ? { viewMode: structuredClone(viewMode) } : {}),
      ...(networkFilters ? { networkFilters: structuredClone(networkFilters) } : {}),
      ...(mapControls ? { mapControls: structuredClone(mapControls) } : {}),
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

  async setMapControl(control: string, visible: boolean): Promise<MapControlSnapshot> {
    if (!/^[a-z0-9-]{1,64}$/i.test(control) || typeof visible !== "boolean") throw new Error("Map control command is invalid.");
    const provider = this.require("mapControls");
    if (!provider.setControl) throw new Error("The active map-control provider does not support visibility changes.");
    await provider.setControl(control, visible);
    this.notify();
    return this.require("mapControls").getState();
  }

  private require<K extends FeatureKey>(key: K): NonNullable<SharedFeatureContribution[K]> {
    const provider = this.getProvider(key);
    if (!provider) throw new Error(`No plugin currently provides the shared '${key}' capability.`);
    return provider as NonNullable<SharedFeatureContribution[K]>;
  }
  private getProvider<K extends FeatureKey>(key: K): SharedFeatureContribution[K] {
    const stack = this.providers.get(key) ?? [];
    const ordered = [...stack].sort((a, b) => b.priority - a.priority || b.order - a.order);
    const available = ordered.find(entry => {
      const state = (entry.provider as { getState?: () => { available?: unknown } }).getState?.();
      return state?.available === true;
    });
    return (available ?? ordered[0])?.provider as SharedFeatureContribution[K];
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
