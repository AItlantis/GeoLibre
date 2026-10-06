import {
  TestudoFeatureSessions,
  validTestudoProgress,
  type TestudoCameraView,
  type TestudoCapabilityKey,
  type TestudoFeatureContext,
  type TestudoFeatureSession,
  type TestudoGeoAIReply,
  type TestudoGeoAIRequest,
  type TestudoNetworkFilter,
  type TestudoPackageProgress,
  type TestudoPlaybackState,
  type TestudoMapHandle,
  type TestudoViewMode,
} from "./shared/testudo-feature-session";
import { validateTestudoCameraView } from "./plugins/testudo-camera";

export interface TestudoPackageBootstrap {
  packageId: string;
  versionId: string;
  label: string;
  artifactEndpoint: string;
  /** Set only by the in-iframe local folder loader. */
  origin?: "published" | "local";
  capabilities?: Array<{ id: TestudoCapabilityKey; available: boolean; reason?: string; label?: string; description?: string }>;
  presets?: Array<{ id: string; plugin?: string; settings?: Record<string, unknown> }>;
  selectedPlugin?: string;
}

export interface TestudoFeatureProviderFactory {
  open(
    bootstrap: TestudoPackageBootstrap,
    context: TestudoFeatureContext,
    onProgress: (progress: TestudoPackageProgress) => void,
    fetchArtifact: (artifactRef: string) => Promise<ArrayBuffer>,
    map?: TestudoMapHandle | null,
  ): Promise<TestudoFeatureSession>;
}

export interface TestudoArtifactRequest {
  requestId: string;
  tviewId: string;
  generation: number;
  artifactRef: string;
}

export type TestudoArtifactFetcher = (
  request: TestudoArtifactRequest,
  signal: AbortSignal,
) => Promise<ArrayBuffer>;

function isSafeArtifactReference(value: string): boolean {
  if (!value.trim() || value.length > 2048 || /[?#\\\u0000-\u001f]/.test(value)
    || value.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  try {
    return !decodeURIComponent(value).split("/").some((part) => part === "..");
  } catch {
    return false;
  }
}

export type TestudoFeatureProviderResolver = (
  bootstrap: TestudoPackageBootstrap,
) => TestudoFeatureProviderFactory | null;

export interface TestudoInvestigationAccepted {
  requestId: string;
  tviewId: string;
  generation: number;
  accepted: true;
}

export interface TestudoTViewInfo {
  tviewId: string;
  generation: number;
  loaded: boolean;
}

export interface TestudoFeatureViewerState {
  tviewId: string;
  generation: number;
  package: { packageId: string; versionId: string | null; label: string; origin: "published" | "local" } | null;
  selectedPlugin: string | null;
  capabilities: NonNullable<TestudoFeatureSession["capabilities"]>;
  availableModes: NonNullable<TestudoFeatureSession["availableModes"]>;
  selectedMode?: TestudoFeatureSession["selectedMode"];
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
  progress?: TestudoPackageProgress;
}

interface PendingInvestigation {
  request: TestudoGeoAIRequest;
  session: TestudoFeatureSession;
}

/**
 * The command handler behind the Testudo plugin. It keeps all simulation state
 * and async work attached to a TView provider. Host code supplies only package
 * loading and iframe message transport.
 */
export class TestudoFeatureBridge {
  readonly sessions = new TestudoFeatureSessions();
  private readonly factory: TestudoFeatureProviderFactory | TestudoFeatureProviderResolver;
  private readonly artifactFetcher: TestudoArtifactFetcher;
  private readonly generations = new Map<string, number>();
  private readonly pendingLoads = new Map<string, number>();
  private readonly pendingGeoAI = new Map<string, PendingInvestigation>();
  private sequence = 0;
  private activeTViewId: string | null = null;
  private readonly activeTViewListeners = new Set<(tviewId: string | null) => void>();
  private readonly geoAIListeners = new Set<(request: TestudoGeoAIRequest) => void>();
  private readonly geoAIReplyListeners = new Set<(reply: TestudoGeoAIReply & { requestId: string; tviewId: string; generation: number }) => void>();
  private readonly playbackListeners = new Set<(tviewId: string, state: TestudoPlaybackState) => void>();
  private readonly playbackSubscriptions = new Map<string, () => void>();
  private readonly tviews = new Map<string, number>();
  private readonly bootstraps = new Map<string, TestudoPackageBootstrap>();
  private readonly states = new Map<string, TestudoFeatureViewerState>();
  private readonly pendingArtifacts = new Map<string, { request: TestudoArtifactRequest; controller: AbortController }>();
  private readonly localArtifactReaders = new Map<string, (artifactRef: string) => Promise<ArrayBuffer>>();
  private mapResolver: (() => TestudoMapHandle | null) | null = null;

  constructor(
    factory: TestudoFeatureProviderFactory | TestudoFeatureProviderResolver,
    artifactFetcher: TestudoArtifactFetcher = async () => {
      throw new Error("Host-proxied artifact fetching is unavailable.");
    },
  ) {
    this.factory = factory;
    this.artifactFetcher = artifactFetcher;
  }

  /** Supply the iframe shell's current MapLibre map without giving providers
   * access to host credentials or a second artifact path. */
  setMapResolver(resolver: () => TestudoMapHandle | null): void {
    this.mapResolver = resolver;
  }

  private cancelArtifactRequests(tviewId: string, keepGeneration?: number): void {
    for (const [requestId, pending] of this.pendingArtifacts) {
      if (pending.request.tviewId === tviewId && pending.request.generation !== keepGeneration) {
        this.pendingArtifacts.delete(requestId);
        pending.controller.abort();
      }
    }
  }

  private fetchArtifactFor(context: TestudoFeatureContext, artifactRef: string): Promise<ArrayBuffer> {
    if (typeof artifactRef !== "string" || !isSafeArtifactReference(artifactRef)) {
      return Promise.reject(new Error("Artifact reference must be a relative package path."));
    }
    if (this.generations.get(context.tviewId) !== context.generation) {
      return Promise.reject(new Error("Artifact request belongs to a stale Testudo package."));
    }
    const request: TestudoArtifactRequest = {
      requestId: `testudo-artifact-${Date.now()}-${++this.sequence}`,
      tviewId: context.tviewId,
      generation: context.generation,
      artifactRef,
    };
    const controller = new AbortController();
    this.pendingArtifacts.set(request.requestId, { request, controller });
    const localReader = this.localArtifactReaders.get(context.tviewId);
    return (localReader
      ? localReader(artifactRef)
      : this.artifactFetcher(request, controller.signal)).then((bytes) => {
      if (this.pendingArtifacts.get(request.requestId)?.request !== request
        || this.generations.get(context.tviewId) !== context.generation
        || controller.signal.aborted) {
        throw new Error("Artifact response belongs to a stale Testudo package.");
      }
      return bytes;
    }).finally(() => {
      this.pendingArtifacts.delete(request.requestId);
    });
  }

  createTView(tviewId: string): TestudoTViewInfo {
    if (!tviewId.trim() || tviewId.length > 120) throw new Error("TView id must contain 1 to 120 characters.");
    if (this.tviews.has(tviewId)) throw new Error(`TView ${tviewId} already exists.`);
    this.tviews.set(tviewId, 0);
    this.states.set(tviewId, {
      tviewId, generation: 0, package: null, selectedPlugin: null, capabilities: [],
      availableModes: [], status: "empty",
    });
    return { tviewId, generation: 0, loaded: false };
  }

  getTViews(): TestudoTViewInfo[] {
    return [...this.tviews.entries()].map(([tviewId, generation]) => ({
      tviewId,
      generation,
      loaded: this.sessions.get(tviewId)?.context.generation === generation && generation > 0,
    }));
  }

  getState(tviewId: string): TestudoFeatureViewerState {
    const state = this.states.get(tviewId);
    if (!state) throw new Error(`TView ${tviewId} has not been created.`);
    return { ...state, capabilities: [...state.capabilities], availableModes: [...state.availableModes] };
  }

  setActiveTView(tviewId: string): { tviewId: string } {
    if (!tviewId.trim()) throw new Error("A TView id is required.");
    if (!this.tviews.has(tviewId)) throw new Error(`TView ${tviewId} has not been created.`);
    this.activeTViewId = tviewId;
    for (const listener of this.activeTViewListeners) listener(tviewId);
    return { tviewId };
  }

  getActiveTView(): { tviewId: string | null } {
    return { tviewId: this.activeTViewId };
  }

  subscribeActiveTView(listener: (tviewId: string | null) => void): () => void {
    this.activeTViewListeners.add(listener);
    return () => this.activeTViewListeners.delete(listener);
  }

  subscribeGeoAIRequests(listener: (request: TestudoGeoAIRequest) => void): () => void {
    this.geoAIListeners.add(listener);
    return () => this.geoAIListeners.delete(listener);
  }

  subscribeGeoAIReplies(listener: (reply: TestudoGeoAIReply & { requestId: string; tviewId: string; generation: number }) => void): () => void {
    this.geoAIReplyListeners.add(listener);
    return () => this.geoAIReplyListeners.delete(listener);
  }

  subscribePlayback(listener: (tviewId: string, state: TestudoPlaybackState) => void): () => void {
    this.playbackListeners.add(listener);
    return () => this.playbackListeners.delete(listener);
  }

  async loadPackage(
    tviewId: string,
    bootstrap: TestudoPackageBootstrap,
    onProgress: (progress: TestudoPackageProgress) => void = () => {},
    localArtifactReader?: (artifactRef: string) => Promise<ArrayBuffer>,
  ): Promise<TestudoFeatureContext> {
    if (!tviewId.trim()) throw new Error("A TView id is required.");
    if (!this.tviews.has(tviewId)) throw new Error(`TView ${tviewId} has not been created.`);
    if (!bootstrap?.packageId || !bootstrap.versionId
      || (bootstrap.origin !== "local" && !bootstrap.artifactEndpoint)
      || (bootstrap.origin === "local" && !localArtifactReader)) {
      throw new Error("The published package bootstrap is incomplete.");
    }
    const previousSession = this.sessions.remove(tviewId);
    this.cancelArtifactRequests(tviewId);
    if (previousSession) {
      for (const [requestId, pending] of this.pendingGeoAI) {
        if (pending.session === previousSession) this.pendingGeoAI.delete(requestId);
      }
    }
    const generation = (this.generations.get(tviewId) ?? 0) + 1;
    this.generations.set(tviewId, generation);
    this.tviews.set(tviewId, generation);
    this.pendingLoads.set(tviewId, generation);
    this.bootstraps.set(tviewId, bootstrap);
    if (bootstrap.origin === "local") this.localArtifactReaders.set(tviewId, localArtifactReader!);
    else this.localArtifactReaders.delete(tviewId);
    const oldState = this.states.get(tviewId)!;
    this.states.set(tviewId, {
      ...oldState, generation, package: {
        packageId: bootstrap.packageId, versionId: bootstrap.origin === "local" ? null : bootstrap.versionId,
        label: bootstrap.label ?? bootstrap.packageId, origin: bootstrap.origin ?? "published",
      }, selectedPlugin: bootstrap.selectedPlugin ?? null,
      capabilities: [...(bootstrap.capabilities ?? [])],
      availableModes: [], status: "loading", error: undefined, progress: undefined,
    });
    const context: TestudoFeatureContext = {
      tviewId,
      packageId: bootstrap.packageId,
      versionId: bootstrap.origin === "local" ? null : bootstrap.versionId,
      pluginId: bootstrap.selectedPlugin ?? null,
      generation,
    };
    let provider: TestudoFeatureSession;
    const reportProgress = (raw: TestudoPackageProgress) => {
      if (this.pendingLoads.get(tviewId) !== generation) return;
      const measured = validTestudoProgress(raw);
      const progress = { ...measured, label: measured.label ?? bootstrap.label ?? "Loading package" };
      const currentState = this.states.get(tviewId);
      if (currentState?.generation === generation) this.states.set(tviewId, { ...currentState, progress });
      onProgress(progress);
    };
    try {
      const factory = typeof this.factory === "function" ? this.factory(bootstrap) : this.factory;
      if (!factory) throw new Error("No active GeoLibre plugin provides a declared Testudo capability.");
      provider = await factory.open(
        bootstrap,
        context,
        reportProgress,
        (artifactRef) => this.fetchArtifactFor(context, artifactRef),
        this.mapResolver?.() ?? null,
      );
    } catch (error) {
      if (this.pendingLoads.get(tviewId) === generation) this.pendingLoads.delete(tviewId);
      if (this.generations.get(tviewId) === generation && bootstrap.origin === "local") this.localArtifactReaders.delete(tviewId);
      const currentState = this.states.get(tviewId);
      if (currentState?.generation === generation) this.states.set(tviewId, {
        ...currentState, status: "error", error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (provider.context.tviewId !== tviewId || provider.context.generation !== generation
      || provider.context.packageId !== bootstrap.packageId
      || provider.context.versionId !== (bootstrap.origin === "local" ? null : bootstrap.versionId)) {
      if (this.pendingLoads.get(tviewId) === generation) this.pendingLoads.delete(tviewId);
      await provider.dispose?.();
      throw new Error("The Testudo provider returned a session outside its requested scope.");
    }
    if (this.pendingLoads.get(tviewId) !== generation) {
      await provider.dispose?.();
      throw new Error("The Testudo package load was superseded by a newer request.");
    }
    try {
      const session = provider.loadPackage ? await this.loadSession(provider, reportProgress) : provider;
      if (this.pendingLoads.get(tviewId) !== generation || this.generations.get(tviewId) !== generation) {
        throw new Error("The Testudo package load was superseded by a newer request.");
      }
      this.pendingLoads.delete(tviewId);
      this.sessions.install(session);
      this.playbackSubscriptions.get(tviewId)?.();
      if (session.playback?.subscribe) {
        const unsubscribe = session.playback.subscribe((eventTViewId, generation, state) => {
          if (eventTViewId !== tviewId || generation !== session.context.generation) return;
          if (this.sessions.get(tviewId) !== session) return;
          for (const listener of this.playbackListeners) listener(tviewId, state);
        });
        this.playbackSubscriptions.set(tviewId, unsubscribe);
      }
      this.states.set(tviewId, {
        tviewId, generation, package: {
          packageId: bootstrap.packageId,
          versionId: bootstrap.origin === "local" ? null : bootstrap.versionId,
          label: bootstrap.label ?? bootstrap.packageId,
          origin: bootstrap.origin ?? "published",
        },
        selectedPlugin: session.context.pluginId,
        capabilities: [...(session.capabilities ?? bootstrap.capabilities ?? [])],
        availableModes: [...(session.availableModes ?? [])],
        ...(session.selectedMode ? { selectedMode: session.selectedMode } : {}),
        ...(session.presetId ? { presetId: session.presetId } : {}),
        status: "ready",
      });
      return session.context;
    } catch (error) {
      const superseded = this.pendingLoads.get(tviewId) !== generation
        || this.generations.get(tviewId) !== generation;
      if (this.pendingLoads.get(tviewId) === generation) this.pendingLoads.delete(tviewId);
      if (!superseded && bootstrap.origin === "local") this.localArtifactReaders.delete(tviewId);
      const currentState = this.states.get(tviewId);
      if (currentState?.generation === generation) this.states.set(tviewId, {
        ...currentState, status: "error", error: error instanceof Error ? error.message : String(error),
      });
      await provider.dispose?.();
      if (superseded) throw new Error("The Testudo package load was superseded by a newer request.");
      throw error;
    }
  }

  async selectPlugin(tviewId: string, pluginId: string): Promise<string> {
    if (!pluginId || pluginId.length > 80) throw new Error("Plugin id is invalid.");
    const session = this.requireSession(tviewId);
    if (session.context.pluginId === pluginId) return pluginId;
    if (session.selectPlugin) {
      const selected = await session.selectPlugin(pluginId);
      this.assertCurrent(session);
      session.context.pluginId = selected;
      const state = this.states.get(tviewId);
      if (state) this.states.set(tviewId, { ...state, selectedPlugin: selected, capabilities: [...(session.capabilities ?? state.capabilities)] });
      return selected;
    }
    throw new Error("Plugin selection is unavailable for this package provider.");
  }

  async applyPreset(tviewId: string, presetId: string): Promise<string> {
    if (!presetId || presetId.length > 100) throw new Error("Preset id is invalid.");
    const session = this.requireSession(tviewId);
    if (!session.applyPreset) throw new Error("Presets are unavailable for this package.");
    const applied = await session.applyPreset(presetId);
    this.assertCurrent(session);
    const state = this.states.get(tviewId);
    if (state) this.states.set(tviewId, { ...state, presetId: applied });
    return applied;
  }

  async selectScenario(tviewId: string, scenarioId: string): Promise<string> {
    const session = this.requireSession(tviewId);
    if (!session.scenarios?.some((scenario) => scenario.id === scenarioId)) {
      throw new Error(`Scenario ${scenarioId} is not declared for TView ${tviewId}.`);
    }
    if (!session.selectScenario) throw new Error("Scenario selection is unavailable for this package.");
    const selected = await session.selectScenario(scenarioId);
    if (this.sessions.get(tviewId) !== session) throw new Error("The scenario request belongs to a stale package.");
    const selectedProperty = Object.getOwnPropertyDescriptor(session, "selectedScenarioId");
    if (!selectedProperty || selectedProperty.writable || selectedProperty.set) session.selectedScenarioId = selected;
    return selected;
  }

  async playback(tviewId: string, command: "play" | "pause" | "restart" | "seek" | "speed", value?: number, generation?: number) {
    const session = this.requireSession(tviewId);
    const { playback } = session;
    if (!playback) throw new Error("Playback is unavailable for this package.");
    const expected = generation ?? session.context.generation;
    if (expected !== session.context.generation || !this.sessions.isCurrent({ tviewId, generation: expected })) {
      throw new Error("Playback command belongs to a stale Testudo package.");
    }
    let state: TestudoPlaybackState;
    if (command === "play") state = await playback.play(tviewId, expected);
    else if (command === "pause") state = await playback.pause(tviewId, expected);
    else if (command === "restart") state = await playback.restart(tviewId, expected);
    else if (command === "seek") {
      if (!Number.isFinite(value) || value! < 0) throw new Error("Playback tick must be a non-negative number.");
      state = await playback.seek(tviewId, expected, value!);
    } else {
      if (!Number.isFinite(value) || value! < 0.25 || value! > 20) throw new Error("Playback speed must be between 0.25 and 20.");
      state = await playback.setSpeed(tviewId, expected, value!);
    }
    this.assertCurrent(session);
    return state;
  }

  getPlaybackState(tviewId: string, generation?: number) {
    const session = this.requireSession(tviewId);
    const expected = generation ?? session.context.generation;
    if (expected !== session.context.generation || !this.sessions.isCurrent({ tviewId, generation: expected })) {
      throw new Error("Playback state belongs to a stale Testudo package.");
    }
    return session.playback?.getPlaybackState(tviewId, expected) ?? {
      available: false, loading: false, playing: false, tick: 0, maxTick: 0, speed: 1, dt: 0, loop: false,
    };
  }

  getCameraView(tviewId: string, generation?: number): TestudoCameraView | null {
    return this.requireSession(tviewId, generation).getCameraView?.() ?? null;
  }

  async setCameraView(tviewId: string, view: TestudoCameraView, generation?: number): Promise<void> {
    const validated = validateTestudoCameraView(view);
    const session = this.requireSession(tviewId, generation);
    if (!session.setCameraView) throw new Error("Camera control is unavailable for this package.");
    await session.setCameraView(validated);
    this.assertCurrent(session);
  }

  async setMapControl(tviewId: string, controlId: string, visible: boolean, generation?: number): Promise<boolean> {
    if (!controlId || controlId.length > 100) throw new Error("Map control id is invalid.");
    const session = this.requireSession(tviewId, generation);
    if (!session.setMapControl) throw new Error("Map controls are unavailable for this package.");
    const changed = await session.setMapControl(controlId, visible);
    this.assertCurrent(session);
    return changed;
  }

  getMapControlState(tviewId: string, generation?: number) {
    return this.requireSession(tviewId, generation).getMapControlState?.() ?? {
      legendVisible: false, esriWorldImageryVisible: false, renderer: "maplibre" as const,
    };
  }

  async setRenderer(tviewId: string, renderer: "maplibre" | "cesium", generation?: number) {
    const session = this.requireSession(tviewId, generation);
    if (!session.setRenderer) throw new Error("Renderer control is unavailable for this package.");
    const selected = await session.setRenderer(renderer);
    this.assertCurrent(session);
    return selected;
  }

  async setKpiGeometry(tviewId: string, geometry: "lanes" | "sections", visible: boolean, generation?: number) {
    const session = this.requireSession(tviewId, generation);
    if (!session.setKpiGeometry) throw new Error("KPI geometry controls are unavailable for this package.");
    const state = await session.setKpiGeometry(geometry, visible);
    this.assertCurrent(session);
    return state;
  }

  getKpiGeometryState(tviewId: string, generation?: number) {
    return this.requireSession(tviewId, generation).getKpiGeometryState?.() ?? { showLanes: false, showSections: false };
  }

  async openAnnotations(tviewId: string, generation?: number) {
    const session = this.requireSession(tviewId, generation);
    if (!session.openAnnotations) throw new Error("Annotations are unavailable for this package.");
    const active = await session.openAnnotations();
    this.assertCurrent(session);
    return active;
  }

  async openRecordTour(tviewId: string, generation?: number) {
    const session = this.requireSession(tviewId, generation);
    if (!session.openRecordTour) throw new Error("Record tours are unavailable for this package.");
    await session.openRecordTour();
    this.assertCurrent(session);
  }

  async openRecordVideo(tviewId: string, generation?: number) {
    const session = this.requireSession(tviewId, generation);
    if (!session.openRecordVideo) throw new Error("Record video is unavailable for this package.");
    await session.openRecordVideo();
    this.assertCurrent(session);
  }

  async setViewMode(tviewId: string, mode: TestudoViewMode): Promise<TestudoViewMode> {
    const session = this.requireSession(tviewId);
    if (!session.setViewMode) throw new Error("View modes are unavailable for this package.");
    const selected = await session.setViewMode(mode);
    this.assertCurrent(session);
    session.selectedMode = selected;
    const state = this.states.get(tviewId);
    if (state) this.states.set(tviewId, { ...state, selectedMode: selected });
    return selected;
  }

  async setNetworkFilter(tviewId: string, filter: TestudoNetworkFilter): Promise<void> {
    const session = this.requireSession(tviewId);
    if (!session.setNetworkFilter) throw new Error("Network filters are unavailable for this package.");
    await session.setNetworkFilter(filter);
    this.assertCurrent(session);
  }

  async requestInvestigation(
    tviewId: string,
    question: string,
    activeScenarioId?: string,
    messages?: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<TestudoInvestigationAccepted> {
    const session = this.requireSession(tviewId);
    // The bridge itself relays to the host through its listeners; a provider hook is optional.
    if (!session.requestGeoAI && this.geoAIListeners.size === 0) throw new Error("GeoAI requests are unavailable for this package.");
    const normalized = question.trim();
    if (!normalized || normalized.length > 8_000) throw new Error("Investigation question must contain 1 to 8000 characters.");
    if (activeScenarioId && !session.scenarios?.some((scenario) => scenario.id === activeScenarioId)) {
      throw new Error(`Scenario ${activeScenarioId} is not declared for TView ${tviewId}.`);
    }
    const requestId = `testudo-ai-${Date.now()}-${++this.sequence}`;
    const transcript = messages ?? [{ role: "user" as const, content: normalized }];
    if (!Array.isArray(transcript) || transcript.length < 1 || transcript.length > 22
      || transcript.some((message) => !message || !["user", "assistant"].includes(message.role)
        || typeof message.content !== "string" || message.content.length > 4_000)
      || transcript[transcript.length - 1]?.role !== "user"
      || transcript[transcript.length - 1]?.content.trim() !== normalized) {
      throw new Error("Investigation transcript is invalid.");
    }
    const playback = session.playback?.getPlaybackState(tviewId, session.context.generation);
    const camera = session.getCameraView?.();
    const displayContext = {
      ...(playback && Number.isFinite(playback.tick) && playback.tick >= 0 && playback.tick <= 1_000_000
        ? { tick: playback.tick } : {}),
      ...(camera ? { camera: validateTestudoCameraView(camera) } : {}),
    };
    const request: TestudoGeoAIRequest = {
      requestId,
      messages: transcript.map(({ role, content }) => ({ role, content })),
      context: {
        ...session.context, ...(activeScenarioId ? { scenarioId: activeScenarioId } : {}),
        ...(Object.keys(displayContext).length ? { displayContext } : {}),
      },
    };
    this.pendingGeoAI.set(requestId, { request, session });
    try {
      for (const listener of this.geoAIListeners) listener(request);
      await session.requestGeoAI?.(request);
    } catch (error) {
      this.pendingGeoAI.delete(requestId);
      throw error;
    }
    this.assertCurrent(session);
    return { requestId, tviewId, generation: session.context.generation, accepted: true };
  }

  /** Invalidate a request so any later tuple-bound reply is ignored. */
  cancelGeoAIRequest(requestId: string): boolean {
    return this.pendingGeoAI.delete(requestId);
  }

  async respondGeoAIRequest(
    requestId: string,
    context: TestudoGeoAIRequest["context"],
    reply: TestudoGeoAIReply,
  ): Promise<{ requestId: string; accepted: boolean }> {
    const pending = this.pendingGeoAI.get(requestId);
    const expected = pending?.request.context;
    const sameContext = expected && expected.tviewId === context.tviewId
      && expected.generation === context.generation && expected.packageId === context.packageId
      && expected.versionId === context.versionId && expected.pluginId === context.pluginId
      && expected.scenarioId === context.scenarioId;
    if (!pending || !sameContext || !this.sessions.isCurrent({ tviewId: context.tviewId, generation: context.generation })) {
      return { requestId, accepted: false };
    }
    this.pendingGeoAI.delete(requestId);
    await pending.session.deliverGeoAIReply?.(requestId, reply);
    const delivered = { ...reply, requestId, tviewId: context.tviewId, generation: context.generation };
    for (const listener of this.geoAIReplyListeners) listener(delivered);
    return { requestId, accepted: true };
  }

  async respondGeoAIRequestTuple(
    requestId: string,
    tviewId: string,
    generation: number,
    reply: TestudoGeoAIReply,
  ): Promise<{ requestId: string; accepted: boolean }> {
    const pending = this.pendingGeoAI.get(requestId);
    const context = pending?.request.context;
    if (!context || context.tviewId !== tviewId || context.generation !== generation) {
      return { requestId, accepted: false };
    }
    return this.respondGeoAIRequest(requestId, context, reply);
  }

  close(tviewId: string): void {
    this.cancelArtifactRequests(tviewId);
    this.pendingLoads.delete(tviewId);
    const session = this.sessions.get(tviewId);
    this.playbackSubscriptions.get(tviewId)?.();
    this.playbackSubscriptions.delete(tviewId);
    if (session) {
      for (const [requestId, pending] of this.pendingGeoAI) {
        if (pending.session === session) this.pendingGeoAI.delete(requestId);
      }
    }
    const generation = (this.generations.get(tviewId) ?? 0) + 1;
    this.generations.set(tviewId, generation);
    if (session) this.sessions.remove(tviewId);
    this.tviews.delete(tviewId);
    this.states.delete(tviewId);
    this.bootstraps.delete(tviewId);
    this.localArtifactReaders.delete(tviewId);
    if (this.activeTViewId === tviewId) {
      this.activeTViewId = null;
      for (const listener of this.activeTViewListeners) listener(null);
    }
  }

  private requireSession(tviewId: string, generation?: number): TestudoFeatureSession {
    const session = this.sessions.get(tviewId);
    if (!session) throw new Error(`No Testudo package is loaded for TView ${tviewId}.`);
    if (generation !== undefined && generation !== session.context.generation) {
      throw new Error("This command belongs to a stale Testudo package generation.");
    }
    return session;
  }

  private assertCurrent(session: TestudoFeatureSession): void {
    if (this.sessions.get(session.context.tviewId) !== session) throw new Error("This command belongs to a stale Testudo package.");
  }

  private async loadSession(provider: TestudoFeatureSession, onProgress: (progress: TestudoPackageProgress) => void) {
    await provider.loadPackage!(onProgress);
    return provider;
  }
}
