import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const GEOAI_CHAT_PLUGIN_ID = "geolibre-geoai-chat";

/** One turn in the chat transcript. */
export interface GeoAiChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  scenarioAnalysis?: Record<string, unknown>;
}

export interface GeoAiChatSettings {
  /** Placeholder to satisfy the shared `handlers[id].settings(...)` contract; GeoAI chat has no
   * per-package presets today. */
  visible: boolean;
}

export interface GeoAiChatStatus {
  loading: boolean;
  error: string | null;
  /** True when this session has a configured backend transport; model readiness is checked on chat. */
  available: boolean;
  messages: GeoAiChatMessage[];
}

export interface GeoAiViewerContext {
  surface?: "geolibre";
  mode?: "animation" | "results" | "paths" | "environment" | "comparison" | "flow" | "density";
  submode?: "animation" | "results" | "paths" | "environment" | "comparison" | "flow" | "density";
  plugin?: string;
  scenario_ids?: number[];
  active_scenario_id?: number;
  selected_section_id?: number;
  time_window?: { start: number; end: number };
  camera_bounds?: [number, number, number, number];
  map?: { available: boolean };
  package_name?: string;
}

interface PrincipalSession {
  kind: "principal";
  origin: string;
  bearerToken: string;
  packageId: string;
  packageVersionId: string;
  getViewerContext?: () => GeoAiViewerContext;
}

interface GuestSession {
  kind: "guest";
  origin: string;
  packageVersionId: string;
  getGuestEmbedToken: () => string;
  getViewerContext?: () => GeoAiViewerContext;
}

type ChatSession = PrincipalSession | GuestSession;

const idleStatus: GeoAiChatStatus = { loading: false, error: null, available: false, messages: [] };
const defaultSettings: GeoAiChatSettings = { visible: false };

let status: GeoAiChatStatus = { ...idleStatus };
let settings: GeoAiChatSettings = { ...defaultSettings };
let visible = false;
let session: ChatSession | null = null;
let token = 0;

const listeners = new Set<() => void>();
const panelListeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
const notifyPanel = () => panelListeners.forEach(f => f());

function boundedViewerContext(value: GeoAiViewerContext | undefined): GeoAiViewerContext {
  if (!value || typeof value !== "object") return {};
  const result: GeoAiViewerContext = {};
  const modes = new Set(["animation", "results", "paths", "environment", "comparison", "flow", "density"]);
  if (value.surface === "geolibre") result.surface = value.surface;
  if (typeof value.mode === "string" && modes.has(value.mode)) result.mode = value.mode as GeoAiViewerContext["mode"];
  if (typeof value.submode === "string" && modes.has(value.submode)) result.submode = value.submode as GeoAiViewerContext["submode"];
  if (typeof value.plugin === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.plugin)) result.plugin = value.plugin;
  if (Array.isArray(value.scenario_ids)) {
    const ids = [...new Set(value.scenario_ids.filter(Number.isSafeInteger))].slice(0, 16);
    if (ids.length) result.scenario_ids = ids;
  }
  if (Number.isSafeInteger(value.active_scenario_id)) result.active_scenario_id = value.active_scenario_id;
  if (Number.isSafeInteger(value.selected_section_id)) result.selected_section_id = value.selected_section_id;
  const window = value.time_window;
  if (window && Number.isFinite(window.start) && Number.isFinite(window.end) && window.start < window.end) {
    result.time_window = { start: window.start, end: window.end };
  }
  const bounds = value.camera_bounds;
  if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[0] <= 180 && bounds[2] >= -180 && bounds[2] <= 180
    && bounds[1] >= -90 && bounds[1] <= 90 && bounds[3] >= -90 && bounds[3] <= 90
    && bounds[0] <= bounds[2] && bounds[1] <= bounds[3]) {
    result.camera_bounds = [bounds[0], bounds[1], bounds[2], bounds[3]];
  }
  if (typeof value.map?.available === "boolean") result.map = { available: value.map.available };
  if (typeof value.package_name === "string") result.package_name = value.package_name.slice(0, 160);
  return result;
}

function endpoint(current: ChatSession): URL {
  const path = current.kind === "guest"
    ? "/api/public/demo/geoai-chat"
    : "/api/v1/ai/chat";
  return new URL(path, current.origin);
}

async function request<T>(current: ChatSession, body: Record<string, unknown>): Promise<T> {
  const credential = current.kind === "guest" ? current.getGuestEmbedToken() : current.bearerToken;
  const scheme = current.kind === "guest" ? "Testudo-Embed" : "Bearer";
  const response = await fetch(endpoint(current), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${scheme} ${credential}` },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload && (payload.error || payload.detail)) || `GeoAI request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

/** Configure only the Testudo-native panel transport. Credentials stay in this iframe module;
 * guest credentials are retrieved from the caller's in-memory closure per request. */
export function initGeoAiChat(options: {
  origin: string;
  bearerToken?: string;
  packageId?: string;
  packageVersionId?: string;
  guest?: { getGuestEmbedToken: () => string };
  getViewerContext?: () => GeoAiViewerContext;
}): void {
  token += 1;
  if (options.bearerToken && options.packageId && options.packageVersionId) {
    session = { kind: "principal", origin: options.origin, bearerToken: options.bearerToken, packageId: options.packageId, packageVersionId: options.packageVersionId, getViewerContext: options.getViewerContext };
  } else if (options.guest) {
    session = { kind: "guest", origin: options.origin, packageVersionId: options.packageVersionId ?? "", getGuestEmbedToken: options.guest.getGuestEmbedToken, getViewerContext: options.getViewerContext };
  } else session = null;
  status = { ...idleStatus };
  notify();
}

export function isGeoAiChatConfigured(): boolean {
  return session !== null;
}

export async function checkGeoAiAvailability(): Promise<GeoAiChatStatus> {
  if (!session) {
    status = { ...idleStatus, error: "GeoAI chat is unavailable for this session." };
    notify();
    return status;
  }
  // There is intentionally no browser-side provider probe. The authenticated
  // chat route owns Ollama and optional Ollaya availability and reports failure
  // through the response to the user's actual request.
  status = { ...status, loading: false, available: true, error: null };
  notify();
  return status;
}

export async function sendGeoAiChat(prompt: string): Promise<GeoAiChatStatus> {
  if (!session) {
    status = { ...status, error: "GeoAI chat requires a signed-in session." };
    notify();
    return status;
  }
  const trimmed = prompt.trim().slice(0, 4000);
  if (!trimmed) return status;
  const requestToken = token;
  const userMessage: GeoAiChatMessage = { id: `u-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "user", text: trimmed };
  status = { ...status, loading: true, error: null, messages: [...status.messages, userMessage] };
  notify();
  try {
    const viewerContext = boundedViewerContext(session.getViewerContext?.());
    const messages = status.messages
      .filter((message): message is GeoAiChatMessage & { role: "user" | "assistant" } => message.id !== userMessage.id && (message.role === "user" || message.role === "assistant"))
      .slice(-10)
      .map(message => ({ role: message.role, content: message.text.slice(-2000) }));
    const body = session.kind === "guest"
      ? { prompt: trimmed, messages, viewer_context: viewerContext }
      : { package_id: session.packageId, package_version_id: session.packageVersionId, prompt: trimmed, messages, viewer_context: viewerContext };
    const pathSession = session;
    const result = await request<{ reply?: string | null; error?: string; code?: string; available?: boolean; ai_available?: boolean; scenario_analysis?: Record<string, unknown>; viewer_action?: Record<string, unknown> }>(pathSession, body);
    if (requestToken !== token) return status;
    if (result.viewer_action && result.viewer_action.version_id === pathSession.packageVersionId) {
      window.dispatchEvent(new CustomEvent("testudo-scenario-analysis-action", { detail: result.viewer_action }));
    }
    if (result.reply) {
      const reply: GeoAiChatMessage = { id: `a-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "assistant", text: result.reply, scenarioAnalysis: result.scenario_analysis };
      status = { ...status, loading: false, available: result.available ?? result.ai_available ?? true, messages: [...status.messages, reply] };
    } else {
      const errorMessage: GeoAiChatMessage = { id: `e-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "error", text: result.error ?? result.code ?? "AI is currently unavailable.", scenarioAnalysis: result.scenario_analysis };
      status = { ...status, loading: false, available: Boolean(result.scenario_analysis) || (result.available ?? result.ai_available ?? false), error: result.error ?? result.code ?? null, messages: [...status.messages, errorMessage] };
    }
  } catch (error) {
    if (requestToken !== token) return status;
    const message = error instanceof Error ? error.message : String(error);
    const errorMessage: GeoAiChatMessage = { id: `e-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "error", text: message };
    status = { ...status, loading: false, available: false, error: message, messages: [...status.messages, errorMessage] };
  }
  notify();
  return status;
}

/** Matches the Testudo controls handler table. Chat has no package-file payload to load; its
 * authenticated transport is initialized inside the iframe during package load. */
export function openGeoAiChatPanel(_app?: GeoLibreAppAPI): void { visible = true; notifyPanel(); }
export function closeGeoAiChatPanel(_app?: GeoLibreAppAPI): void { visible = false; notifyPanel(); }
export const isGeoAiChatPanelVisible = (): boolean => visible;
export const subscribeGeoAiChatPanel = (f: () => void): (() => void) => { panelListeners.add(f); return () => panelListeners.delete(f); };

export async function loadGeoAiChat(): Promise<void> {
  if (!session) throw new Error("GeoAI chat is unavailable for this session.");
  await checkGeoAiAvailability();
  if (!status.available) throw new Error(status.error ?? "GeoAI is currently unavailable.");
}

export function getGeoAiChatStatus(): GeoAiChatStatus { return status; }
export const subscribeGeoAiChat = (f: () => void): (() => void) => { listeners.add(f); return () => listeners.delete(f); };
export function getGeoAiChatSnapshot(): GeoAiChatSettings { return settings; }
export function setGeoAiChatSettings(next: Partial<GeoAiChatSettings>): void { settings = { ...settings, ...next }; notify(); }

export function resetGeoAiChat(): void {
  token += 1;
  session = null;
  status = { ...idleStatus };
  settings = { ...defaultSettings };
  notify();
}

export const geoAiChatPlugin: GeoLibrePlugin = {
  id: GEOAI_CHAT_PLUGIN_ID,
  name: "GeoAI Chat",
  version: "1.0.0",
  activeByDefault: false,
  activate: openGeoAiChatPanel,
  deactivate: closeGeoAiChatPanel,
};
