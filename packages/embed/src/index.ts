import type {
  TestudoBootstrap,
  TestudoActiveTView,
  TestudoTViewInfo,
  TestudoCameraView,
  TestudoCapabilityId,
  TestudoDemoMode,
  TestudoGeoAIReplyPayload,
  TestudoGeoAIRequest,
  TestudoInvestigationAccepted,
  TestudoKpiGeometry,
  TestudoLoadPackage,
  TestudoNetworkFilter,
  TestudoMapControlState,
  TestudoPlaybackState,
  TestudoRenderer,
  TestudoScenarioState,
  TestudoArtifactFetchRequest,
  TestudoArtifactFetcher,
  TestudoArtifactRequest,
  TestudoScopedPayload,
  TestudoViewerState,
} from "./testudo";
export type * from "./testudo";

/** Current GeoLibre iframe protocol version. Version 1 requests remain supported by the app. */
export const EMBED_API_VERSION = 2 as const;
export const EMBED_API_SOURCE = "geolibre" as const;

export type MapRenderer = "maplibre" | "cesium" | "mapbox" | "arcgis";

export interface Viewport {
  bbox?: [number, number, number, number] | null;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export type ViewTarget =
  | { bbox: [number, number, number, number] }
  | {
      center?: [number, number];
      zoom?: number;
      bearing?: number;
      pitch?: number;
      duration?: number;
    };

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

export interface AddLayerSpec {
  id: string;
  name: string;
  type: string;
  source: Record<string, unknown>;
  visible?: boolean;
  opacity?: number;
  style?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  geojson?: unknown;
  beforeId?: string;
}

export interface AddDataOptions {
  styleUrl?: string;
  /** Fit the map to the newly added data. Defaults to true. */
  fit?: boolean;
}

export type EmbedEventMap = {
  ready: { version: string; challenge?: string };
  testudoStateChanged: TestudoViewerState;
  testudoActiveTViewChanged: TestudoActiveTView;
  testudoPlaybackChanged: TestudoPlaybackState & TestudoScopedPayload;
  testudoGeoAIRequest: TestudoGeoAIRequest;
  /** The Testudo shell should show its local package folder picker. */
  testudoOpenLocalPackageRequested: { challenge: string };
  /**
   * Every command already returns a promise the client settles from this ack,
   * so subscribing is only worth it to observe the traffic (logging, or an ack
   * that arrives with no request waiting for it).
   */
  ack: { requestId: string; ok: boolean; error?: string; result?: unknown };
  projectLoaded: { url: string | null; name: string; layerIds: string[] };
  selectionChanged: { layerId: string | null; featureIds: string[] };
  rendererchange: { renderer: MapRenderer };
  viewChanged: Viewport;
  toolCompleted: Record<string, unknown>;
  serverFileWritten: { path: string; toolId: string };
};

type EventName = keyof EmbedEventMap;
type Listener<K extends EventName> = (payload: EmbedEventMap[K]) => void;

export interface ConnectOptions {
  /** Exact origin hosting the GeoLibre iframe. */
  origin: string;
  /** Time allowed for the initial ready event. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Time allowed for each command acknowledgement. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
  /** Host-owned artifact fetcher. Any credentials it uses remain in this closure. */
  fetchArtifact?: TestudoArtifactFetcher;
}

export interface GeoLibreEmbedClient {
  testudoCreateTView(payload: { tviewId: string }): Promise<TestudoTViewInfo>;
  testudoGetTViews(): Promise<TestudoTViewInfo[]>;
  testudoSetActiveTView(payload: { tviewId: string }): Promise<TestudoActiveTView>;
  testudoGetActiveTView(): Promise<TestudoActiveTView>;
  testudoLoadPackage(payload: TestudoLoadPackage): Promise<TestudoViewerState>;
  testudoSetPlugin(payload: TestudoScopedPayload & { id: TestudoCapabilityId }): Promise<TestudoViewerState>;
  testudoSetMode(payload: TestudoScopedPayload & { mode: TestudoDemoMode }): Promise<TestudoViewerState>;
  testudoSetPreset(payload: TestudoScopedPayload & { id: string }): Promise<TestudoViewerState>;
  testudoGetState(payload: TestudoScopedPayload): Promise<TestudoViewerState>;
  testudoSetScenario(payload: TestudoScopedPayload & { scenarioId: string }): Promise<TestudoScenarioState>;
  testudoSetPlaybackPlaying(payload: TestudoScopedPayload & { playing: boolean; generation?: number }): Promise<TestudoPlaybackState>;
  testudoRestartPlayback(payload: TestudoScopedPayload & { generation?: number }): Promise<TestudoPlaybackState>;
  testudoSeekPlayback(payload: TestudoScopedPayload & { tick: number; generation?: number }): Promise<TestudoPlaybackState>;
  testudoSetPlaybackSpeed(payload: TestudoScopedPayload & { speed: number; generation?: number }): Promise<TestudoPlaybackState>;
  testudoGetPlaybackState(payload: TestudoScopedPayload & { generation?: number }): Promise<TestudoPlaybackState>;
  testudoSetCameraView(payload: TestudoScopedPayload & { view: TestudoCameraView }): Promise<TestudoCameraView>;
  testudoGetCameraView(payload: TestudoScopedPayload): Promise<TestudoCameraView | null>;
  testudoSetMapControl(payload: TestudoScopedPayload & { controlId: string; visible: boolean }): Promise<{ visible: boolean }>;
  testudoSetViewMode(payload: TestudoScopedPayload & { mode: TestudoDemoMode }): Promise<{ mode: TestudoDemoMode }>;
  testudoSetNetworkFilter(payload: TestudoScopedPayload & { filter: TestudoNetworkFilter }): Promise<{ applied: true }>;
  testudoSetLegendVisibility(payload: TestudoScopedPayload & { visible: boolean }): Promise<{ visible: boolean }>;
  testudoSetEsriWorldImagery(payload: TestudoScopedPayload & { visible: boolean }): Promise<{ visible: boolean }>;
  testudoSetKpiGeometry(payload: TestudoScopedPayload & { geometry: TestudoKpiGeometry; visible: boolean }): Promise<{ showLanes: boolean; showSections: boolean }>;
  testudoGetKpiGeometryState(payload: TestudoScopedPayload): Promise<{ showLanes: boolean; showSections: boolean }>;
  testudoSetRenderer(payload: TestudoScopedPayload & { renderer: TestudoRenderer }): Promise<{ renderer: TestudoRenderer }>;
  testudoGetMapControlState(payload: TestudoScopedPayload): Promise<TestudoMapControlState>;
  testudoRequestInvestigation(payload: { question: string; tviewId: string; activeScenarioId?: string }): Promise<TestudoInvestigationAccepted>;
  testudoRespondGeoAIRequest(payload: TestudoGeoAIReplyPayload): Promise<{ requestId: string; accepted: boolean }>;
  testudoOpenAnnotations(payload: TestudoScopedPayload): Promise<{ active: boolean }>;
  testudoOpenRecordTour(payload: TestudoScopedPayload): Promise<{ opened: true }>;
  testudoOpenRecordVideo(payload: TestudoScopedPayload): Promise<{ opened: true }>;
  loadProject(url: string): Promise<void>;
  setView(target: ViewTarget): Promise<void>;
  highlightFeature(payload: {
    layerId: string;
    featureId?: string | number;
    featureIds?: Array<string | number>;
    filter?: Record<string, unknown>;
    fit?: boolean;
  }): Promise<void>;
  openTool(id: string, params?: Record<string, string | number | boolean>): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): Promise<void>;
  listLayers(): Promise<LayerSummary[]>;
  setFilter(layerId: string, expression: unknown[] | null): Promise<void>;
  setRenderer(renderer: MapRenderer): Promise<void>;
  getRenderer(): Promise<MapRenderer>;
  getViewport(): Promise<Viewport>;
  addLayer(spec: AddLayerSpec): Promise<string>;
  addData(url: string, options?: AddDataOptions): Promise<string[]>;
  exportImage(): Promise<string>;
  on<K extends EventName>(type: K, listener: Listener<K>): () => void;
  disconnect(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function validOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin === "null") throw new Error("origin must be an http(s) origin");
  return origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /authorization|token|credential|password|secret/i.test(key) || containsCredentialField(child));
}

function isSafeArtifactReference(value: string): boolean {
  if (!value.trim() || value.length > 2048 || /[?#\\\u0000-\u001f]/.test(value)
    || value.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  try {
    return !decodeURIComponent(value).split("/").some((part) => part === "..");
  } catch {
    return false;
  }
}

/** Connect to a framed GeoLibre app and wait until its embed API is ready. */
export function connect(
  iframe: HTMLIFrameElement,
  options: ConnectOptions,
): Promise<GeoLibreEmbedClient> {
  // Every failure leaves through the returned promise, including this one:
  // `validOrigin` throws synchronously, and a caller writing
  // `connect(iframe, opts).catch(...)` — the shape the `Promise` return type
  // invites — would never see it, because the throw happens before `.catch` is
  // attached.
  let origin: string;
  try {
    origin = validOrigin(options.origin);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const target = iframe.contentWindow;
  if (!target) return Promise.reject(new Error("The iframe has no contentWindow"));

  let sequence = 0;
  let testudoChallenge: string | null = null;
  let disconnected = false;
  const pending = new Map<string, Pending>();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const currentGenerations = new Map<string, number>();
  const artifactFetches = new Map<string, {
    request: TestudoArtifactRequest;
    controller: AbortController;
  }>();

  const updateGeneration = (tviewId: string, generation: number) => {
    if (!tviewId || !Number.isSafeInteger(generation) || generation < 0) return;
    const previous = currentGenerations.get(tviewId);
    if (previous !== undefined && generation < previous) return;
    currentGenerations.set(tviewId, generation);
    for (const [requestId, pendingFetch] of artifactFetches) {
      if (pendingFetch.request.tviewId === tviewId && pendingFetch.request.generation !== generation) {
        artifactFetches.delete(requestId);
        pendingFetch.controller.abort();
      }
    }
  };

  const send = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    const requestId = `geolibre-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, type, payload, requestId }, origin);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for a response to "${type}"`));
      }, options.requestTimeoutMs ?? 15_000);
      pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value as T);
        },
        reject: (reason) => {
          window.clearTimeout(timer);
          reject(reason);
        },
      });
    });
  };

  let readyResolve: ((client: GeoLibreEmbedClient) => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const ready = new Promise<GeoLibreEmbedClient>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const client: GeoLibreEmbedClient = {
    testudoCreateTView: (payload) => sendTestudo<TestudoTViewInfo>("testudoCreateTView", payload).then((result) => {
      updateGeneration(result.tviewId, result.generation);
      return result;
    }),
    testudoGetTViews: () => sendTestudo<TestudoTViewInfo[]>("testudoGetTViews").then((views) => {
      for (const view of views) updateGeneration(view.tviewId, view.generation);
      return views;
    }),
    testudoSetActiveTView: (payload) => sendTestudo<TestudoActiveTView>("testudoSetActiveTView", payload),
    testudoGetActiveTView: () => sendTestudo<TestudoActiveTView>("testudoGetActiveTView"),
    testudoLoadPackage: (payload) => {
      updateGeneration(payload.tviewId, (currentGenerations.get(payload.tviewId) ?? 0) + 1);
      return sendTestudo<TestudoViewerState>("testudoLoadPackage", payload as unknown as Record<string, unknown>).then((state) => {
        updateGeneration(state.tviewId, state.generation);
        return state;
      });
    },
    testudoSetPlugin: (payload) => sendTestudo<TestudoViewerState>("testudoSetPlugin", payload as unknown as Record<string, unknown>),
    testudoSetMode: (payload) => sendTestudo<TestudoViewerState>("testudoSetMode", payload as unknown as Record<string, unknown>),
    testudoSetPreset: (payload) => sendTestudo<TestudoViewerState>("testudoSetPreset", payload as unknown as Record<string, unknown>),
    testudoGetState: (payload) => sendTestudo<TestudoViewerState>("testudoGetState", payload as unknown as Record<string, unknown>),
    testudoSetScenario: (payload) => sendTestudo<TestudoScenarioState>("testudoSetScenario", payload as unknown as Record<string, unknown>),
    testudoSetPlaybackPlaying: (payload) => sendTestudo<TestudoPlaybackState>("testudoSetPlaybackPlaying", payload as unknown as Record<string, unknown>),
    testudoRestartPlayback: (payload) => sendTestudo<TestudoPlaybackState>("testudoRestartPlayback", payload as unknown as Record<string, unknown>),
    testudoSeekPlayback: (payload) => sendTestudo<TestudoPlaybackState>("testudoSeekPlayback", payload as unknown as Record<string, unknown>),
    testudoSetPlaybackSpeed: (payload) => sendTestudo<TestudoPlaybackState>("testudoSetPlaybackSpeed", payload as unknown as Record<string, unknown>),
    testudoGetPlaybackState: (payload) => sendTestudo<TestudoPlaybackState>("testudoGetPlaybackState", payload as unknown as Record<string, unknown>),
    testudoSetCameraView: (payload) => sendTestudo<TestudoCameraView>("testudoSetCameraView", payload as unknown as Record<string, unknown>),
    testudoGetCameraView: (payload) => sendTestudo<TestudoCameraView | null>("testudoGetCameraView", payload as unknown as Record<string, unknown>),
    testudoSetMapControl: (payload) => sendTestudo<{ visible: boolean }>("testudoSetMapControl", payload as unknown as Record<string, unknown>),
    testudoSetViewMode: (payload) => sendTestudo<{ mode: TestudoDemoMode }>("testudoSetViewMode", payload as unknown as Record<string, unknown>),
    testudoSetNetworkFilter: (payload) => sendTestudo<{ applied: true }>("testudoSetNetworkFilter", payload as unknown as Record<string, unknown>),
    testudoSetLegendVisibility: (payload) => sendTestudo<{ visible: boolean }>("testudoSetLegendVisibility", payload as unknown as Record<string, unknown>),
    testudoSetEsriWorldImagery: (payload) => sendTestudo<{ visible: boolean }>("testudoSetEsriWorldImagery", payload as unknown as Record<string, unknown>),
    testudoSetKpiGeometry: (payload) => sendTestudo<{ showLanes: boolean; showSections: boolean }>("testudoSetKpiGeometry", payload as unknown as Record<string, unknown>),
    testudoGetKpiGeometryState: (payload) => sendTestudo<{ showLanes: boolean; showSections: boolean }>("testudoGetKpiGeometryState", payload as unknown as Record<string, unknown>),
    testudoSetRenderer: (payload) => sendTestudo<{ renderer: TestudoRenderer }>("testudoSetRenderer", payload as unknown as Record<string, unknown>),
    testudoGetMapControlState: (payload) => sendTestudo<TestudoMapControlState>("testudoGetMapControlState", payload as unknown as Record<string, unknown>),
    testudoRequestInvestigation: (payload) => sendTestudo<TestudoInvestigationAccepted>("testudoRequestInvestigation", payload as unknown as Record<string, unknown>),
    testudoRespondGeoAIRequest: (payload) => sendTestudo<{ requestId: string; accepted: boolean }>("testudoRespondGeoAIRequest", payload as unknown as Record<string, unknown>),
    testudoOpenAnnotations: (payload) => sendTestudo<{ active: boolean }>("testudoOpenAnnotations", payload as unknown as Record<string, unknown>),
    testudoOpenRecordTour: (payload) => sendTestudo<{ opened: true }>("testudoOpenRecordTour", payload as unknown as Record<string, unknown>),
    testudoOpenRecordVideo: (payload) => sendTestudo<{ opened: true }>("testudoOpenRecordVideo", payload as unknown as Record<string, unknown>),
    loadProject: (url) => send("loadProject", { url }),
    setView: (target) => send("setView", target as unknown as Record<string, unknown>),
    highlightFeature: (payload) =>
      send("highlightFeature", payload as unknown as Record<string, unknown>),
    openTool: (id, params = {}) => send("openTool", { id, params }),
    setLayerVisibility: (layerId, visible) => send("setLayerVisibility", { layerId, visible }),
    listLayers: () => send<LayerSummary[]>("listLayers"),
    setFilter: (layerId, expression) => send("setFilter", { layerId, expression }),
    setRenderer: (renderer) => send("setRenderer", { renderer }),
    getRenderer: () => send<MapRenderer>("getRenderer"),
    getViewport: () => send<Viewport>("getViewport"),
    addLayer: (spec) => send<string>("addLayer", { spec }),
    addData: (url, options = {}) => send<string[]>("addData", { url, ...options }),
    exportImage: () => send<string>("exportImage"),
    on: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(type, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      window.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(new Error("Client disconnected"));
      pending.clear();
      for (const artifactFetch of artifactFetches.values()) artifactFetch.controller.abort();
      artifactFetches.clear();
      currentGenerations.clear();
      listeners.clear();
    },
  };

  const sendTestudo = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    if (!testudoChallenge || !/^[a-f0-9]{32}$/.test(testudoChallenge)) return Promise.reject(new Error("The Testudo viewer challenge is unavailable"));
    if (containsCredentialField(payload)) return Promise.reject(new Error("Embed messages cannot carry credentials."));
    const requestId = `testudo-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, source: "testudo", type, payload: { ...payload, challenge: testudoChallenge }, requestId }, origin);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for a response to \"${type}\"`));
      }, options.requestTimeoutMs ?? 15_000);
      pending.set(requestId, {
        resolve: (value) => { window.clearTimeout(timer); resolve(value as T); },
        reject: (reason) => { window.clearTimeout(timer); reject(reason); },
      });
    });
  };

  const handleArtifactRequest = async (data: Record<string, unknown>) => {
    if (!isRecord(data.payload)) return;
    const payload = data.payload;
    const allowedKeys = new Set(["requestId", "tviewId", "generation", "artifactRef", "challenge"]);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key)) || containsCredentialField(payload)) return;
    const { requestId, tviewId, generation, artifactRef, challenge } = payload;
    if (challenge !== testudoChallenge || typeof requestId !== "string" || !requestId || requestId.length > 200
      || typeof tviewId !== "string" || !tviewId || tviewId.length > 120
      || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1
      || typeof artifactRef !== "string" || !isSafeArtifactReference(artifactRef)) return;
    const request: TestudoArtifactRequest = { requestId, tviewId, generation, artifactRef };
    if (currentGenerations.get(tviewId) !== generation || artifactFetches.has(requestId)) return;
    const controller = new AbortController();
    const operation = { request, controller };
    artifactFetches.set(requestId, operation);
    const respond = (result: { bytes?: ArrayBuffer; error?: string }) => {
      if (disconnected || artifactFetches.get(requestId) !== operation
        || currentGenerations.get(tviewId) !== generation || !testudoChallenge) return;
      const payloadOut = {
        requestId, tviewId, generation, artifactRef,
        challenge: testudoChallenge,
        ...(result.bytes ? { bytes: result.bytes } : {}),
        ...(result.error ? { error: result.error.slice(0, 1000) } : {}),
      };
      if (result.bytes) {
        target.postMessage(
          { v: EMBED_API_VERSION, source: "testudo", type: "testudoArtifactResponse", payload: payloadOut },
          origin,
          [result.bytes],
        );
      } else {
        target.postMessage(
          { v: EMBED_API_VERSION, source: "testudo", type: "testudoArtifactResponse", payload: payloadOut },
          origin,
        );
      }
    };
    try {
      if (!options.fetchArtifact) throw new Error("The host has no artifact fetcher configured.");
      const fetched = await options.fetchArtifact({ tviewId, generation, artifactRef } satisfies TestudoArtifactFetchRequest, controller.signal);
      if (controller.signal.aborted || artifactFetches.get(requestId) !== operation
        || currentGenerations.get(tviewId) !== generation) return;
      let bytes: ArrayBuffer;
      if (fetched instanceof ArrayBuffer) bytes = fetched;
      else if (fetched instanceof Blob) bytes = await fetched.arrayBuffer();
      else bytes = fetched.buffer.slice(fetched.byteOffset, fetched.byteOffset + fetched.byteLength) as ArrayBuffer;
      if (controller.signal.aborted || artifactFetches.get(requestId) !== operation
        || currentGenerations.get(tviewId) !== generation) return;
      respond({ bytes });
    } catch (error) {
      if (!controller.signal.aborted) {
      respond({ error: "The host could not fetch the requested artifact." });
      }
    } finally {
      if (artifactFetches.get(requestId) === operation) artifactFetches.delete(requestId);
    }
  };

  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== EMBED_API_SOURCE || data.v !== EMBED_API_VERSION) return;
    const rawType = data.type;
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    if (rawType === "testudoArtifactRequest") {
      void handleArtifactRequest(data);
      return;
    }
    const type = rawType as EventName;
    if (type === "testudoStateChanged" && typeof payload.tviewId === "string" && typeof payload.generation === "number") {
      updateGeneration(payload.tviewId, payload.generation);
    }
    if (type === "ack") {
      // Settling the command promise is the ack's job, but it stays an event
      // too: `ack` is a key of `EmbedEventMap`, so `on("ack", …)` type-checks
      // and has to fire — including for an ack with no pending request, which
      // is exactly the case a host would subscribe to see.
      const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
      const request = requestId ? pending.get(requestId) : undefined;
      if (requestId && request) {
        pending.delete(requestId);
        if (payload.ok === true) request.resolve(payload.result);
        else request.reject(new Error(String(payload.error ?? "GeoLibre request failed")));
      }
    } else if (type === "ready") {
      const challenge = typeof payload.challenge === "string" ? payload.challenge : null;
      testudoChallenge = challenge && /^[a-f0-9]{32}$/.test(challenge) ? challenge : null;
      readyResolve?.(client);
    }
    for (const listener of listeners.get(type) ?? []) listener(payload as never);
  };
  window.addEventListener("message", receive);

  const timer = window.setTimeout(() => {
    client.disconnect();
    readyReject?.(new Error("Timed out waiting for GeoLibre"));
  }, options.timeoutMs ?? 15_000);
  return ready.finally(() => window.clearTimeout(timer));
}
