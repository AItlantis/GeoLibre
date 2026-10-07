export type TestudoCapabilityId = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison" | "geoai" | "geoai-buildings";
/** Map plugins replace one another; GeoAI chat is an independent persistent panel. */
export type TestudoSelectablePluginId = Exclude<TestudoCapabilityId, "geoai">;
export type TestudoDemoMode = "animation" | "flow" | "paths" | "density" | "results" | "comparison" | "environment";
export interface TestudoViewModeMetadata {
  id: "results" | "comparison" | "environment" | "animation" | "paths";
  table: string; column: string; unit: string;
  style: { type: "ramp" | "extrusion"; id?: string; column?: string; max?: number; stops?: string[]; colors?: string[] };
  domains: { sid?: { min?: number; max?: number }; ent?: { min?: number; max?: number }; intervalSeconds?: number };
  alternates?: Array<{ table: string; column: string; unit: string; style: TestudoViewModeMetadata["style"] }>;
  scenarioDidPair?: Array<{ scid: number; did: number }>;
}
export interface TestudoStyle { display: "ramp" | "extrusion"; metric: string; interval: number; maxHeightM: number; scenarioA?: number; scenarioB?: number }
export type TestudoKpiGeometry = "sections" | "lanes" | "turns" | "nodes";
export interface TestudoKpiGeometryState { showSections: boolean; showLanes: boolean; showTurns: boolean; showNodes: boolean }
export interface TestudoMapControlState { legendVisible: boolean; esriWorldImageryVisible: boolean; renderer: "maplibre" | "cesium" }
export interface TestudoNetworkFilter { id: string; enabled: boolean; value?: string | number | boolean }
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
  presets: Array<{ id: string; label?: string; plugin: TestudoSelectablePluginId; settings?: Record<string, string | number | boolean>; view?: { center: [number, number]; zoom: number; pitch?: number; bearing?: number } }>;
}
export interface TestudoViewerState {
  tviewId?: string;
  generation?: number;
  package: { packageId: string; versionId: string | null; label: string; origin: "published" | "local" } | null;
  selectedPlugin: TestudoSelectablePluginId | null;
  /** Whether the independent GeoAI assistant panel is open. */
  assistantOpen: boolean;
  capabilities: TestudoCapability[];
  availableModes: TestudoDemoMode[];
  selectedMode?: TestudoDemoMode;
  viewModes?: Partial<Record<TestudoViewModeMetadata["id"], TestudoViewModeMetadata>>;
  timeAxis?: { fromTime: number; intervalMs: number; intervals: number };
  style?: TestudoStyle;
  scenarios?: Array<{ id: string; label: string }>;
  selectedScenarioId?: string;
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
}
export interface TestudoLoadPackage {
  /** Single Testudo shell view id. Defaults to `main` in the typed client. */
  tviewId?: string;
  bootstrap: TestudoBootstrap;
  challenge?: string;
  selectedPlugin?: TestudoSelectablePluginId;
  presetId?: string;
}
export interface TestudoSetGuestCapability {
  protocol: 1;
  challenge: string;
  guestEmbedToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

export interface TestudoInvestigationSectionSummary {
  sectionId: string | number;
  score: number | null;
  metrics: Record<string, unknown>;
}

export interface TestudoGeoAiInvestigationSummary {
  reply: string;
  selectedScenario: { id: string | number; name?: string } | null;
  currentTopSections: TestudoInvestigationSectionSummary[];
  worseningTopSections: TestudoInvestigationSectionSummary[];
  evidenceGaps: string[];
}

export interface TestudoGeoAiInvestigationUpdate {
  requestId: string;
  question: string;
  status: "complete" | "error";
  summary?: TestudoGeoAiInvestigationSummary;
  error?: string;
}

/** A credential-free artifact reference requested by a loaded Testudo package. */
export interface TestudoArtifactRequest { requestId: string; tviewId: string; generation: number; artifactRef: string }
export interface TestudoArtifactFetchRequest extends Omit<TestudoArtifactRequest, "requestId"> {}
export type TestudoArtifactFetcher = (request: TestudoArtifactFetchRequest, signal: AbortSignal) => Promise<ArrayBuffer | Uint8Array | Blob>;
export interface TestudoTViewInfo { tviewId: string; generation: number; loaded: boolean }
export interface TestudoActiveTView { tviewId: string | null }
export interface TestudoScopedPayload { tviewId: string; generation?: number }
export interface TestudoCameraView { center: [number, number]; zoom: number; bearing?: number; pitch?: number }
export interface TestudoPlaybackState { available: boolean; loading: boolean; playing: boolean; tick: number; maxTick: number; speed: number; dt: number; loop: boolean }
export interface TestudoGeoAIRequest {
  requestId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: { tviewId: string; generation: number; packageId: string; versionId: string | null; pluginId: string | null; scenarioId?: string; displayContext?: { tick?: number; camera?: TestudoCameraView; viewerContext?: Record<string, unknown> } };
}
export interface TestudoGeoAIReply { requestId: string; tviewId: string; generation: number; content?: string; error?: string; proposedActions?: unknown[]; scenario_analysis?: Record<string, unknown>; viewer_action?: { scenario_id: string | number; section_id?: string | number | null; version_id: string; source: "server_catalog" } }
