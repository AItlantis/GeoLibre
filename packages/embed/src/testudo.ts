export type TestudoCapabilityId = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison";
export type TestudoDemoMode = "animation" | "flow" | "paths" | "density";
export type TestudoViewMode = TestudoDemoMode;
export type TestudoRenderer = "maplibre" | "cesium";
export type TestudoKpiGeometry = "lanes" | "sections";

export interface TestudoCapability { id: TestudoCapabilityId; available: boolean; reason?: string }
export interface TestudoBootstrap {
  packageId: string;
  versionId: string;
  label: string;
  origin: "published";
  manifestPath: string;
  nativeManifestPath: string;
  artifactEndpoint: string;
  capabilities: TestudoCapability[];
  presets: Array<{ id: string; label?: string; plugin: TestudoCapabilityId; settings?: Record<string, string | number | boolean>; view?: { center: [number, number]; zoom: number; pitch?: number; bearing?: number } }>;
}

export interface TestudoPackageProgress { label: string; value: number; loaded: number; total: number }
export interface TestudoViewerState {
  tviewId: string;
  generation: number;
  package: { packageId: string; versionId: string | null; label: string; origin: "published" | "local" } | null;
  selectedPlugin: TestudoCapabilityId | null;
  capabilities: TestudoCapability[];
  availableModes: TestudoDemoMode[];
  selectedMode?: TestudoDemoMode;
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
  progress?: TestudoPackageProgress;
}
export interface TestudoPlaybackState {
  available: boolean;
  loading: boolean;
  playing: boolean;
  tick: number;
  maxTick: number;
  speed: number;
  dt: number;
  loop: boolean;
  activeCapability?: TestudoCapabilityId;
  tickFollowers?: Array<{ capability: TestudoCapabilityId; following: boolean; timeSeriesAvailable: boolean }>;
}
export interface TestudoLoadPackage { tviewId: string; bootstrap: TestudoBootstrap; selectedPlugin?: TestudoCapabilityId; presetId?: string }
export interface TestudoOpenLocalPackage { tviewId: string }
export interface TestudoScenarioState { id: string; label: string; selected: boolean; replicationIds: number[] }
export interface TestudoCameraView { center: [number, number]; zoom: number; bearing?: number; pitch?: number }
export interface TestudoNetworkFilter { id: string; enabled: boolean; value?: string | number | boolean }
export interface TestudoMapControlState { legendVisible: boolean; esriWorldImageryVisible: boolean; renderer: TestudoRenderer }
export interface TestudoActiveTView { tviewId: string | null }
export interface TestudoTViewInfo { tviewId: string; generation: number; loaded: boolean }
export interface TestudoGeoAIRequest {
  requestId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: {
    tviewId: string; generation: number; packageId: string; versionId: string; pluginId: string; scenarioId?: string;
    displayContext?: { tick?: number; camera?: TestudoCameraView };
  };
}

export interface TestudoScopedPayload { tviewId: string; generation?: number }
export interface TestudoInvestigationAccepted { requestId: string; tviewId: string; generation: number; accepted: true }
/** Credential-free reference requested by a Testudo iframe from its embedding host. */
export interface TestudoArtifactRequest {
  requestId: string;
  tviewId: string;
  generation: number;
  artifactRef: string;
}

/** Host-side artifact resolver; credentials stay in the host's closure. */
export interface TestudoArtifactFetchRequest extends Omit<TestudoArtifactRequest, "requestId"> {}
export type TestudoArtifactFetcher = (
  request: TestudoArtifactFetchRequest,
  signal: AbortSignal,
) => Promise<ArrayBuffer | Uint8Array | Blob>;
export interface TestudoGeoAIReplyPayload {
  requestId: string;
  tviewId: string;
  generation: number;
  content?: string;
  error?: string;
  /** Display-only suggestions. The iframe validates each item before exposing it as a chip. */
  proposedActions?: TestudoGeoAIProposedAction[];
}
export type TestudoGeoAIProposedAction =
  | { type: "plugin"; label: string; value: TestudoCapabilityId }
  | { type: "scenario"; label: string; value: string }
  | { type: "seek"; label: string; value: number }
  | { type: "mapControl"; label: string; controlId: "legend" | "esri-world-imagery"; value: boolean }
  | { type: "camera"; label: string; value: TestudoCameraView };
