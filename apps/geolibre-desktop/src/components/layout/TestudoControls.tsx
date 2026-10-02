import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import * as plugins from "@geolibre/plugins";
import type { GeoLibreAppAPI } from "@geolibre/plugins";
import type { TestudoBootstrap, TestudoCapabilityId, TestudoDemoMode, TestudoKpiGeometry, TestudoKpiGeometryState, TestudoLoadPackage, TestudoPlaybackState, TestudoRenderer, TestudoViewerState } from "@geolibre/embed";
import type { MapEngine } from "@geolibre/map";
import type { RefObject } from "react";
import { readEmbedOrigins } from "../../lib/embed-api";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage, availableTestudoModes, hasDeclaredPathIndex, validateTestudoBootstrap } from "../../lib/testudo-protocol";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";
import { listVehicleManifestScenarios } from "@geolibre/plugins";
import { RecordTourDialog } from "./RecordTourDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";

const ESRI_WORLD_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_WORLD_IMAGERY_LAYER = "Testudo Esri World Imagery";

const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"];
const modes: Array<{ id: TestudoDemoMode; label: string; plugin: TestudoCapabilityId }> = [
  { id: "animation", label: "Animation", plugin: "vehicle-playback" },
  { id: "flow", label: "Flow", plugin: "network-kpi" },
  { id: "paths", label: "Paths", plugin: "path-analysis" },
  { id: "density", label: "Density", plugin: "network-kpi" },
];
const empty: TestudoViewerState = { package: null, selectedPlugin: null, capabilities: [], availableModes: [], status: "empty" };
const handlers = {
  "vehicle-playback": { open: plugins.openVehiclePlaybackPanel, close: plugins.closeVehiclePlaybackPanel, load: plugins.loadLocalVehiclePlaybackFolder, status: plugins.getVehiclePlaybackStatus, settings: plugins.setVehiclePlaybackSettings },
  "network-kpi": { open: plugins.openNetworkKpiPanel, close: plugins.closeNetworkKpiPanel, load: plugins.loadLocalNetworkKpiFolder, status: plugins.getNetworkKpiStatus, settings: plugins.setNetworkKpiSettings },
  "path-analysis": { open: plugins.openPathAnalysisPanel, close: plugins.closePathAnalysisPanel, load: plugins.loadLocalPathAnalysisFolder, status: plugins.getPathAnalysisSnapshot, settings: plugins.setPathAnalysisSettings },
  "emissions-h3": { open: plugins.openEmissionsH3Panel, close: plugins.closeEmissionsH3Panel, load: plugins.loadLocalEmissionsH3Folder, status: plugins.getEmissionsH3Status, settings: plugins.setEmissionsH3Settings },
  "scenario-comparison": { open: plugins.openScenarioComparisonPanel, close: plugins.closeScenarioComparisonPanel, load: plugins.loadLocalScenarioComparisonFolder, status: plugins.getScenarioComparisonStatus, settings: plugins.setScenarioComparisonSettings },
};

/** Curated native runtime. The host owns navigation; these plugins own their map layers. */
export function TestudoControls({ app, mapControllerRef }: { app: GeoLibreAppAPI | null; mapControllerRef: RefObject<MapEngine | null> }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TestudoViewerState>(empty);
  const [recordTourOpen, setRecordTourOpen] = useState(false);
  const [recordVideoOpen, setRecordVideoOpen] = useState(false);
  const picker = useRef<((directory: VehicleDirectoryHandle) => Promise<void>) | null>(null);
  const modeSelector = useRef<((mode: TestudoDemoMode) => Promise<TestudoViewerState>) | null>(null);
  useEffect(() => {
    if (!app) return;
    const origin = window.location.origin;
    const allowed = readEmbedOrigins().filter(value => value !== "*");
    if (window.parent === window) return;
    const challenge = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
    let parentOrigin: string | null = null;
    let guestCredential: { token: string; expiresAt: number } | null = null;
    let current = empty;
    let directory: VehicleDirectoryHandle | null = null;
    let bootstrap: TestudoBootstrap | null = null;
    let abort = new AbortController();
    let disposed = false;
    let generation = 0;
    let selectionGeneration = 0;
    let busy = false;
    let previousCesiumBasemap: import("@geolibre/core").CesiumBasemapId | undefined;
    let playbackSyncTimer: ReturnType<typeof setTimeout> | undefined;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const emit = (type: string, payload: unknown, target = parentOrigin) => {
      if (!disposed && target && allowed.includes(target)) window.parent.postMessage({ v: 2, source: "geolibre", type, payload }, target);
    };
    const ready = () => { if (!disposed) window.parent.postMessage({ v: 2, source: "geolibre", type: "ready", payload: { version: "testudo-v1", challenge } }, "*"); };
    const update = (patch: Partial<TestudoViewerState>) => {
      current = { ...current, ...patch };
      if (!disposed) setState(current);
      emit("testudoStateChanged", current);
      return current;
    };
    const getPlaybackState = (): TestudoPlaybackState => {
      const selected = current.selectedPlugin === "vehicle-playback";
      const playback = plugins.getVehiclePlaybackSettings();
      const status = plugins.getVehiclePlaybackStatus();
      return {
        available: selected && current.status === "ready",
        loading: selected && (current.status === "loading" || status.loading),
        playing: selected && playback.playing,
        tick: playback.tick,
        maxTick: status.maxTick,
        speed: playback.speed,
        dt: status.dt,
        loop: playback.loop,
      };
    };
    const publishPlaybackState = () => emit("testudoPlaybackChanged", getPlaybackState());
    const onPlaybackStateChange = () => {
      if (current.selectedPlugin !== "vehicle-playback") return;
      if (!plugins.getVehiclePlaybackSettings().playing) {
        if (playbackSyncTimer) clearTimeout(playbackSyncTimer);
        playbackSyncTimer = undefined;
        publishPlaybackState();
        return;
      }
      if (!playbackSyncTimer) {
        publishPlaybackState();
        playbackSyncTimer = setTimeout(() => {
          playbackSyncTimer = undefined;
          if (current.selectedPlugin === "vehicle-playback") publishPlaybackState();
        }, 100);
      }
    };
    const close = () => { for (const id of ids) handlers[id].close(); };
    const select = async (id: TestudoCapabilityId) => {
      if (!ids.includes(id)) throw new Error("Unknown viewer plugin");
      const capability = current.capabilities.find(item => item.id === id);
      if (!capability?.available) throw new Error(capability?.reason ?? "This plugin is unavailable for this package.");
      if (!directory) throw new Error("Select a package first.");
      const version = generation;
      const selection = ++selectionGeneration;
      close();
      update({ selectedPlugin: id, status: "loading", error: undefined, progress: undefined });
      publishPlaybackState();
      handlers[id].open(app);
      const stopProgress = id === "vehicle-playback"
        ? plugins.subscribeVehiclePlaybackStatus(() => {
            const status = plugins.getVehiclePlaybackStatus();
            if (status.loading) update({ progress: {
              label: "Loading playback chunks",
              value: status.loadedFraction,
              loaded: status.loadedChunks,
              total: status.totalChunks,
            } });
          })
        : undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const loading = handlers[id].load(directory);
      // A slow but successful idempotent data load may complete after the UI
      // deadline. Its state event must clear the stale timeout in the host.
      void loading.then(() => {
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection) return;
        const status = handlers[id].status();
        update(status.error ? { status: "error", error: status.error, progress: undefined } : { status: "ready", error: undefined, progress: undefined });
      }, error => {
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection) return;
        update({ status: "error", error: error instanceof Error ? error.message : String(error), progress: undefined });
      });
      try {
        await Promise.race([
          loading,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              reject(new Error("Viewer data did not load within 90 seconds. Check the package data and retry."));
            }, 90_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        stopProgress?.();
      }
      if (disposed || generation !== version) throw new Error("Package selection changed");
      const status = handlers[id].status();
      if (status.error) throw new Error(status.error);
      const result = update({ status: "ready", progress: undefined });
      publishPlaybackState();
      return result;
    };
    const selectMode = async (mode: TestudoDemoMode) => {
      if (!current.availableModes.includes(mode)) throw new Error("This mode is not available in this package.");
      const target = modes.find(item => item.id === mode)!;
      const result = await select(target.plugin);
      if (mode === "flow" || mode === "density") handlers["network-kpi"].settings({ metric: mode });
      return update({ ...result, selectedMode: mode });
    };
    modeSelector.current = async mode => {
      if (busy) return current;
      busy = true;
      try { return await selectMode(mode); }
      finally { busy = false; }
    };
    const applyPreset = async (id: string) => {
      const preset = bootstrap?.presets.find(item => item.id === id);
      if (!preset) throw new Error("Unknown package preset");
      await select(preset.plugin);
      // Presets are data only; prevent URLs/source/authorization from entering plugin settings.
      const safe: Record<string, string | number | boolean> = {};
      const keys = new Set(["metric", "opacity", "extruded", "maxHeightM", "seeThroughBuildings", "speed", "loop", "resolution", "labelSize", "visible"]);
      for (const [key, value] of Object.entries(preset.settings ?? {})) {
        if (!keys.has(key) || !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Invalid package preset option");
        safe[key] = value;
      }
      handlers[preset.plugin].settings(safe);
      if (preset.view) app.getMap?.()?.flyTo(preset.view);
      return update({ presetId: id });
    };
    const setLegendVisibility = (visible: boolean) => {
      const { legend, setLegend } = useAppStore.getState();
      setLegend({ ...legend, panelVisible: visible });
      return { visible };
    };
    const setEsriWorldImagery = (visible: boolean) => {
      const store = useAppStore.getState();
      if ((visible && store.primaryRenderer === "cesium") || (!visible && previousCesiumBasemap !== undefined)) {
        if (visible) {
          previousCesiumBasemap ??= store.preferences.map.cesiumBasemap ?? "project";
          store.setPreferences({ ...store.preferences, map: { ...store.preferences.map, cesiumBasemap: "esri-imagery" } });
        } else {
          store.setPreferences({ ...store.preferences, map: { ...store.preferences.map, cesiumBasemap: previousCesiumBasemap ?? "project" } });
          previousCesiumBasemap = undefined;
        }
        return { visible };
      }
      const existing = store.layers.find(layer => layer.name === ESRI_WORLD_IMAGERY_LAYER);
      if (visible && !existing) {
        if (!app.addTileLayer) throw new Error("This GeoLibre build cannot add tile layers.");
        app.addTileLayer(ESRI_WORLD_IMAGERY_LAYER, ESRI_WORLD_IMAGERY, {
          attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>',
          visible: true,
        });
      } else if (!visible && existing) {
        store.removeLayer(existing.id);
      }
      return { visible };
    };
    const getKpiGeometryState = (): TestudoKpiGeometryState => {
      const settings = plugins.getNetworkKpiSettings();
      return { showLanes: settings.showLanes, showSections: settings.showSections };
    };
    const applyKpiGeometry = (geometry: TestudoKpiGeometry, visible: boolean) => {
      if (current.selectedPlugin !== "network-kpi") throw new Error("Select Flow or Density before choosing lanes or sections.");
      plugins.setNetworkKpiSettings(geometry === "lanes" ? { showLanes: visible } : { showSections: visible });
      return getKpiGeometryState();
    };
    const setPlaybackPlaying = (playing: boolean) => {
      if (current.selectedPlugin !== "vehicle-playback" || current.status !== "ready") throw new Error("Load the Animation mode before using playback controls.");
      if (plugins.getVehiclePlaybackSettings().playing !== playing) plugins.toggleVehiclePlaybackPlaying();
      return getPlaybackState();
    };
    const restartPlayback = () => {
      if (current.selectedPlugin !== "vehicle-playback" || current.status !== "ready") throw new Error("Load the Animation mode before using playback controls.");
      plugins.setVehiclePlaybackSettings({ playing: false, tick: 0 });
      return getPlaybackState();
    };
    const seekPlayback = (tick: number) => {
      if (current.selectedPlugin !== "vehicle-playback" || current.status !== "ready") throw new Error("Load the Animation mode before using playback controls.");
      plugins.setVehiclePlaybackTick(tick);
      return getPlaybackState();
    };
    const setPlaybackSpeed = (speed: number) => {
      if (current.selectedPlugin !== "vehicle-playback" || current.status !== "ready") throw new Error("Load the Animation mode before using playback controls.");
      plugins.setVehiclePlaybackSettings({ speed });
      return getPlaybackState();
    };
    const applyRenderer = (next: TestudoRenderer) => {
      useAppStore.getState().setPrimaryRenderer(next);
      return { renderer: next };
    };
    const openAnnotations = async () => {
      if (!app.activatePlugin) throw new Error("Annotation controls are unavailable in this GeoLibre build.");
      const active = await app.activatePlugin(plugins.ANNOTATIONS_PLUGIN_ID);
      if (!active) throw new Error("The annotation plugin could not be activated for this renderer.");
      return { active: true };
    };
    const reset = () => {
      generation++;
      selectionGeneration++;
      abort.abort(); abort = new AbortController();
      close(); directory = null; bootstrap = null;
      update({ ...empty });
      publishPlaybackState();
    };
    const load = async (payload: TestudoLoadPackage) => {
      const candidate = payload?.bootstrap && validateTestudoBootstrap(payload.bootstrap, !!guestCredential);
      if (!candidate || (!payload.transport?.bearerToken && !guestCredential) || (payload.transport?.bearerToken && guestCredential)
        || (guestCredential && payload.challenge !== challenge)) throw new Error("Invalid Testudo package bootstrap");
      reset(); bootstrap = candidate;
      const byteOrigins = (readDeploymentEnvValue("VITE_TESTUDO_BYTE_ORIGINS") ?? "").split(/[\s,]+/).filter(Boolean).map(value => new URL(value).origin);
      if (!byteOrigins.length) throw new Error("Package byte origin is not configured");
      const source = createSignedPackageSource({ origin, artifactEndpoint: candidate.artifactEndpoint,
        ...(guestCredential ? { getGuestEmbedToken: () => {
          if (!guestCredential || guestCredential.expiresAt <= Date.now()) throw new Error("Guest demo access expired; refresh the package to continue.");
          return guestCredential.token;
        } } : { bearerToken: payload.transport!.bearerToken }), byteOrigins, signal: abort.signal });
      directory = sourceDirectory(source, candidate.label);
      update({ package: { packageId: candidate.packageId, versionId: candidate.versionId, label: candidate.label, origin: "published" }, capabilities: candidate.capabilities, status: "loading" });
      const raw = await readLocalNetworkKpiManifestJson(directory);
      const pkg = getGeolibrePackage(raw);
      const hasAnimation = listVehicleManifestScenarios(raw, { includeAnimationVariants: true }).length > 0;
      const root = raw as Record<string, unknown>;
      const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
      const contracts = pkg?.dataContracts ?? {};
      const knownColumns = Object.values(contracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
      const hasMetric = (metric: "flow" | "density") => Object.hasOwn(ramps, metric) || knownColumns.some(column => column === metric);
      const availableModes = availableTestudoModes({
        animation: candidate.capabilities.some(item => item.id === "vehicle-playback" && item.available) && hasAnimation,
        flow: candidate.capabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("flow"),
        density: candidate.capabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("density"),
        paths: candidate.capabilities.some(item => item.id === "path-analysis" && item.available)
          && (hasDeclaredPathIndex(root.path_index) || hasDeclaredPathIndex(root.path_indices)),
      });
      update({ availableModes });
      const initialMode = availableModes.includes("animation") ? "animation" : availableModes[0];
      const initialPlugin = payload.selectedPlugin ?? (initialMode ? modes.find(item => item.id === initialMode)!.plugin : undefined);
      if (!initialPlugin) throw new Error("This package has no supported viewer data");
      if (initialMode && !payload.selectedPlugin) await selectMode(initialMode);
      else await select(initialPlugin);
      if (payload.presetId) await applyPreset(payload.presetId);
      return current;
    };
    picker.current = async selected => {
      if (busy) return;
      busy = true;
      try {
        // Validate before discarding the previous selection; cancellation never enters this function.
        const raw = await readLocalNetworkKpiManifestJson(selected);
        const pkg = getGeolibrePackage(raw);
        if (!pkg) throw new Error("Choose a built Testudo package containing manifest.json and geolibre/package.json. Raw models must be built first.");
        reset(); directory = selected;
        const aliases: Record<TestudoCapabilityId, string> = { "vehicle-playback": "animation", "network-kpi": "results", "path-analysis": "paths", "emissions-h3": "results", "scenario-comparison": "results" };
        const emissions = pkg.dataContracts.emissions as { status?: string } | undefined;
        const comparisonCount = pkg.scenarios.reduce((count, scenario) => count + Math.max(1, scenario.replications.length), 0);
        const capabilities = ids.map(id => ({ id, available: pkg.capabilities[aliases[id]]?.state === "available"
          && (id !== "emissions-h3" || emissions?.status === "available")
          && (id !== "scenario-comparison" || comparisonCount > 1), reason: id === "emissions-h3"
            ? "No usable emissions data is declared for this package." : pkg.capabilities[aliases[id]]?.reason ?? "No compatible dataset declared." }));
        const root = raw as Record<string, unknown>;
        const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
        const knownColumns = Object.values(pkg.dataContracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
        const availableModes = availableTestudoModes({
          animation: capabilities.some(item => item.id === "vehicle-playback" && item.available) && listVehicleManifestScenarios(raw, { includeAnimationVariants: true }).length > 0,
          flow: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "flow") || knownColumns.includes("flow")),
          density: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "density") || knownColumns.includes("density")),
          paths: capabilities.some(item => item.id === "path-analysis" && item.available) && (hasDeclaredPathIndex(root.path_index) || hasDeclaredPathIndex(root.path_indices)),
        });
        update({ package: { packageId: crypto.randomUUID(), versionId: null, label: selected.name, origin: "local" }, capabilities, availableModes, status: "loading" });
        const initial = availableModes[0];
        if (!initial) throw new Error("This folder declares no supported viewer datasets");
        await selectMode(initial);
      } catch (error) { update({ status: "error", error: error instanceof Error ? error.message : String(error) }); }
      finally { busy = false; }
    };
    const message = (event: MessageEvent) => {
      if (!acceptsTestudoMessage(event, window.parent, allowed, challenge)) return;
      clearInterval(readyTimer);
      const request = event.data;
      parentOrigin = event.origin;
      if (request.type === "testudoSetGuestCapability") {
        guestCredential = { token: request.payload.guestEmbedToken, expiresAt: request.payload.expiresAt };
        emit("ack", { requestId: request.requestId, ok: true, result: { protocol: 1, challenge, expiresAt: guestCredential.expiresAt } });
        return;
      }
      const run = async () => {
        if (request.type === "testudoGetState") return current;
        if (request.type === "testudoGetPlaybackState") return getPlaybackState();
        if (request.type === "testudoGetKpiGeometryState") return getKpiGeometryState();
        if (busy) throw new Error("The viewer is loading a package. Please wait.");
        if (request.type === "testudoSetLegendVisibility") return setLegendVisibility(request.payload.visible);
        if (request.type === "testudoSetEsriWorldImagery") return setEsriWorldImagery(request.payload.visible);
        if (request.type === "testudoSetKpiGeometry") return applyKpiGeometry(request.payload.geometry, request.payload.visible);
        if (request.type === "testudoSetRenderer") return applyRenderer(request.payload.renderer);
        if (request.type === "testudoSetPlaybackPlaying") return setPlaybackPlaying(request.payload.playing);
        if (request.type === "testudoRestartPlayback") return restartPlayback();
        if (request.type === "testudoSeekPlayback") return seekPlayback(request.payload.tick);
        if (request.type === "testudoSetPlaybackSpeed") return setPlaybackSpeed(request.payload.speed);
        if (request.type === "testudoOpenAnnotations") return await openAnnotations();
        if (request.type === "testudoOpenRecordTour") { setRecordTourOpen(true); return { opened: true as const }; }
        if (request.type === "testudoOpenRecordVideo") { setRecordVideoOpen(true); return { opened: true as const }; }
        busy = true;
        try {
          if (request.type === "testudoLoadPackage") return await load(request.payload);
          if (request.type === "testudoSetPlugin") return await select(request.payload?.id);
          if (request.type === "testudoSetMode") return await selectMode(request.payload.mode);
          return await applyPreset(request.payload?.id);
        } finally { busy = false; }
      };
      void run().then(result => emit("ack", { requestId: request.requestId, ok: true, result }), error => {
        const detail = error instanceof Error ? error.message : String(error);
        update({ status: "error", error: detail });
        emit("ack", { requestId: request.requestId, ok: false, error: detail });
      });
    };
    window.addEventListener("message", message);
    const unsubscribePlayback = plugins.subscribeVehiclePlayback(onPlaybackStateChange);
    document.title = "Testudo";
    ready();
    // The host can import the client after iframe load. Repeat readiness until
    // its first command so that ordering cannot strand a healthy map.
    readyTimer = setInterval(ready, 500);
    const readyStop = setTimeout(() => clearInterval(readyTimer), 60_000);
    return () => { disposed = true; generation++; guestCredential = null; parentOrigin = null; clearInterval(readyTimer); clearTimeout(readyStop); if (playbackSyncTimer) clearTimeout(playbackSyncTimer); unsubscribePlayback(); abort.abort(); picker.current = null; modeSelector.current = null; window.removeEventListener("message", message); close(); };
  }, [app]);

  return <>
  <div className="absolute end-3 top-3 z-40 max-w-xs rounded-md border border-border bg-background p-3 shadow-lg" data-testudo-controls>
    {state.package?.origin !== "published" && <button className="rounded border px-3 py-2 text-sm" disabled={state.status === "loading"} onClick={() => {
      const pick = (window as unknown as { showDirectoryPicker?: () => Promise<VehicleDirectoryHandle> }).showDirectoryPicker;
      if (!pick) { setState(current => ({ ...current, status: "error", error: t("testudo.folderUnsupported") })); return; }
      void pick().then(directory => picker.current?.(directory)).catch(error => { if (error?.name !== "AbortError") setState(current => ({ ...current, status: "error", error: String(error) })); });
    }}>{t("testudo.openLocal")}</button>}
    {state.package && <div role="group" aria-label="Demo modes" className="mt-2 flex flex-wrap gap-1">{modes.map(mode => <button key={mode.id} type="button" className={`rounded border px-2 py-1 text-xs ${state.selectedMode === mode.id ? "bg-primary text-primary-foreground" : ""}`} aria-pressed={state.selectedMode === mode.id} disabled={state.status === "loading" || !state.availableModes.includes(mode.id)} title={state.availableModes.includes(mode.id) ? mode.label : `${mode.label} is not declared by this package`} onClick={() => { void modeSelector.current?.(mode.id).catch(error => setState(current => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }))); }}>{mode.label}</button>)}</div>}
    {state.status === "loading" && <p role="status" className="text-sm">{t("testudo.loading")}</p>}
    {state.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
  </div>
  <RecordTourDialog open={recordTourOpen} onOpenChange={setRecordTourOpen} mapControllerRef={mapControllerRef} />
  <RecordVideoDialog open={recordVideoOpen} onOpenChange={setRecordVideoOpen} mapControllerRef={mapControllerRef} />
  </>;
}
