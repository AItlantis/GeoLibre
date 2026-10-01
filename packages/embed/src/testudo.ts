export type TestudoCapabilityId = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison" | "geoai" | "geoai-buildings";
/** Map plugins replace one another; GeoAI chat is an independent persistent panel. */
export type TestudoSelectablePluginId = Exclude<TestudoCapabilityId, "geoai">;
export type TestudoDemoMode = "animation" | "flow" | "paths" | "density";
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
  package: { packageId: string; versionId: string | null; label: string; origin: "published" | "local" } | null;
  selectedPlugin: TestudoSelectablePluginId | null;
  /** Whether the independent GeoAI assistant panel is open. */
  assistantOpen: boolean;
  capabilities: TestudoCapability[];
  availableModes: TestudoDemoMode[];
  selectedMode?: TestudoDemoMode;
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
}
export interface TestudoLoadPackage {
  bootstrap: TestudoBootstrap;
  /** Existing account transport; guest auth is injected from in-memory child state. */
  transport?: { bearerToken?: string };
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
