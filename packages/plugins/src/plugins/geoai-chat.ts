import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const GEOAI_CHAT_PLUGIN_ID = "geolibre-geoai-chat";

/** One turn in the chat transcript. */
export interface GeoAiChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
}

export interface GeoAiChatSettings {
  /** Placeholder to satisfy the shared `handlers[id].settings(...)` contract; GeoAI chat has no
   * per-package presets today. */
  visible: boolean;
}

export interface GeoAiChatStatus {
  loading: boolean;
  error: string | null;
  /** True once `checkAvailability()` has confirmed the backend AI provider is reachable. */
  available: boolean;
  messages: GeoAiChatMessage[];
}

const idleStatus: GeoAiChatStatus = { loading: false, error: null, available: false, messages: [] };
const defaultSettings: GeoAiChatSettings = { visible: false };

let status: GeoAiChatStatus = { ...idleStatus };
let settings: GeoAiChatSettings = { ...defaultSettings };
let visible = false;
let session: { origin: string; bearerToken: string; packageId: string } | null = null;
let token = 0;

const listeners = new Set<() => void>();
const panelListeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
const notifyPanel = () => panelListeners.forEach(f => f());

function endpoint(path: string): URL {
  if (!session) throw new Error("GeoAI chat is not initialized");
  return new URL(path, session.origin);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!session) throw new Error("GeoAI chat is not initialized");
  const response = await fetch(endpoint(path), {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.bearerToken}` },
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

/** Reuses the legacy `geolibre-ai-adapter.js` contract shape: `init`/`sendChat`/`checkAvailability`,
 * adapted for the native viewer's cross-origin iframe, which authenticates with the same bearer
 * token the embed protocol already carries (see `TestudoControls.tsx`'s `load()`). Guest-embed
 * sessions have no principal bearer token, so `init` is a no-op for them and the capability reports
 * unavailable — the `/api/v1/ai/chat` backend only accepts `Authorization: Bearer <principal>`. */
export function initGeoAiChat(options: { origin: string; bearerToken?: string; packageId: string }): void {
  token += 1;
  if (!options.bearerToken) {
    session = null;
    status = { ...idleStatus };
    notify();
    return;
  }
  session = { origin: options.origin, bearerToken: options.bearerToken, packageId: options.packageId };
  status = { ...idleStatus };
  notify();
}

export function isGeoAiChatConfigured(): boolean {
  return session !== null;
}

export async function checkGeoAiAvailability(): Promise<GeoAiChatStatus> {
  if (!session) {
    status = { ...idleStatus, error: "GeoAI chat requires a signed-in session." };
    notify();
    return status;
  }
  const requestToken = token;
  status = { ...status, loading: true, error: null };
  notify();
  try {
    const result = await request<{ ok: boolean; ai_available: boolean; code: string | null }>(
      `/api/v1/ai/status?package_id=${encodeURIComponent(session.packageId)}`,
      { method: "GET" },
    );
    if (requestToken !== token) return status;
    status = { ...status, loading: false, available: Boolean(result.ai_available), error: result.ai_available ? null : (result.code ?? "AI is currently unavailable.") };
  } catch (error) {
    if (requestToken !== token) return status;
    status = { ...status, loading: false, available: false, error: error instanceof Error ? error.message : String(error) };
  }
  notify();
  return status;
}

export async function sendGeoAiChat(prompt: string): Promise<GeoAiChatStatus> {
  if (!session) {
    status = { ...status, error: "GeoAI chat requires a signed-in session." };
    notify();
    return status;
  }
  const trimmed = prompt.trim();
  if (!trimmed) return status;
  const requestToken = token;
  const userMessage: GeoAiChatMessage = { id: `u-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "user", text: trimmed };
  status = { ...status, loading: true, error: null, messages: [...status.messages, userMessage] };
  notify();
  try {
    const result = await request<{ reply?: string; error?: string; code?: string }>("/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: trimmed, package_id: session.packageId }),
    });
    if (requestToken !== token) return status;
    if (result.reply) {
      const reply: GeoAiChatMessage = { id: `a-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "assistant", text: result.reply };
      status = { ...status, loading: false, messages: [...status.messages, reply] };
    } else {
      const errorMessage: GeoAiChatMessage = { id: `e-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "error", text: result.error ?? "AI is currently unavailable." };
      status = { ...status, loading: false, error: result.error ?? result.code ?? "AI is currently unavailable.", messages: [...status.messages, errorMessage] };
    }
  } catch (error) {
    if (requestToken !== token) return status;
    const message = error instanceof Error ? error.message : String(error);
    const errorMessage: GeoAiChatMessage = { id: `e-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "error", text: message };
    status = { ...status, loading: false, error: message, messages: [...status.messages, errorMessage] };
  }
  notify();
  return status;
}

/** Matches the shared `handlers[id]` dispatch contract in `TestudoControls.tsx` (open/close/load/
 * status/settings), so `geoai` slots into the same capability-selection machinery as every other
 * Testudo plugin. Unlike the data plugins, GeoAI chat has no package-file payload to load — its
 * `load()` is a no-op resolved immediately; the actual session credentials are supplied out of band
 * via `initGeoAiChat`, called by `TestudoControls.tsx` where the bearer token is in scope. */
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
