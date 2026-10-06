import type { TestudoLoadPackage, TestudoViewerState, TestudoSelectablePluginId, TestudoDemoMode, TestudoSetGuestCapability, TestudoGeoAiInvestigationUpdate, TestudoArtifactFetcher, TestudoArtifactRequest, TestudoTViewInfo, TestudoCameraView, TestudoPlaybackState, TestudoGeoAIRequest, TestudoGeoAIReply } from "./testudo";
export type { TestudoLoadPackage, TestudoViewerState, TestudoCapabilityId, TestudoSelectablePluginId, TestudoDemoMode, TestudoBootstrap, TestudoCapability, TestudoSetGuestCapability, TestudoGeoAiInvestigationSummary, TestudoGeoAiInvestigationUpdate, TestudoInvestigationSectionSummary, TestudoArtifactFetcher, TestudoArtifactFetchRequest, TestudoArtifactRequest, TestudoTViewInfo, TestudoActiveTView, TestudoScopedPayload, TestudoCameraView, TestudoPlaybackState, TestudoGeoAIRequest, TestudoGeoAIReply } from "./testudo";
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
  testudoArtifactRequest: TestudoArtifactRequest & { challenge: string };
  testudoGeoAIRequest: TestudoGeoAIRequest;
  testudoGeoAIReply: TestudoGeoAIReply;
  /**
   * Every command already returns a promise the client settles from this ack,
   * so subscribing is only worth it to observe the traffic (logging, or an ack
   * that arrives with no request waiting for it).
   */
  ack: { requestId: string; ok: boolean; error?: string; result?: unknown };
  testudoGeoAiInvestigationUpdate: TestudoGeoAiInvestigationUpdate;
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
  /** Resolve signed package artifacts in the host; credentials remain in this closure. */
  fetchArtifact?: TestudoArtifactFetcher;
}

export interface GeoLibreEmbedClient {
  testudoCreateTView(payload: { tviewId: string }): Promise<TestudoTViewInfo>;
  testudoDestroyTView(payload: { tviewId: string }): Promise<TestudoTViewInfo>;
  testudoGetTView(payload: { tviewId: string }): Promise<TestudoTViewInfo>;
  testudoGetTViews(): Promise<TestudoTViewInfo[]>;
  testudoSetActiveTView(payload: { tviewId: string }): Promise<{ tviewId: string }>;
  testudoGetActiveTView(): Promise<{ tviewId: string | null }>;
  testudoSetGuestCapability(payload: Omit<TestudoSetGuestCapability, "challenge">): Promise<{ protocol: 1; challenge: string; expiresAt: number }>;
  testudoLoadPackage(payload: TestudoLoadPackage): Promise<TestudoViewerState>;
  testudoSetPlugin(payload: { id: TestudoSelectablePluginId }): Promise<TestudoViewerState>;
  /** Open the native folder picker; call directly from a user-activation handler. */
  testudoOpenLocalPackage(): Promise<TestudoViewerState>;
  testudoSetMode(payload: { mode: TestudoDemoMode }): Promise<TestudoViewerState>;
  testudoOpenGeoAiChat(payload: { open: boolean }): Promise<TestudoViewerState>;
  /** Subscribe to testudoGeoAiInvestigationUpdate first, then submit a question and correlate by the returned requestId. */
  testudoRequestInvestigation(question: string): Promise<{ requestId: string; accepted: true }>;
  testudoSetPreset(payload: { id: string }): Promise<TestudoViewerState>;
  testudoGetState(): Promise<TestudoViewerState>;
  testudoSetScenario(payload: { tviewId: string; scenarioId: string; generation?: number }): Promise<{ scenarioId: string }>;
  testudoSetScenarioPair(payload: { tviewId: string; scenarioA: number; scenarioB: number; generation?: number }): Promise<{ scenarioA: number; scenarioB: number }>;
  testudoSetPlaybackPlaying(payload: { tviewId: string; playing: boolean; generation?: number }): Promise<TestudoPlaybackState>;
  testudoRestartPlayback(payload: { tviewId: string; generation?: number }): Promise<TestudoPlaybackState>;
  testudoSeekPlayback(payload: { tviewId: string; tick: number; generation?: number }): Promise<TestudoPlaybackState>;
  testudoSetPlaybackSpeed(payload: { tviewId: string; speed: number; generation?: number }): Promise<TestudoPlaybackState>;
  testudoGetPlaybackState(payload: { tviewId: string; generation?: number }): Promise<TestudoPlaybackState>;
  testudoSetCameraView(payload: { tviewId: string; view: TestudoCameraView; generation?: number }): Promise<TestudoCameraView | null>;
  testudoGetCameraView(payload: { tviewId: string; generation?: number }): Promise<TestudoCameraView | null>;
  testudoFeatureRequestInvestigation(payload: { tviewId: string; question: string; activeScenarioId?: string }): Promise<{ requestId: string; tviewId: string; generation: number; accepted: true }>;
  testudoRespondGeoAIRequest(payload: { requestId: string; tviewId: string; generation: number; content?: string; error?: string; proposedActions?: unknown[]; scenario_analysis?: Record<string, unknown>; viewer_action?: TestudoGeoAIReply["viewer_action"] }): Promise<{ requestId: string; accepted: boolean }>;
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
  const generations = new Map<string, number>();
  const artifactRequests = new Map<string, { request: TestudoArtifactRequest; controller: AbortController }>();
  let disconnected = false;
  const pending = new Map<string, Pending>();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();

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
    testudoCreateTView: (payload) => sendTestudo<TestudoTViewInfo>("testudoCreateTView", payload),
    testudoDestroyTView: (payload) => sendTestudo<TestudoTViewInfo>("testudoDestroyTView", payload).then((view) => { generations.set(view.tviewId, view.generation); return view; }),
    testudoGetTView: (payload) => sendTestudo<TestudoTViewInfo>("testudoGetTView", payload).then((view) => { generations.set(view.tviewId, view.generation); return view; }),
    testudoGetTViews: () => sendTestudo<TestudoTViewInfo[]>("testudoGetTViews").then((views) => { for (const view of views) generations.set(view.tviewId, view.generation); return views; }),
    testudoSetActiveTView: (payload) => sendTestudo("testudoSetActiveTView", payload),
    testudoGetActiveTView: () => sendTestudo("testudoGetActiveTView"),
    testudoSetGuestCapability: (payload) => sendTestudo("testudoSetGuestCapability", payload),
    testudoLoadPackage: (payload) => sendTestudo<TestudoViewerState>("testudoLoadPackage", { ...payload, tviewId: payload.tviewId ?? "main" }),
    testudoOpenLocalPackage: () => sendTestudo<TestudoViewerState>("testudoOpenLocalPackage"),
    testudoSetPlugin: (payload) => sendTestudo<TestudoViewerState>("testudoSetPlugin", payload),
    testudoSetMode: (payload) => sendTestudo<TestudoViewerState>("testudoSetMode", payload),
    testudoOpenGeoAiChat: (payload) => sendTestudo<TestudoViewerState>("testudoOpenGeoAiChat", payload),
    testudoRequestInvestigation: (question) => {
      if (typeof question !== "string" || !question.trim() || question.length > 4000) {
        return Promise.reject(new Error("Investigation question must be nonblank and at most 4000 characters"));
      }
      return sendTestudo<{ requestId: string; accepted: true }>("testudoRequestInvestigation", { question });
    },
    testudoSetPreset: (payload) => sendTestudo<TestudoViewerState>("testudoSetPreset", payload),
    testudoGetState: () => sendTestudo<TestudoViewerState>("testudoGetState"),
    testudoSetScenario: (payload) => sendTestudo("testudoSetScenario", payload as unknown as Record<string, unknown>),
    testudoSetScenarioPair: (payload) => sendTestudo("testudoSetScenarioPair", payload as unknown as Record<string, unknown>),
    testudoSetPlaybackPlaying: (payload) => sendTestudo("testudoSetPlaybackPlaying", payload as unknown as Record<string, unknown>),
    testudoRestartPlayback: (payload) => sendTestudo("testudoRestartPlayback", payload as unknown as Record<string, unknown>),
    testudoSeekPlayback: (payload) => sendTestudo("testudoSeekPlayback", payload as unknown as Record<string, unknown>),
    testudoSetPlaybackSpeed: (payload) => sendTestudo("testudoSetPlaybackSpeed", payload as unknown as Record<string, unknown>),
    testudoGetPlaybackState: (payload) => sendTestudo("testudoGetPlaybackState", payload as unknown as Record<string, unknown>),
    testudoSetCameraView: (payload) => sendTestudo("testudoSetCameraView", payload as unknown as Record<string, unknown>),
    testudoGetCameraView: (payload) => sendTestudo("testudoGetCameraView", payload as unknown as Record<string, unknown>),
    testudoFeatureRequestInvestigation: (payload) => sendTestudo("testudoFeatureRequestInvestigation", payload as unknown as Record<string, unknown>),
    testudoRespondGeoAIRequest: (payload) => sendTestudo("testudoRespondGeoAIRequest", payload as unknown as Record<string, unknown>),
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
      listeners.clear();
      for (const operation of artifactRequests.values()) operation.controller.abort();
      artifactRequests.clear();
    },
  };

  const sendTestudo = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    if (!testudoChallenge || !/^[a-f0-9]{32}$/.test(testudoChallenge)) return Promise.reject(new Error("The Testudo viewer challenge is unavailable"));
    if (type !== "testudoSetGuestCapability" && containsCredentialField(payload)) return Promise.reject(new Error("Embed messages cannot carry credentials."));
    if (type === "testudoLoadPackage" && typeof payload.tviewId === "string") generations.set(payload.tviewId, (generations.get(payload.tviewId) ?? 0) + 1);
    const requestId = `testudo-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, source: "testudo", type, payload: { ...payload, challenge: testudoChallenge }, requestId }, origin);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for a response to "${type}"`));
      }, options.requestTimeoutMs ?? 15_000);
      pending.set(requestId, {
        resolve: value => { window.clearTimeout(timer); resolve(value as T); },
        reject: reason => { window.clearTimeout(timer); reject(reason); },
      });
    });
  };

  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== EMBED_API_SOURCE || data.v !== EMBED_API_VERSION) return;
    const type = data.type as EventName;
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    if (type === "testudoArtifactRequest") { void handleArtifactRequest(data); return; }
    if (type === "testudoStateChanged" && typeof payload.tviewId === "string" && typeof payload.generation === "number") generations.set(payload.tviewId, payload.generation);
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

  const handleArtifactRequest = async (message: Record<string, unknown>) => {
    const payload = message.payload;
    if (!isRecord(payload) || !testudoChallenge || payload.challenge !== testudoChallenge || containsCredentialField(payload)) return;
    const { requestId, tviewId, generation, artifactRef } = payload;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200 || typeof tviewId !== "string" || !tviewId || tviewId.length > 120
      || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || typeof artifactRef !== "string" || !isSafeArtifactReference(artifactRef)
      || generations.get(tviewId) !== generation || artifactRequests.has(requestId)) return;
    const request: TestudoArtifactRequest = { requestId, tviewId, generation, artifactRef };
    const operation = { request, controller: new AbortController() };
    artifactRequests.set(requestId, operation);
    let bytes: ArrayBuffer | undefined; let error: string | undefined;
    try {
      if (!options.fetchArtifact) throw new Error("The host has no artifact fetcher configured.");
      const fetched = await options.fetchArtifact({ tviewId, generation, artifactRef }, operation.controller.signal);
      if (operation.controller.signal.aborted || artifactRequests.get(requestId) !== operation || generations.get(tviewId) !== generation) return;
      bytes = fetched instanceof ArrayBuffer ? fetched : fetched instanceof Blob ? await fetched.arrayBuffer() : fetched.buffer.slice(fetched.byteOffset, fetched.byteOffset + fetched.byteLength) as ArrayBuffer;
    } catch (caught) { error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 1000); }
    if (operation.controller.signal.aborted || artifactRequests.get(requestId) !== operation || generations.get(tviewId) !== generation || !testudoChallenge) return;
    artifactRequests.delete(requestId);
    const response = { v: EMBED_API_VERSION, source: "testudo", type: "testudoArtifactResponse", payload: { ...request, challenge: testudoChallenge, ...(bytes ? { bytes } : { error: error ?? "Artifact fetch failed." }) } };
    try { target.postMessage(response, origin, bytes ? [bytes] : []); } catch { target.postMessage(response, origin); }
  };
  window.addEventListener("message", receive);

  const timer = window.setTimeout(() => {
    client.disconnect();
    readyReject?.(new Error("Timed out waiting for GeoLibre"));
  }, options.timeoutMs ?? 15_000);
  return ready.finally(() => window.clearTimeout(timer));
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /authorization|token|credential|password|secret/i.test(key) || containsCredentialField(child));
}
function isSafeArtifactReference(value: string): boolean {
  if (!value.trim() || value.length > 2048 || /[?#\\\u0000-\u001f]/.test(value) || value.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  try { return !decodeURIComponent(value).split("/").some(part => part === ".."); } catch { return false; }
}
