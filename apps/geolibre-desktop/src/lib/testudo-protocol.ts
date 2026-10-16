import type { TestudoAnalysisBootstrap, TestudoAnalysisCapabilityId, TestudoAnalysisPluginId, TestudoBootstrap, TestudoCapabilityId, TestudoCloseAnalysis, TestudoDemoMode, TestudoOpenAnalysis, TestudoRefreshAnalysisGrant, TestudoSetAnalysisTime } from "@geolibre/embed";

/** Analyse capability id -> the drop-in plugin it opens (contract C3). */
export const TESTUDO_ANALYSIS_PLUGIN_IDS: Record<TestudoAnalysisCapabilityId, TestudoAnalysisPluginId> = {
  "analysis-counts": "modelling-count-manager",
  "analysis-od": "modelling-od-trips",
  "analysis-journey-time": "modelling-journey-time",
};
export const TESTUDO_ANALYSIS_CAPABILITY_IDS = Object.keys(TESTUDO_ANALYSIS_PLUGIN_IDS) as TestudoAnalysisCapabilityId[];
export function isTestudoAnalysisCapabilityId(value: unknown): value is TestudoAnalysisCapabilityId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TESTUDO_ANALYSIS_PLUGIN_IDS, value);
}
export function isTestudoAnalysisPluginId(value: unknown): value is TestudoAnalysisPluginId {
  return typeof value === "string" && (Object.values(TESTUDO_ANALYSIS_PLUGIN_IDS) as string[]).includes(value);
}

const CAPABILITY_IDS: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai", "geoai-buildings", "analysis-counts", "analysis-od", "analysis-journey-time"];
const PRESET_PLUGIN_IDS = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai-buildings"] as const;
export const TESTUDO_COMMANDS = ["testudoSetGuestCapability", "testudoLoadPackage", "testudoOpenLocalPackage", "testudoSetPlugin", "testudoSetMode", "testudoOpenGeoAiChat", "testudoSetPanels", "testudoSetPresentSuspended", "testudoRequestInvestigation", "testudoSetPreset", "testudoGetState", "testudoCreateTView", "testudoDestroyTView", "testudoGetTView", "testudoGetTViews", "testudoSetActiveTView", "testudoGetActiveTView", "testudoSetScenario", "testudoSetScenarioPair", "testudoSetScenarioPairById", "testudoSetStyle", "testudoSetPlaybackPlaying", "testudoRestartPlayback", "testudoSeekPlayback", "testudoSetPlaybackSpeed", "testudoGetPlaybackState", "testudoSetCameraView", "testudoGetCameraView", "testudoSetMapControl", "testudoSetViewMode", "testudoSetNetworkFilter", "testudoSetLegendVisibility", "testudoSetEsriWorldImagery", "testudoSetKpiGeometry", "testudoGetKpiGeometryState", "testudoSetRenderer", "testudoGetMapControlState", "testudoOpenAnnotations", "testudoOpenRecordTour", "testudoOpenRecordVideo", "testudoRecordTour", "testudoRecordVideo", "testudoFeatureRequestInvestigation", "testudoRespondGeoAIRequest", "testudoOpenAnalysis", "testudoCloseAnalysis", "testudoRefreshAnalysisGrant", "testudoSetAnalysisTime"] as const;
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
    || candidate.presets.some(item => !item || typeof item.id !== "string" || !item.id || !PRESET_PLUGIN_IDS.includes(item.plugin as typeof PRESET_PLUGIN_IDS[number]))
    || (candidate.analysis !== undefined && !isValidAnalysisBootstrap(candidate.analysis))) {
    const expiresAt = (candidate?.analysis as { expiresAt?: unknown } | undefined)?.expiresAt;
    if (typeof expiresAt === "number" && isAmbiguousExpirySeconds(expiresAt)) {
      throw new Error(`Invalid Testudo package bootstrap: analysis.expiresAt must be epoch milliseconds; ${expiresAt} is below ${ANALYSIS_MIN_EPOCH_MS} and looks like seconds.`);
    }
    throw new Error("Invalid Testudo package bootstrap");
  }
  if (guest && (candidate.packageId !== "London/testudo-package-2026-09-24-website-demo-v1"
    || candidate.versionId !== "32787055-7258-45f0-8593-f8c53e1cc788")) {
    throw new Error("Guest capability is scoped to the published London demo");
  }
  return candidate;
}

const ANALYSIS_TEXT_MAX = 400;
const isBoundedText = (value: unknown, max = ANALYSIS_TEXT_MAX): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isOptionalText = (value: unknown): boolean => value === undefined || (typeof value === "string" && value.length <= ANALYSIS_TEXT_MAX);

/** Parse an absolute analysis URL: https, or http only for localhost; no embedded credentials. */
export function parseAnalysisUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url;
}

/** A run manifest path is relative to baseUrl: no scheme, no leading slash, no dot segments. */
function isRelativeManifestPath(value: unknown): value is string {
  return isBoundedText(value, 1024) && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some(segment => segment === ".." || segment === ".");
}

/** Epoch values below this are not milliseconds (1e11 ms is 1973; 1e11 s is year 5138): treated as ambiguous seconds. */
const ANALYSIS_MIN_EPOCH_MS = 1e11;
const isAmbiguousExpirySeconds = (value: number): boolean => Number.isFinite(value) && value < ANALYSIS_MIN_EPOCH_MS;

/** Integer epoch milliseconds (>= 1e11, so seconds are rejected) or an ISO-8601 timestamp, as milliseconds; null when unusable. */
export function analysisExpiryMs(expiresAt: unknown): number | null {
  if (typeof expiresAt === "number") return Number.isSafeInteger(expiresAt) && expiresAt >= ANALYSIS_MIN_EPOCH_MS ? expiresAt : null;
  if (typeof expiresAt === "string" && expiresAt.length > 0 && expiresAt.length <= 64) {
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Optional per-run capability flags: only the three analysis ids, strict booleans. */
function isValidRunCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, flag]) => isTestudoAnalysisCapabilityId(key) && typeof flag === "boolean");
}

/** Validate the optional C4 `analysis` block of a package bootstrap. */
export function isValidAnalysisBootstrap(candidate: unknown): candidate is TestudoAnalysisBootstrap {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const analysis = candidate as Record<string, unknown>;
  const base = parseAnalysisUrl(analysis.baseUrl);
  if (analysis.schemaVersion !== 1 || !base || !String(analysis.baseUrl).endsWith("/")
    || base.search || base.hash || analysisExpiryMs(analysis.expiresAt) === null
    || !Array.isArray(analysis.runs) || analysis.runs.length > 256
    || !analysis.plugins || typeof analysis.plugins !== "object" || Array.isArray(analysis.plugins)) return false;
  const seen = new Set<string>();
  for (const item of analysis.runs) {
    if (!item || typeof item !== "object") return false;
    const run = item as Record<string, unknown>;
    if (!isBoundedText(run.run, 128) || seen.has(run.run) || !isBoundedText(run.label) || typeof run.available !== "boolean"
      || !isOptionalText(run.reason) || !isRelativeManifestPath(run.manifest) || !isValidRunCapabilities(run.capabilities)) return false;
    seen.add(run.run);
  }
  for (const [capability, entry] of Object.entries(analysis.plugins as Record<string, unknown>)) {
    if (!isTestudoAnalysisCapabilityId(capability) || !entry || typeof entry !== "object") return false;
    const plugin = entry as Record<string, unknown>;
    if (plugin.pluginId !== TESTUDO_ANALYSIS_PLUGIN_IDS[capability] || typeof plugin.available !== "boolean" || !isOptionalText(plugin.reason)) return false;
  }
  return true;
}

/** Shape-check a testudoOpenAnalysis payload (challenge is checked by the caller). */
export function isOpenAnalysisPayload(payload: unknown): payload is TestudoOpenAnalysis & { challenge: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).every(key => ["challenge", "plugin", "manifestUrl", "run", "generation"].includes(key))
    && isTestudoAnalysisPluginId(value.plugin) && parseAnalysisUrl(value.manifestUrl) !== null && isBoundedText(value.run, 128)
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1;
}

/** Shape-check a testudoRefreshAnalysisGrant payload (challenge is checked by the caller). */
export function isRefreshAnalysisGrantPayload(payload: unknown): payload is TestudoRefreshAnalysisGrant & { challenge: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  const base = parseAnalysisUrl(value.baseUrl);
  return Object.keys(value).every(key => ["challenge", "baseUrl", "expiresAt"].includes(key))
    && base !== null && String(value.baseUrl).endsWith("/") && !base.search && !base.hash && analysisExpiryMs(value.expiresAt) !== null;
}

/** Strict testudoSetAnalysisTime payload (challenge is checked by the caller): finite seconds, from_s <= cursor_s < to_s, positive generation. */
export function isSetAnalysisTimePayload(payload: unknown): payload is TestudoSetAnalysisTime & { challenge: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return Object.keys(value).every(key => ["challenge", "plugin", "generation", "from_s", "to_s", "cursor_s"].includes(key))
    && isTestudoAnalysisPluginId(value.plugin) && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && finite(value.from_s) && value.from_s >= 0
    && finite(value.to_s) && value.to_s >= 0
    && finite(value.cursor_s) && value.cursor_s >= 0
    && value.from_s <= value.cursor_s && value.cursor_s < value.to_s;
}

export function isCloseAnalysisPayload(payload: unknown): payload is TestudoCloseAnalysis & { challenge: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).every(key => ["challenge", "plugin"].includes(key)) && isTestudoAnalysisPluginId(value.plugin);
}

/** Strict testudoSetPresentSuspended payload: challenge + required boolean suspended, optional tviewId "main"; nothing else. */
export function isSetPresentSuspendedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).every(key => ["challenge", "tviewId", "suspended"].includes(key))
    && typeof value.suspended === "boolean" && (value.tviewId === undefined || value.tviewId === "main");
}

/** Strict testudoSetPanels payload: challenge + required boolean layers/plugins/comments, optional boolean layersCollapsed/hostGeoAi, optional tviewId "main"; nothing else. */
export function isSetPanelsPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).every(key => ["challenge", "tviewId", "layers", "plugins", "comments", "layersCollapsed", "hostGeoAi"].includes(key))
    && typeof value.layers === "boolean" && typeof value.plugins === "boolean" && typeof value.comments === "boolean"
    && (value.layersCollapsed === undefined || typeof value.layersCollapsed === "boolean")
    && (value.hostGeoAi === undefined || typeof value.hostGeoAi === "boolean")
    && (value.tviewId === undefined || value.tviewId === "main");
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
  if (request.type === "testudoSetPresentSuspended") return request.payload?.challenge === challenge && isSetPresentSuspendedPayload(request.payload);
  if (request.type === "testudoSetPanels") return request.payload?.challenge === challenge && isSetPanelsPayload(request.payload);
  if (request.type === "testudoRequestInvestigation") {
    const payload = request.payload;
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    return keys.length === 2 && keys.includes("challenge") && keys.includes("question")
      && payload.challenge === challenge && TESTUDO_CHALLENGE_RE.test(challenge)
      && typeof payload.question === "string" && payload.question.trim().length > 0 && payload.question.length <= 4000;
  }
  if (request.type === "testudoOpenAnalysis") return request.payload?.challenge === challenge && isOpenAnalysisPayload(request.payload);
  if (request.type === "testudoRefreshAnalysisGrant") return request.payload?.challenge === challenge && isRefreshAnalysisGrantPayload(request.payload);
  if (request.type === "testudoCloseAnalysis") return request.payload?.challenge === challenge && isCloseAnalysisPayload(request.payload);
  if (request.type === "testudoSetAnalysisTime") return request.payload?.challenge === challenge && isSetAnalysisTimePayload(request.payload);
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
