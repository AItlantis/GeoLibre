export type TestudoCapabilityId = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison";
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
  presets: Array<{ id: string; label?: string; plugin: TestudoCapabilityId; settings?: Record<string, string | number | boolean>; view?: { center: [number, number]; zoom: number; pitch?: number; bearing?: number } }>;
}
export interface TestudoViewerState {
  package: { packageId: string; versionId: string | null; label: string; origin: "published" | "local" } | null;
  selectedPlugin: TestudoCapabilityId | null;
  capabilities: TestudoCapability[];
  availableModes: TestudoDemoMode[];
  selectedMode?: TestudoDemoMode;
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
  /** Native plugin progress only; absent when the loader has no progress source. */
  progress?: { label: string; value?: number; loaded?: number; total?: number };
}
export interface TestudoLoadPackage {
  bootstrap: TestudoBootstrap;
  /** Existing account transport; guest auth is injected from in-memory child state. */
  transport?: { bearerToken?: string };
  challenge?: string;
  selectedPlugin?: TestudoCapabilityId;
  presetId?: string;
}
export interface TestudoSetGuestCapability {
  protocol: 1;
  challenge: string;
  guestEmbedToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

export type TestudoRenderer = "maplibre" | "cesium";
export type TestudoKpiGeometry = "lanes" | "sections";
export interface TestudoKpiGeometryState { showLanes: boolean; showSections: boolean }
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
