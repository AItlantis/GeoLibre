export type TestudoCapabilityId = "vehicle-playback" | "network-kpi" | "path-analysis" | "emissions-h3" | "scenario-comparison";
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
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  presetId?: string;
}
export interface TestudoLoadPackage {
  bootstrap: TestudoBootstrap;
  transport: { bearerToken: string };
  selectedPlugin?: TestudoCapabilityId;
  presetId?: string;
}
