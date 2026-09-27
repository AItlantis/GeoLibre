import type { FeatureCollection } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const GEOAI_BUILDINGS_PLUGIN_ID = "geolibre-geoai-buildings";
const GEOAI_BUILDINGS_STORE_LAYER_ID = "geoai-buildings-store";
const GEOAI_BUILDINGS_SOURCE_ID = "geoai-buildings-source";
const GEOAI_BUILDINGS_FILL_LAYER_ID = "geoai-buildings-fill";
const GEOAI_BUILDINGS_LINE_LAYER_ID = "geoai-buildings-line";
/** Matches the legacy overlay's own margin above the backend's 60s upstream timeout
 * (`geoai_bridge_api.py` line 356) — see `viewer/core/geoai-overlay.js` line 36. */
const INFERENCE_TIMEOUT_MS = 65_000;

export interface GeoAiBuildingsSettings { visible: boolean; }
export interface GeoAiBuildingsStatus {
  loading: boolean;
  error: string | null;
  /** True once a successful (or attempted) fetch has run. */
  available: boolean;
  featureCount: number;
  lastFeatureCollection: FeatureCollection | null;
}

const idleStatus: GeoAiBuildingsStatus = { loading: false, error: null, available: false, featureCount: 0, lastFeatureCollection: null };
const defaultSettings: GeoAiBuildingsSettings = { visible: false };

let status: GeoAiBuildingsStatus = { ...idleStatus };
let settings: GeoAiBuildingsSettings = { ...defaultSettings };
let visible = false;
let session: { origin: string; bearerToken: string; packageId: string } | null = null;
let token = 0;

let appRef: GeoLibreAppAPI | null = null;
let mapRef: MapLibreMap | null = null;
let handleStyleData: (() => void) | null = null;

const listeners = new Set<() => void>();
const panelListeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
const notifyPanel = () => panelListeners.forEach(f => f());

function endpoint(path: string): URL {
  if (!session) throw new Error("GeoAI buildings is not initialized");
  return new URL(path, session.origin);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!session) throw new Error("GeoAI buildings is not initialized");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.bearerToken}` },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (payload && (payload.error || payload.detail)) || `GeoAI request failed (${response.status})`;
      throw new Error(message);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Guest-embed sessions have no principal bearer token, so `init` is a no-op for them and the
 * capability reports unavailable — `/api/agent/v1/geoai/infer` only accepts
 * `Authorization: Bearer <principal>`, not the `Testudo-Embed` guest scheme used for package bytes. */
export function initGeoAiBuildings(options: { origin: string; bearerToken?: string; packageId: string }): void {
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

export function isGeoAiBuildingsConfigured(): boolean {
  return session !== null;
}

function removeBuildingsLayers(map: MapLibreMap): void {
  if (map.getLayer(GEOAI_BUILDINGS_FILL_LAYER_ID)) map.removeLayer(GEOAI_BUILDINGS_FILL_LAYER_ID);
  if (map.getLayer(GEOAI_BUILDINGS_LINE_LAYER_ID)) map.removeLayer(GEOAI_BUILDINGS_LINE_LAYER_ID);
  if (map.getSource(GEOAI_BUILDINGS_SOURCE_ID)) map.removeSource(GEOAI_BUILDINGS_SOURCE_ID);
}

function syncBuildingsLayers(map: MapLibreMap): void {
  if (!map.isStyleLoaded()) return;
  const data = status.lastFeatureCollection;
  if (!data || !visible) {
    removeBuildingsLayers(map);
    return;
  }
  if (!map.getSource(GEOAI_BUILDINGS_SOURCE_ID)) map.addSource(GEOAI_BUILDINGS_SOURCE_ID, { type: "geojson", data: data as never });
  else (map.getSource(GEOAI_BUILDINGS_SOURCE_ID) as { setData?: (value: never) => void }).setData?.(data as never);
  if (!map.getLayer(GEOAI_BUILDINGS_FILL_LAYER_ID)) map.addLayer({ id: GEOAI_BUILDINGS_FILL_LAYER_ID, type: "fill", source: GEOAI_BUILDINGS_SOURCE_ID, paint: { "fill-color": "#ff8a00", "fill-opacity": 0.35 } });
  if (!map.getLayer(GEOAI_BUILDINGS_LINE_LAYER_ID)) map.addLayer({ id: GEOAI_BUILDINGS_LINE_LAYER_ID, type: "line", source: GEOAI_BUILDINGS_SOURCE_ID, paint: { "line-color": "#ff8a00", "line-width": 1.5 } });
}

function attachMap(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map || map === mapRef) return;
  detachMap();
  mapRef = map;
  handleStyleData = () => syncBuildingsLayers(map);
  map.on("styledata", handleStyleData);
  syncBuildingsLayers(map);
}

function detachMap(): void {
  if (mapRef && handleStyleData) mapRef.off("styledata", handleStyleData);
  if (mapRef) removeBuildingsLayers(mapRef);
  mapRef = null;
  handleStyleData = null;
}

function registerGeoAiBuildingsStoreLayer(): void {
  appRef?.registerExternalNativeLayer?.({
    id: GEOAI_BUILDINGS_STORE_LAYER_ID,
    name: "GeoAI Buildings",
    type: "geojson",
    nativeLayerIds: [GEOAI_BUILDINGS_FILL_LAYER_ID, GEOAI_BUILDINGS_LINE_LAYER_ID],
    paintMode: "geolibre",
    paintBridge: {
      setVisibility: next => {
        visible = next;
        settings = { ...settings, visible: next };
        if (next) { void runGeoaiBuildingsInference(appRef!); return; }
        if (mapRef) syncBuildingsLayers(mapRef);
        notify();
      },
    },
  });
}

/** Matches the shared `handlers[id]` dispatch contract in `TestudoControls.tsx` (open/close/load/
 * status/settings). `openGeoAiBuildingsPanel` never internally gates on availability — the caller
 * (`TestudoControls.tsx`'s `select()`) already throws before invoking `handlers[id].open(app)` when
 * `!capability?.available`, the same pattern `emissions-h3`'s `openEmissionsH3Panel` relies on. */
export function openGeoAiBuildingsPanel(app: GeoLibreAppAPI): void {
  appRef = app;
  visible = true;
  registerGeoAiBuildingsStoreLayer();
  attachMap(app);
  notifyPanel();
}

export function closeGeoAiBuildingsPanel(app?: GeoLibreAppAPI): void {
  visible = false;
  detachMap();
  (app ?? appRef)?.unregisterExternalNativeLayer?.(GEOAI_BUILDINGS_STORE_LAYER_ID);
  notifyPanel();
}

export const isGeoAiBuildingsPanelVisible = (): boolean => visible;
export const subscribeGeoAiBuildingsPanel = (f: () => void): (() => void) => { panelListeners.add(f); return () => panelListeners.delete(f); };

/** No availability pre-check endpoint exists for this capability (unlike `geoai-chat`'s
 * `GET /api/v1/ai/status`) — the inference call itself already degrades gracefully to
 * `available: false` on any backend problem, so `load()` is a fast no-op. */
export async function loadGeoAiBuildings(): Promise<void> {
  if (!session) throw new Error("GeoAI buildings is unavailable for this session.");
}

/** Reuses whatever GeoLibre-native's currently active basemap style/tile URL is — this may be a
 * raster imagery source or a vector style; if it is not a raster the backend will fail to open it
 * as one and the request comes back `available: false`, an acceptable, already-safe degraded path
 * (see plan section 5, Open Question 1). */
function resolveGeoaiBuildingsSource(app: GeoLibreAppAPI): string {
  return app.getActiveBasemap();
}

export async function runGeoaiBuildingsInference(app: GeoLibreAppAPI): Promise<GeoAiBuildingsStatus> {
  if (!session) {
    status = { ...status, error: "GeoAI buildings requires a signed-in session." };
    notify();
    return status;
  }
  const bounds = app.getViewBounds?.();
  if (!bounds) {
    status = { ...status, error: "The current viewport is unavailable." };
    notify();
    return status;
  }
  const requestToken = token;
  status = { ...status, loading: true, error: null };
  notify();
  try {
    const source = resolveGeoaiBuildingsSource(app);
    const result = await request<{ available: boolean; task: string; type: string; features: FeatureCollection["features"] }>(
      "/api/agent/v1/geoai/infer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "building_footprints", bbox: bounds, source }),
      },
    );
    if (requestToken !== token) return status;
    const collection: FeatureCollection = { type: "FeatureCollection", features: result.features ?? [] };
    status = {
      ...status,
      loading: false,
      available: Boolean(result.available),
      error: result.available ? null : "GeoAI building detection is currently unavailable.",
      featureCount: collection.features.length,
      lastFeatureCollection: collection,
    };
  } catch (error) {
    if (requestToken !== token) return status;
    status = { ...status, loading: false, available: false, error: error instanceof Error ? error.message : String(error) };
  }
  notify();
  if (mapRef) syncBuildingsLayers(mapRef);
  return status;
}

export function getGeoAiBuildingsStatus(): GeoAiBuildingsStatus { return status; }
export const subscribeGeoAiBuildings = (f: () => void): (() => void) => { listeners.add(f); return () => listeners.delete(f); };
export function getGeoAiBuildingsSnapshot(): GeoAiBuildingsSettings { return settings; }
export function setGeoAiBuildingsSettings(next: Partial<GeoAiBuildingsSettings>): void {
  settings = { ...settings, ...next };
  if (typeof next.visible === "boolean") visible = next.visible;
  notify();
}

export function resetGeoAiBuildings(): void {
  token += 1;
  session = null;
  status = { ...idleStatus };
  settings = { ...defaultSettings };
  visible = false;
  detachMap();
  appRef?.unregisterExternalNativeLayer?.(GEOAI_BUILDINGS_STORE_LAYER_ID);
  appRef = null;
  notify();
}

export const geoAiBuildingsPlugin: GeoLibrePlugin = {
  id: GEOAI_BUILDINGS_PLUGIN_ID,
  name: "GeoAI Buildings",
  version: "1.0.0",
  activeByDefault: false,
  activate: openGeoAiBuildingsPanel,
  deactivate: closeGeoAiBuildingsPanel,
};
