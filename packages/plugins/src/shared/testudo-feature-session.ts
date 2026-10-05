/**
 * Small, renderer-neutral contracts shared by plugins that expose simulation
 * controls. Each session belongs to one Testudo view, not to the map currently
 * focused by the user.
 */
export interface TestudoPlaybackState {
  available: boolean;
  loading: boolean;
  playing: boolean;
  tick: number;
  maxTick: number;
  speed: number;
  dt: number;
  loop: boolean;
}

export interface TestudoScenario {
  id: string;
  label: string;
  replications?: Array<{ id: number; label?: string }>;
}

export interface TestudoCameraView {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export type TestudoViewMode = "animation" | "flow" | "paths" | "density";
export type TestudoCapabilityKey = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison";
export type TestudoNetworkFilter = {
  id: string;
  enabled: boolean;
  value?: string | number | boolean;
};
export type TestudoRenderer = "maplibre" | "cesium";

export interface TestudoPlaybackFeature {
  getState(): TestudoPlaybackState;
  setPlaying(playing: boolean): Promise<TestudoPlaybackState> | TestudoPlaybackState;
  restart(): Promise<TestudoPlaybackState> | TestudoPlaybackState;
  seek(tick: number): Promise<TestudoPlaybackState> | TestudoPlaybackState;
  setSpeed(speed: number): Promise<TestudoPlaybackState> | TestudoPlaybackState;
  subscribe?(listener: (state: TestudoPlaybackState) => void): () => void;
}

export interface TestudoFeatureContext {
  tviewId: string;
  packageId: string;
  versionId: string | null;
  pluginId: string | null;
  generation: number;
}

export interface TestudoFeatureCapability {
  id: TestudoCapabilityKey;
  available: boolean;
  reason?: string;
  label?: string;
  description?: string;
}

export interface TestudoGeoAIRequest {
  requestId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: TestudoFeatureContext & { scenarioId?: string };
}

export interface TestudoGeoAIReply {
  content?: string;
  error?: string;
}

/** Optional capabilities are absent when that package/plugin does not provide them. */
export interface TestudoFeatureSession {
  context: TestudoFeatureContext;
  capabilities?: TestudoFeatureCapability[];
  availableModes?: TestudoViewMode[];
  selectedMode?: TestudoViewMode;
  presetId?: string;
  scenarios?: TestudoScenario[];
  selectedScenarioId?: string;
  selectPlugin?(pluginId: string): Promise<string> | string;
  applyPreset?(presetId: string): Promise<string> | string;
  selectScenario?(scenarioId: string): Promise<string> | string;
  playback?: TestudoPlaybackFeature;
  getCameraView?(): TestudoCameraView | null;
  setCameraView?(view: TestudoCameraView): Promise<void> | void;
  setMapControl?(controlId: string, visible: boolean): Promise<boolean> | boolean;
  getMapControlState?(): { legendVisible: boolean; esriWorldImageryVisible: boolean; renderer: TestudoRenderer };
  setRenderer?(renderer: TestudoRenderer): Promise<TestudoRenderer> | TestudoRenderer;
  setKpiGeometry?(geometry: "lanes" | "sections", visible: boolean): Promise<{ showLanes: boolean; showSections: boolean }> | { showLanes: boolean; showSections: boolean };
  getKpiGeometryState?(): { showLanes: boolean; showSections: boolean };
  openAnnotations?(): Promise<boolean> | boolean;
  openRecordTour?(): Promise<void> | void;
  openRecordVideo?(): Promise<void> | void;
  setViewMode?(mode: TestudoViewMode): Promise<TestudoViewMode> | TestudoViewMode;
  setNetworkFilter?(filter: TestudoNetworkFilter): Promise<void> | void;
  requestGeoAI?(request: TestudoGeoAIRequest): Promise<void> | void;
  deliverGeoAIReply?(requestId: string, reply: TestudoGeoAIReply): Promise<void> | void;
  loadPackage?(onProgress: (progress: TestudoPackageProgress) => void): Promise<void>;
  dispose?(): Promise<void> | void;
}

export interface TestudoPackageProgress {
  value: number;
  loaded: number;
  total: number;
  label?: string;
}

/**
 * Owns one feature session per TView and fences late async results by generation.
 * A replacement session invalidates outstanding callbacks before disposing the
 * previous provider, so a slow package load cannot overwrite the new package.
 */
export class TestudoFeatureSessions {
  private readonly sessions = new Map<string, TestudoFeatureSession>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(tviewId: string): TestudoFeatureSession | undefined {
    return this.sessions.get(tviewId);
  }

  subscribe(tviewId: string, listener: () => void): () => void {
    const subscribers = this.listeners.get(tviewId) ?? new Set<() => void>();
    subscribers.add(listener);
    this.listeners.set(tviewId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) this.listeners.delete(tviewId);
    };
  }

  install(session: TestudoFeatureSession): () => void {
    const { tviewId, generation } = session.context;
    if (!tviewId || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("A Testudo feature session requires a TView id and positive generation.");
    }
    const previous = this.sessions.get(tviewId);
    if (previous && generation <= previous.context.generation) {
      throw new Error("Testudo feature session generations must increase per TView.");
    }
    this.sessions.set(tviewId, session);
    this.notify(tviewId);
    if (previous) void previous.dispose?.();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.sessions.get(tviewId) !== session) return;
      this.sessions.delete(tviewId);
      this.notify(tviewId);
      void session.dispose?.();
    };
  }

  isCurrent(context: Pick<TestudoFeatureContext, "tviewId" | "generation">): boolean {
    return this.sessions.get(context.tviewId)?.context.generation === context.generation;
  }

  remove(tviewId: string): TestudoFeatureSession | undefined {
    const session = this.sessions.get(tviewId);
    if (!session) return undefined;
    this.sessions.delete(tviewId);
    this.notify(tviewId);
    void session.dispose?.();
    return session;
  }

  private notify(tviewId: string): void {
    for (const listener of this.listeners.get(tviewId) ?? []) listener();
  }
}

export function validTestudoProgress(progress: TestudoPackageProgress): TestudoPackageProgress {
  if (!Number.isFinite(progress.loaded) || !Number.isFinite(progress.total)
    || progress.loaded < 0 || progress.total < 0 || progress.loaded > progress.total) {
    throw new Error("Package progress must contain finite, ordered byte counts.");
  }
  return {
    value: progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0,
    loaded: progress.loaded,
    total: progress.total,
    ...(progress.label ? { label: progress.label.slice(0, 120) } : {}),
  };
}
