import type { TestudoBootstrap, TestudoCapabilityId, TestudoDemoMode } from "@geolibre/embed";

const CAPABILITY_IDS: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai", "geoai-buildings"];
const PRESET_PLUGIN_IDS = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai-buildings"] as const;
export const TESTUDO_COMMANDS = ["testudoSetGuestCapability", "testudoLoadPackage", "testudoOpenLocalPackage", "testudoSetPlugin", "testudoSetMode", "testudoOpenGeoAiChat", "testudoRequestInvestigation", "testudoSetPreset", "testudoGetState", "testudoCreateTView", "testudoDestroyTView", "testudoGetTView", "testudoGetTViews", "testudoSetActiveTView", "testudoGetActiveTView", "testudoSetScenario", "testudoSetScenarioPair", "testudoSetStyle", "testudoSetPlaybackPlaying", "testudoRestartPlayback", "testudoSeekPlayback", "testudoSetPlaybackSpeed", "testudoGetPlaybackState", "testudoSetCameraView", "testudoGetCameraView", "testudoSetMapControl", "testudoSetViewMode", "testudoSetNetworkFilter", "testudoSetLegendVisibility", "testudoSetEsriWorldImagery", "testudoSetKpiGeometry", "testudoGetKpiGeometryState", "testudoSetRenderer", "testudoGetMapControlState", "testudoOpenAnnotations", "testudoOpenRecordTour", "testudoOpenRecordVideo", "testudoRecordTour", "testudoRecordVideo", "testudoFeatureRequestInvestigation", "testudoRespondGeoAIRequest"] as const;
export const TESTUDO_DEMO_MODES: TestudoDemoMode[] = ["animation", "flow", "paths", "density", "results", "comparison", "environment"];

export const TESTUDO_CHALLENGE_RE = /^[a-f0-9]{32}$/;
export const TESTUDO_GUEST_TOKEN_RE = /^[A-Za-z0-9._~-]{32,4096}$/;
export const TESTUDO_SUPERSEDE_STARTUP_PROJECT_EVENT = "testudo:supersede-startup-project" as const;
export const TESTUDO_NATIVE_ACTION_EVENT = "testudo:native-action" as const;

export type TestudoNativeActionResult = { ok: true } | { ok: false; error: string };

export interface TestudoNativeActionDetail {
  source: "testudo";
  action: "record-tour" | "record-video" | "annotations";
  requestId: string;
  tviewId: "main";
  generation: number;
  respond: (result: TestudoNativeActionResult) => void;
}

export function createTestudoNativeActionEvent(detail: TestudoNativeActionDetail): CustomEvent<TestudoNativeActionDetail> {
  return new CustomEvent(TESTUDO_NATIVE_ACTION_EVENT, { detail });
}

export function isTestudoNativeActionEvent(event: Event): event is CustomEvent<TestudoNativeActionDetail> {
  if (event.type !== TESTUDO_NATIVE_ACTION_EVENT || !(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<TestudoNativeActionDetail> | null;
  return detail?.source === "testudo" && ["record-tour", "record-video", "annotations"].includes(String(detail.action))
    && typeof detail.requestId === "string" && detail.requestId.length > 0 && detail.requestId.length <= 200
    && detail.tviewId === "main" && Number.isSafeInteger(detail.generation) && Number(detail.generation) >= 0
    && typeof detail.respond === "function";
}

export interface TestudoSupersedeStartupProjectDetail {
  source: "testudo";
  requestId: string;
}

export function createTestudoSupersedeStartupProjectEvent(requestId: string): CustomEvent<TestudoSupersedeStartupProjectDetail> {
  return new CustomEvent(TESTUDO_SUPERSEDE_STARTUP_PROJECT_EVENT, { detail: { source: "testudo", requestId } });
}

export function isTestudoSupersedeStartupProjectEvent(event: Event): event is CustomEvent<TestudoSupersedeStartupProjectDetail> {
  if (event.type !== TESTUDO_SUPERSEDE_STARTUP_PROJECT_EVENT || !(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<TestudoSupersedeStartupProjectDetail> | null;
  return detail?.source === "testudo" && typeof detail.requestId === "string"
    && detail.requestId.length > 0 && detail.requestId.length <= 200;
}

export interface ScenarioAnalysisViewerAction {
  scenario_id: string | number;
  section_id?: string | number | null;
  version_id: string;
  source: "server_catalog";
}

/** Accept only a server-derived action tied to the active version and package roster. */
export function validateScenarioAnalysisAction(candidate: unknown, versionId: string, declaredScenarioIds: Array<string | number>): ScenarioAnalysisViewerAction | null {
  if (!candidate || typeof candidate !== "object") return null;
  const action = candidate as Record<string, unknown>;
  const scenario = action.scenario_id;
  if (action.version_id !== versionId || action.source !== "server_catalog"
    || !(typeof scenario === "string" && scenario.length > 0 && scenario.length <= 128
      || typeof scenario === "number" && Number.isSafeInteger(scenario))
    || !declaredScenarioIds.some(id => String(id) === String(scenario))) return null;
  const section = action.section_id;
  if (section !== undefined && section !== null
    && !(typeof section === "string" && section.length > 0 && section.length <= 128
      || typeof section === "number" && Number.isSafeInteger(section))) return null;
  return { scenario_id: scenario, section_id: section as string | number | null | undefined,
    version_id: versionId, source: "server_catalog" };
}

/** Validate the package envelope without filtering or copying its declared modes/presets. */
export function validateTestudoBootstrap(candidate: TestudoBootstrap, guest: boolean): TestudoBootstrap {
  if (!candidate || typeof candidate.versionId !== "string" || typeof candidate.packageId !== "string"
    || typeof candidate.label !== "string" || candidate.origin !== "published"
    || candidate.manifestPath !== "manifest.json" || candidate.nativeManifestPath !== "geolibre/package.json"
    || !Array.isArray(candidate.capabilities) || !Array.isArray(candidate.presets)
    || candidate.artifactEndpoint !== `/api/v1/view/${encodeURIComponent(candidate.versionId)}/artifact/`
    || candidate.capabilities.some(item => !CAPABILITY_IDS.includes(item.id) || typeof item.available !== "boolean")
    || candidate.presets.some(item => !item || typeof item.id !== "string" || !item.id || !PRESET_PLUGIN_IDS.includes(item.plugin as typeof PRESET_PLUGIN_IDS[number]))) {
    throw new Error("Invalid Testudo package bootstrap");
  }
  if (guest && (candidate.packageId !== "London/testudo-package-2026-09-24-website-demo-v1"
    || candidate.versionId !== "32787055-7258-45f0-8593-f8c53e1cc788")) {
    throw new Error("Guest capability is scoped to the published London demo");
  }
  return candidate;
}

/** Only the exact, allowlisted parent may send bounded Testudo commands. */
export function acceptsTestudoMessage(event: Pick<MessageEvent, "source" | "origin" | "data">, parent: Window, allowedOrigins: string[], challenge: string): boolean {
  const request = event.data;
  if (event.source !== parent || !allowedOrigins.includes(event.origin)
    || request?.v !== 2 || request.source !== "testudo" || typeof request.requestId !== "string"
    || request.requestId.length === 0 || request.requestId.length > 200 || !TESTUDO_COMMANDS.includes(request.type)) return false;
  if (request.type !== "testudoSetGuestCapability" && containsCredentialField(request.payload)) return false;
  if (request.type === "testudoSetGuestCapability") {
    const payload = request.payload;
    return payload?.protocol === 1 && payload.challenge === challenge && TESTUDO_CHALLENGE_RE.test(challenge)
      && typeof payload.guestEmbedToken === "string" && TESTUDO_GUEST_TOKEN_RE.test(payload.guestEmbedToken)
      && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > Date.now()
      && payload.expiresAt <= Date.now() + 10 * 60_000;
  }
  if (request.type === "testudoSetMode") return request.payload?.challenge === challenge
    && TESTUDO_DEMO_MODES.includes(request.payload?.mode);
  if (request.type === "testudoOpenGeoAiChat") {
    const payload = request.payload;
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    return keys.length === 2 && keys.includes("challenge") && keys.includes("open")
      && payload.challenge === challenge && typeof payload.open === "boolean";
  }
  if (request.type === "testudoRequestInvestigation") {
    const payload = request.payload;
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    return keys.length === 2 && keys.includes("challenge") && keys.includes("question")
      && payload.challenge === challenge && TESTUDO_CHALLENGE_RE.test(challenge)
      && typeof payload.question === "string" && payload.question.trim().length > 0 && payload.question.length <= 4000;
  }
  if (request.type === "testudoOpenLocalPackage") {
    const payload = request.payload;
    if (!payload || typeof payload !== "object" || payload.challenge !== challenge || payload.tviewId !== "main"
      || !isDirectoryHandle(payload.directoryHandle)
      || (payload.generation !== undefined && (!Number.isSafeInteger(payload.generation) || payload.generation < 0))) return false;
    const keys = Object.keys(payload);
    return keys.every(key => ["challenge", "tviewId", "directoryHandle", "generation"].includes(key))
      && keys.includes("directoryHandle");
  }
  return request.payload?.challenge === challenge;
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<FileSystemDirectoryHandle>;
  return handle.kind === "directory" && typeof handle.name === "string" && handle.name.length <= 255
    && typeof handle.getFileHandle === "function" && typeof handle.getDirectoryHandle === "function";
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /authorization|token|credential|password|secret/i.test(key) || containsCredentialField(child));
}

/** Return only the four package-backed modes surfaced by the website demo. */
export function availableTestudoModes(features: { animation: boolean; flow: boolean; paths: boolean; density: boolean; results?: boolean; comparison?: boolean; environment?: boolean }): TestudoDemoMode[] {
  return TESTUDO_DEMO_MODES.filter(mode => features[mode]);
}

/** Accept the legacy scalar index and package/scenario-scoped index maps. */
export function hasDeclaredPathIndex(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}
