import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as plugins from "@geolibre/plugins";
import type { GeoAiViewerContext, GeoLibreAppAPI, TestudoCameraView, TestudoFeatureSession } from "@geolibre/plugins";
import type { TestudoBootstrap, TestudoCapabilityId, TestudoSelectablePluginId, TestudoDemoMode, TestudoLoadPackage, TestudoViewerState } from "@geolibre/embed";
import { containsCredentialField, parseTestudoArtifactResponse, readEmbedOrigins } from "../../lib/embed-api";
import { parentOriginHintFromBrowser, pickBroadcastTargets } from "../../hooks/embedHost";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createParentProxiedPackageSource, createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage, availableTestudoModes, hasDeclaredPathIndex, validateScenarioAnalysisAction, validateTestudoBootstrap } from "../../lib/testudo-protocol";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";
import { listVehicleManifestScenarios } from "@geolibre/plugins";
import { summarizeGeoAiInvestigation } from "../../lib/testudo-investigation";
import { openLocalPackageFromActivation } from "../../lib/testudo-picker-flow";
import { pluginForTestudoMode, validateTestudoStyle } from "../../lib/testudo-view-style";

/** Exported so tests can assert every Testudo capability is actually wired here (see #273: GeoAI
 * chat previously existed only in the legacy viewer, with zero entry in this list). */
export const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai", "geoai-buildings"];
const featureCapabilityIds: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"];
const selectableIds = ids.filter((id): id is TestudoSelectablePluginId => id !== "geoai");
const modes: Array<{ id: TestudoDemoMode; label: string; plugin: TestudoSelectablePluginId }> = [
  { id: "animation", label: "Animation", plugin: "vehicle-playback" },
  { id: "flow", label: "Flow", plugin: "network-kpi" },
  { id: "paths", label: "Paths", plugin: "path-analysis" },
  { id: "density", label: "Density", plugin: "network-kpi" },
];
const empty: TestudoViewerState = { package: null, selectedPlugin: null, assistantOpen: false, capabilities: [], availableModes: [], status: "empty" };
type LocalPackagePickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<VehicleDirectoryHandle>;
};
function isBoundedDisplayObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 16_000 && !/"(?:authorization|token|credential|password|secret)"\s*:/i.test(encoded);
  } catch { return false; }
}
function isDisplayOnlyAction(value: unknown): value is { type: string; label: string; value?: unknown; controlId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.label !== "string" || !action.label.trim() || action.label.length > 80) return false;
  if (action.type === "plugin") return ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"].includes(String(action.value));
  if (action.type === "scenario") return typeof action.value === "string" && action.value.length <= 120;
  if (action.type === "seek") return typeof action.value === "number" && Number.isFinite(action.value) && action.value >= 0 && action.value <= 1_000_000;
  if (action.type === "mapControl") return ["legend", "esri-world-imagery"].includes(String(action.controlId)) && typeof action.value === "boolean";
  if (action.type === "camera") {
    if (!action.value || typeof action.value !== "object" || Array.isArray(action.value)) return false;
    const camera = action.value as Record<string, unknown>;
    return Array.isArray(camera.center) && camera.center.length === 2
      && camera.center.every((number, index) => typeof number === "number" && Number.isFinite(number)
        && (index === 0 ? number >= -180 && number <= 180 : number >= -90 && number <= 90))
      && typeof camera.zoom === "number" && Number.isFinite(camera.zoom) && camera.zoom >= 0 && camera.zoom <= 24
      && (camera.bearing === undefined || typeof camera.bearing === "number" && Number.isFinite(camera.bearing))
      && (camera.pitch === undefined || typeof camera.pitch === "number" && Number.isFinite(camera.pitch) && camera.pitch >= 0 && camera.pitch <= 85);
  }
  return false;
}
const handlers = {
  "vehicle-playback": { open: plugins.openVehiclePlaybackPanel, close: plugins.closeVehiclePlaybackPanel, load: plugins.loadLocalVehiclePlaybackFolder, status: plugins.getVehiclePlaybackStatus, settings: plugins.setVehiclePlaybackSettings },
  "network-kpi": { open: plugins.openNetworkKpiPanel, close: plugins.closeNetworkKpiPanel, load: plugins.loadLocalNetworkKpiFolder, status: plugins.getNetworkKpiStatus, settings: plugins.setNetworkKpiSettings },
  "path-analysis": { open: plugins.openPathAnalysisPanel, close: plugins.closePathAnalysisPanel, load: plugins.loadLocalPathAnalysisFolder, status: plugins.getPathAnalysisSnapshot, settings: plugins.setPathAnalysisSettings },
  "emissions-h3": { open: plugins.openEmissionsH3Panel, close: plugins.closeEmissionsH3Panel, load: plugins.loadLocalEmissionsH3Folder, status: plugins.getEmissionsH3Status, settings: plugins.setEmissionsH3Settings },
  "scenario-comparison": { open: plugins.openScenarioComparisonPanel, close: plugins.closeScenarioComparisonPanel, load: plugins.loadLocalScenarioComparisonFolder, status: plugins.getScenarioComparisonStatus, settings: plugins.setScenarioComparisonSettings },
  "geoai": { open: plugins.openGeoAiChatPanel, close: plugins.closeGeoAiChatPanel, load: plugins.loadGeoAiChat, status: plugins.getGeoAiChatStatus, settings: plugins.setGeoAiChatSettings },
  "geoai-buildings": { open: plugins.openGeoAiBuildingsPanel, close: plugins.closeGeoAiBuildingsPanel, load: plugins.loadGeoAiBuildings, status: plugins.getGeoAiBuildingsStatus, settings: plugins.setGeoAiBuildingsSettings },
};

/** Curated native runtime. The host owns navigation; these plugins own their map layers. */
export function TestudoControls({ app }: { app: GeoLibreAppAPI | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TestudoViewerState>(empty);
  const [localPickerRequest, setLocalPickerRequest] = useState<string | null>(null);
  const localPickerRequestRef = useRef<string | null>(null);
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
    let declaredScenarioIds: Array<string | number> = [];
    let abort = new AbortController();
    let disposed = false;
    let generation = 0;
    let selectionGeneration = 0;
    let busy = false;
    let investigationBusy = false;
    let bridgeInstalled = false;
    let bridgePluginId: TestudoSelectablePluginId | null = null;
    const persistentNetwork = new plugins.TestudoPersistentNetwork();
    let comparisonDeclared = false;
    const scenarioAdapters = plugins.createScenarioSelectionAdapters({ setNetworkKpiScenario: plugins.setNetworkKpiScenario,
      setVehiclePlaybackScenario: plugins.setVehiclePlaybackScenario, setScenarioComparisonSettings: plugins.setScenarioComparisonSettings });
    let openingLocalPicker = false;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const featureBridge = new plugins.TestudoFeatureBridge((packageBootstrap) => ({
      open: async (_bootstrap, context) => {
        bridgePluginId = context.pluginId as TestudoSelectablePluginId | null;
        const isCurrent = (tviewId: string, expectedGeneration: number) => tviewId === "main" && featureBridge.sessions.isCurrent({ tviewId, generation: expectedGeneration });
        const vehiclePlayback = plugins.createVehiclePlaybackAdapter({ getStatus: plugins.getVehiclePlaybackStatus, getSettings: plugins.getVehiclePlaybackSnapshot,
          setTick: plugins.setVehiclePlaybackTick, setSettings: plugins.setVehiclePlaybackSettings, setScenario: plugins.setVehiclePlaybackScenario,
          subscribe: plugins.subscribeVehiclePlaybackStatus }, isCurrent, context);
        const kpiPlayback = plugins.createNetworkKpiPlaybackAdapter({ getStatus: () => { const status = plugins.getNetworkKpiStatus(); return { loading: status.loading, intervals: status.intervals, error: status.error, dt: status.timeline?.intervalDurationSeconds }; }, getSettings: plugins.getNetworkKpiSnapshot,
          setSettings: plugins.setNetworkKpiSettings, stepNetworkKpiInterval: plugins.stepNetworkKpiInterval, setScenario: plugins.setNetworkKpiScenario,
          subscribe: plugins.subscribeNetworkKpiStatus }, isCurrent, context);
        const emissionsPlayback = plugins.createNetworkKpiPlaybackAdapter({
          getStatus: () => { const status = plugins.getEmissionsH3Status(); return { loading: status.loading, intervals: status.intervals, error: status.error, dt: status.timeline?.intervalDurationSeconds }; },
          getSettings: () => { const settings = plugins.getEmissionsH3Snapshot(); return { interval: settings.interval, intervalPlaying: settings.intervalPlaying, playbackSpeed: settings.playbackSpeed, loop: settings.loop }; },
          setSettings: plugins.setEmissionsH3Settings, stepNetworkKpiInterval: plugins.stepEmissionsH3Interval,
          setScenario: plugins.setEmissionsH3Scenario, subscribe: plugins.subscribeEmissionsH3Status,
        }, isCurrent, context);
        const pathPlayback = plugins.createNetworkKpiPlaybackAdapter({
          getStatus: () => { const snapshot = plugins.getPathAnalysisSnapshot(); return { loading: snapshot.loading, intervals: snapshot.intervals, error: snapshot.error }; },
          getSettings: () => { const settings = plugins.getPathAnalysisSnapshot().settings; return { interval: settings.interval, intervalPlaying: settings.intervalPlaying, playbackSpeed: settings.playbackSpeed, loop: settings.loop }; },
          setSettings: plugins.setPathAnalysisSettings, stepNetworkKpiInterval: plugins.stepPathAnalysisInterval,
          subscribe: plugins.subscribePathAnalysis,
        }, isCurrent, context);
        const comparisonPlayback = plugins.createScenarioComparisonPlaybackAdapter({ getStatus: () => { const status = plugins.getScenarioComparisonStatus(); return { loading: status.loading, intervals: status.intervals, error: status.error, matchedIntervals: status.matchedIntervals, dt: status.timelineA?.intervalDurationSeconds }; }, getSettings: plugins.getScenarioComparisonSnapshot,
          setSettings: plugins.setScenarioComparisonSettings, stepScenarioComparisonInterval: plugins.stepScenarioComparisonInterval,
          subscribe: plugins.subscribeScenarioComparisonStatus }, isCurrent, context);
        const playback: NonNullable<TestudoFeatureSession["playback"]> = {
          getPlaybackState: (id, gen) => activePlayback().getPlaybackState(id, gen), play: (id, gen) => activePlayback().play(id, gen),
          pause: (id, gen) => activePlayback().pause(id, gen), restart: (id, gen) => activePlayback().restart(id, gen),
          seek: (id, gen, tick) => activePlayback().seek(id, gen, tick), setSpeed: (id, gen, speed) => activePlayback().setSpeed(id, gen, speed),
          subscribe: listener => {
            const subscriptions = [
              vehiclePlayback.subscribe?.((id, gen, state) => { if (bridgePluginId === "vehicle-playback") listener(id, gen, state); }),
              kpiPlayback.subscribe?.((id, gen, state) => { if (bridgePluginId === "network-kpi") listener(id, gen, state); }),
              emissionsPlayback.subscribe?.((id, gen, state) => { if (bridgePluginId === "emissions-h3") listener(id, gen, state); }),
              pathPlayback.subscribe?.((id, gen, state) => { if (bridgePluginId === "path-analysis") listener(id, gen, state); }),
              comparisonPlayback.subscribe?.((id, gen, state) => { if (bridgePluginId === "scenario-comparison") listener(id, gen, state); }),
            ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
            return () => subscriptions.forEach(unsubscribe => unsubscribe());
          },
        };
        function activePlayback() {
          return bridgePluginId === "vehicle-playback" ? vehiclePlayback : bridgePluginId === "scenario-comparison" ? comparisonPlayback
            : bridgePluginId === "emissions-h3" ? emissionsPlayback : bridgePluginId === "path-analysis" ? pathPlayback : kpiPlayback;
        }
        const scenarios = () => {
          if (bridgePluginId === "vehicle-playback") return plugins.getVehiclePlaybackStatus().scenarios.flatMap(row => row.scid === undefined || row.scid === null ? [] : [{ id: String(row.scid), label: String(row.label ?? row.scid) }]);
          if (bridgePluginId === "scenario-comparison") return plugins.getScenarioComparisonStatus().scenarios.flatMap(row => row.scid === undefined || row.scid === null ? [] : [{ id: String(row.scid), label: String(row.label ?? row.scid) }]);
          if (bridgePluginId === "emissions-h3") return plugins.getEmissionsH3Status().scenarios.map(row => ({ id: String(row.id), label: row.label }));
          if (bridgePluginId === "path-analysis") return declaredScenarioIds.map(id => ({ id: String(id), label: `Scenario ${id}` }));
          return plugins.getNetworkKpiStatus().scenarios.flatMap(row => row.scid === undefined || row.scid === null ? [] : [{ id: String(row.scid), label: String(row.label ?? row.scid) }]);
        };
        const capabilities = (packageBootstrap.capabilities ?? []).filter(item => ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"].includes(item.id));
        const session: TestudoFeatureSession = {
          context, capabilities, availableModes: current.availableModes as TestudoFeatureSession["availableModes"], selectedMode: current.selectedMode as TestudoFeatureSession["selectedMode"],
          scenarios: scenarios(), playback,
          selectPlugin: async id => { bridgePluginId = id as TestudoSelectablePluginId; return id; },
          applyPreset: id => id,
          selectScenario: async id => {
            const index = scenarios().findIndex(row => row.id === id);
            if (index < 0) throw new Error(`Scenario ${id} is unavailable for ${bridgePluginId}.`);
            if (bridgePluginId === "vehicle-playback") await scenarioAdapters.vehiclePlayback(index);
            else if (bridgePluginId === "scenario-comparison") {
              const prior = plugins.getScenarioComparisonSnapshot();
              scenarioAdapters.comparison(index, prior.scenarioB);
            } else if (bridgePluginId === "emissions-h3") await plugins.setEmissionsH3Scenario(index);
            else if (bridgePluginId === "path-analysis") await plugins.setPathAnalysisScenario(id);
            else await scenarioAdapters.networkKpi(index);
            return id;
          },
          setViewMode: mode => mode,
          getCameraView: () => {
            const center = app.getMap?.()?.getCenter?.(); const activeMap = app.getMap?.();
            if (!center || !activeMap) return null;
            return { center: [center.lng, center.lat], zoom: activeMap.getZoom?.() ?? 0, bearing: activeMap.getBearing?.() ?? 0, pitch: activeMap.getPitch?.() ?? 0 };
          },
          setCameraView: view => { app.getMap?.()?.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing ?? 0, pitch: view.pitch ?? 0 }); },
          dispose: () => { bridgePluginId = null; },
        };
        return session;
      },
    }), (request, signal) => requestArtifactFromParent(request, signal));
    featureBridge.setMapResolver(() => app.getMap?.() as any ?? null);
    featureBridge.createTView("main");
    featureBridge.setActiveTView("main");
    const emit = (type: string, payload: unknown, target = parentOrigin) => {
      if (!disposed && target && allowed.includes(target)) window.parent.postMessage({ v: 2, source: "geolibre", type, payload }, target);
    };
    const unsubscribeBridgeGeoAI = featureBridge.subscribeGeoAIRequests(request => emit("testudoGeoAIRequest", request));
    const relayReplies = new Map<string, (reply: plugins.TestudoGeoAIReply & { requestId: string; tviewId: string; generation: number }) => void>();
    const unsubscribeBridgeReplies = featureBridge.subscribeGeoAIReplies(reply => {
      relayReplies.get(reply.requestId)?.(reply);
      relayReplies.delete(reply.requestId);
      emit("testudoGeoAIReply", reply);
    });
    const readyTargets = pickBroadcastTargets(null, allowed, parentOriginHintFromBrowser()).filter(target => target !== "*");
    const ready = () => { if (!disposed) for (const target of readyTargets) window.parent.postMessage({ v: 2, source: "geolibre", type: "ready", payload: { version: "testudo-v1", challenge } }, target); };
    function requestArtifactFromParent(request: { requestId: string; tviewId: string; generation: number; artifactRef: string }, signal: AbortSignal): Promise<ArrayBuffer> {
      const target = parentOrigin;
      if (!target || !allowed.includes(target)) return Promise.reject(new Error("The Testudo host origin is not allowlisted."));
      return new Promise((resolve, reject) => {
        const finish = (error?: Error, bytes?: ArrayBuffer) => {
          clearTimeout(timer); window.removeEventListener("message", onMessage); signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve(bytes!);
        };
        const onAbort = () => finish(new Error("Artifact request was cancelled."));
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window.parent || !allowed.includes(event.origin)) return;
          const response = parseTestudoArtifactResponse(event.data, challenge);
          if (!response || response.requestId !== request.requestId || response.tviewId !== request.tviewId
            || response.generation !== request.generation || response.artifactRef !== request.artifactRef) return;
          if (response.bytes) finish(undefined, response.bytes); else finish(new Error(response.error ?? "Host artifact fetch failed."));
        };
        const timer = setTimeout(() => finish(new Error("Timed out waiting for host package artifact.")), 60_000);
        window.addEventListener("message", onMessage);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        window.parent.postMessage({ v: 2, source: "geolibre", type: "testudoArtifactRequest", payload: { ...request, challenge } }, target);
      });
    }
    const update = (patch: Partial<TestudoViewerState>) => {
      current = { ...current, ...patch };
      if (!disposed) setState(current);
      emit("testudoStateChanged", current);
      return current;
    };
    const getGeoAiViewerContext = (): GeoAiViewerContext => {
      const plugin = current.selectedPlugin ?? undefined;
      let mode: GeoAiViewerContext["mode"] = current.selectedMode;
      if (!mode) {
        if (plugin === "vehicle-playback") mode = "animation";
        else if (plugin === "network-kpi") {
          const metric = plugins.getNetworkKpiSettings().metric;
          mode = metric === "flow" || metric === "density" ? metric : "results";
        } else if (plugin === "path-analysis") mode = "paths";
        else if (plugin === "emissions-h3" || plugin === "geoai-buildings") mode = "environment";
        else if (plugin === "scenario-comparison") mode = "comparison";
      }

      let scenarioRows: Array<{ scid?: number | string }> = [];
      let activeIndex = -1;
      if (plugin === "vehicle-playback") {
        const playback = plugins.getVehiclePlaybackStatus();
        scenarioRows = playback.scenarios;
        activeIndex = playback.scenarioIndex;
      } else if (plugin === "network-kpi") {
        const results = plugins.getNetworkKpiStatus();
        scenarioRows = results.scenarios;
        activeIndex = results.scenarioIndex;
      } else if (plugin === "scenario-comparison") {
        const comparison = plugins.getScenarioComparisonStatus();
        const settings = plugins.getScenarioComparisonSnapshot();
        scenarioRows = comparison.scenarios;
        activeIndex = settings.scenarioA;
      }
      const scenarioIds = [...new Set(scenarioRows
        .filter(row => row.scid !== undefined && row.scid !== null && row.scid !== "")
        .map(row => Number(row.scid))
        .filter(value => Number.isSafeInteger(value) && value >= 0))].slice(0, 16);
      const activeScenario = scenarioRows[activeIndex]?.scid;
      const activeScenarioId = activeScenario === undefined ? undefined : Number(activeScenario);

      const context: GeoAiViewerContext = {
        surface: "geolibre",
        ...(mode ? { mode } : {}),
        ...(plugin ? { plugin } : {}),
        ...(scenarioIds.length ? { scenario_ids: scenarioIds } : {}),
        ...(activeScenarioId !== undefined && Number.isSafeInteger(activeScenarioId) && activeScenarioId >= 0
          ? { active_scenario_id: activeScenarioId } : {}),
        ...(current.package?.label ? { package_name: current.package.label } : {}),
      };
      if (plugin === "network-kpi") {
        const kpi = plugins.getNetworkKpiStatus();
        context.kpi_summary = { feature_count: kpi.featureCount, has_results: kpi.hasResults, has_sections: kpi.hasSections,
          interval_count: kpi.intervals.length, ...(Number.isSafeInteger(kpi.did) && kpi.did !== null ? { replication_id: kpi.did } : {}) };
      } else if (plugin === "path-analysis") {
        const path = plugins.getPathAnalysisSnapshot();
        context.kpi_summary = { selected_volume: path.selectedVolume, selected_section_count: path.selectedSections.length,
          interval_count: path.intervals.length };
      } else if (plugin === "vehicle-playback") {
        context.kpi_summary = { visible_vehicle_count: plugins.getVehiclePlaybackStatus().vehicleCount };
      }
      if (plugin === "path-analysis") {
        const selectedSection = plugins.getPathAnalysisSnapshot().selectedSection;
        if (typeof selectedSection === "number" && Number.isSafeInteger(selectedSection) && selectedSection >= 0) context.selected_section_id = selectedSection;
      }
      if (plugin === "vehicle-playback") {
        const playback = plugins.getVehiclePlaybackStatus();
        const settings = plugins.getVehiclePlaybackSnapshot();
        const start = (playback.timeline?.initialTimeSeconds ?? 0) + settings.tick * playback.dt;
        if (Number.isFinite(start) && Number.isFinite(playback.dt) && playback.dt > 0) {
          context.time_window = { start, end: start + playback.dt };
        }
      } else if (plugin === "scenario-comparison") {
        const comparison = plugins.getScenarioComparisonStatus();
        const start = comparison.currentTimeSeconds;
        const duration = comparison.timelineA?.intervalDurationSeconds ?? comparison.timelineB?.intervalDurationSeconds;
        if (start !== null && Number.isFinite(start) && duration && Number.isFinite(duration) && duration > 0) {
          context.time_window = { start, end: start + duration };
        }
      }
      const map = app.getMap?.();
      context.map = { available: Boolean(map) };
      try {
        const raw = map?.getBounds?.()?.toArray?.();
        if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && Array.isArray(raw[1])) {
          context.camera_bounds = [Number(raw[0][0]), Number(raw[0][1]), Number(raw[1][0]), Number(raw[1][1])];
        }
      } catch { /* Camera bounds are optional context; omit on map/read errors. */ }
      return context;
    };
    const closeMapPlugins = () => { for (const id of ids) if (id !== "geoai") handlers[id].close(); };
    const closeAllPlugins = () => { for (const id of ids) handlers[id].close(); };
    const syncAssistantOpen = () => update({ assistantOpen: plugins.isGeoAiChatPanelVisible() });
    const unsubscribeAssistantPanel = plugins.subscribeGeoAiChatPanel(syncAssistantOpen);
    const select = async (id: TestudoSelectablePluginId) => {
      if (!selectableIds.includes(id)) throw new Error("Unknown map plugin");
      const capability = current.capabilities.find(item => item.id === id);
      const comparisonProbe = id === "scenario-comparison" && comparisonDeclared && !capability?.available;
      if (!capability?.available && !comparisonProbe) throw new Error(capability?.reason ?? "This plugin is unavailable for this package.");
      if (!directory) throw new Error("Select a package first.");
      const version = generation;
      const selection = ++selectionGeneration;
      // Map-mode changes replace map plugins without closing the independent GeoAI panel.
      closeMapPlugins();
      update({ selectedPlugin: id, selectedMode: undefined, status: "loading", error: undefined });
      handlers[id].open(app);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const loading = handlers[id].load(directory);
      // A slow but successful idempotent data load may complete after the UI
      // deadline. Its state event must clear the stale timeout in the host.
      void loading.then(() => {
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection) return;
        const status = handlers[id].status();
        update(status.error ? { status: "error", error: status.error } : { status: "ready", error: undefined });
      }, error => {
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection) return;
        update({ status: "error", error: error instanceof Error ? error.message : String(error) });
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
      }
      if (disposed || generation !== version) throw new Error("Package selection changed");
      const status = handlers[id].status();
      if (id === "path-analysis" && declaredScenarioIds.length > 0) {
        await plugins.setPathAnalysisScenario(declaredScenarioIds[0]);
      }
      if (status.error) throw new Error(status.error);
      if (id === "scenario-comparison") {
        const comparison = plugins.getScenarioComparisonStatus();
        if (!comparison.timelineA || !comparison.timelineB || comparison.matchedIntervals.length === 0) {
          handlers[id].close();
          update({ selectedPlugin: null, selectedMode: undefined, status: "ready", availableModes: current.availableModes.filter(mode => mode !== "comparison"),
            capabilities: current.capabilities.map(item => item.id === "scenario-comparison" ? { ...item, available: false,
              reason: "Scenario comparison is unavailable: this package has no matched simulation intervals." } : item) });
          const activeSession = featureBridge.sessions.get("main");
          if (activeSession) activeSession.capabilities = activeSession.capabilities?.map(item => item.id === "scenario-comparison" ? { ...item, available: false,
            reason: "Scenario comparison is unavailable: this package has no matched simulation intervals." } : item);
          throw new Error("Scenario comparison is unavailable: this package has no matched simulation intervals.");
        }
        update({ capabilities: current.capabilities.map(item => item.id === "scenario-comparison" ? { ...item, available: true, reason: undefined } : item) });
        const activeSession = featureBridge.sessions.get("main");
        if (activeSession) activeSession.capabilities = activeSession.capabilities?.map(item => item.id === "scenario-comparison" ? { ...item, available: true, reason: undefined } : item);
      }
      bridgePluginId = id;
      if (bridgeInstalled) await featureBridge.selectPlugin("main", id);
      return update({ status: "ready" });
    };
    const applyScenarioAnalysisAction = async (event: Event) => {
      const detail = bootstrap ? validateScenarioAnalysisAction(
        (event as CustomEvent<unknown>).detail, bootstrap.versionId, declaredScenarioIds,
      ) : null;
      if (!detail) return;
      try {
        // Scenario changes are in-memory viewer state. The GeoAI panel is a
        // separate plugin, so switching the map view leaves it open.
        await select("network-kpi");
        const selected = await plugins.selectNetworkKpiScenarioId(detail.scenario_id as string | number);
        if (!selected) return;
        if (typeof detail.section_id === "string" || (typeof detail.section_id === "number" && Number.isSafeInteger(detail.section_id))) {
          plugins.highlightNetworkKpiSection(detail.section_id as string | number);
        }
        update({ assistantOpen: plugins.isGeoAiChatPanelVisible(), selectedMode: undefined });
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      }
    };
    window.addEventListener("testudo-scenario-analysis-action", applyScenarioAnalysisAction);
    const selectMode = async (mode: TestudoDemoMode) => {
      if (!current.availableModes.includes(mode)) {
        const capabilityId = mode === "animation" ? "vehicle-playback" : mode === "paths" ? "path-analysis" : mode === "environment" ? "emissions-h3" : mode === "comparison" ? "scenario-comparison" : "network-kpi";
        const reason = current.capabilities.find(item => item.id === capabilityId)?.reason;
        throw new Error(reason ?? (mode === "comparison" ? "Scenario comparison requires a declared scenario pair and at least one matched interval."
          : mode === "environment" ? "Environment mode requires usable CO2, NOx, or noise data."
          : mode === "animation" ? "Animation requires at least one playable scenario."
          : mode === "paths" ? "Path analysis requires a scenario path index." : "Results mode requires a supported network KPI."));
      }
      const target = modes.find(item => item.id === mode) ?? { id: mode, plugin: pluginForTestudoMode(mode) };
      const result = current.status === "ready" && current.selectedPlugin === target.plugin ? current : await select(target.plugin);
      if (mode === "animation") {
        const playback = plugins.getVehiclePlaybackStatus();
        if (playback.scenarioIndex < 0 && playback.scenarios.length > 0) await plugins.setVehiclePlaybackScenario(0);
      }
      if (mode === "flow" || mode === "density" || mode === "results") {
        const viewMode = current.viewModes?.results;
        const metric = mode === "results" ? (viewMode?.style.id === "delay" ? "delay" : viewMode?.column === "dtime" ? "delay" : viewMode?.column ?? "flow") : mode;
        handlers["network-kpi"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setNetworkKpiSettings>[0]["metric"]>, ...(viewMode?.style ? { extruded: viewMode.style.type === "extrusion" } : {}) });
      }
      if (mode === "comparison") {
        const viewMode = current.viewModes?.comparison;
        const snapshot = plugins.getScenarioComparisonSnapshot();
        const comparisonMetric = viewMode?.style.id === "cmp_flow_delta" ? "flow_delta" : viewMode?.column ?? "flow_delta";
        handlers["scenario-comparison"].settings({ metric: comparisonMetric as NonNullable<Parameters<typeof plugins.setScenarioComparisonSettings>[0]["metric"]>, mode: "diff", ...(viewMode?.style ? { extruded: viewMode.style.type === "extrusion" } : {}) });
        if (viewMode?.scenarioDidPair?.length) {
          const a = plugins.getScenarioComparisonStatus().scenarios.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![0].scid));
          const b = plugins.getScenarioComparisonStatus().scenarios.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![1].scid));
          if (a >= 0 && b >= 0) handlers["scenario-comparison"].settings({ scenarioA: a, scenarioB: b });
        }
        void snapshot;
      }
      if (mode === "environment") {
        const viewMode = current.viewModes?.environment;
        handlers["emissions-h3"].settings({ metric: (viewMode?.column ?? "co2") as NonNullable<Parameters<typeof plugins.setEmissionsH3Settings>[0]["metric"]>, ...(viewMode?.style ? { extruded: viewMode.style.type === "extrusion" } : {}) });
        const emissions = plugins.getEmissionsH3Status();
        if (!emissions.hasEmissions) {
          const reason = "Environment mode is unavailable: the selected scenario has no usable emissions data.";
          update({ availableModes: current.availableModes.filter(item => item !== "environment"), capabilities: current.capabilities.map(item => item.id === "emissions-h3" ? { ...item, available: false, reason } : item) });
          throw new Error(reason);
        }
      }
      const viewMode = current.viewModes?.[mode as "results" | "comparison" | "environment"];
      const defaultMetric = viewMode?.style.id === "cmp_flow_delta" ? "flow_delta" : viewMode?.style.id === "delay" || viewMode?.column === "dtime" ? "delay" : (viewMode?.column ?? "flow");
      const pair = viewMode?.scenarioDidPair?.length && mode === "comparison" ? plugins.getScenarioComparisonStatus().scenarios : [];
      const pairA = viewMode?.scenarioDidPair?.[0] ? pair.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![0].scid)) : -1;
      const pairB = viewMode?.scenarioDidPair?.[1] ? pair.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![1].scid)) : -1;
      const style = viewMode ? { display: viewMode.style.type, metric: defaultMetric, interval: 0, maxHeightM: viewMode.style.max ?? 100, ...(pairA >= 0 && pairB >= 0 ? { scenarioA: pairA, scenarioB: pairB } : {}) } : current.style;
      const updated = update({ ...result, selectedMode: mode, ...(style ? { style } : {}) });
      if (bridgeInstalled) await featureBridge.setViewMode("main", mode);
      return updated;
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
      if (bridgeInstalled) await featureBridge.applyPreset("main", id);
      return update({ presetId: id });
    };
    const installFeatureSession = async (candidate: TestudoBootstrap, selectedPlugin: TestudoSelectablePluginId | null, packageOrigin: "published" | "local", localReader?: (artifactRef: string) => Promise<ArrayBuffer>) => {
      const comparisonUnavailable = comparisonDeclared && current.capabilities.some(item => item.id === "scenario-comparison" && item.available);
      const capabilities = current.capabilities.filter(item => featureCapabilityIds.includes(item.id)).map(item =>
        comparisonUnavailable && item.id === "scenario-comparison" ? { ...item, available: false, reason: "Scenario comparison is hidden until this package has matched scenario intervals." } : item);
      const bridgeBootstrap = {
        packageId: candidate.packageId,
        versionId: candidate.versionId,
        label: candidate.label,
        artifactEndpoint: candidate.artifactEndpoint,
        origin: packageOrigin,
        capabilities,
        presets: candidate.presets.map(item => ({ id: item.id, plugin: item.plugin, settings: item.settings })),
        selectedPlugin: selectedPlugin ?? undefined,
      } as Parameters<typeof featureBridge.loadPackage>[1];
      const context = await featureBridge.loadPackage("main", bridgeBootstrap, () => {}, localReader);
      bridgeInstalled = true;
      bridgePluginId = selectedPlugin;
      const visibleCapabilities = comparisonUnavailable
        ? current.capabilities.map(item => item.id === "scenario-comparison" && item.available
          ? { ...item, available: false, reason: "Scenario comparison is hidden until this package has matched scenario intervals." } : item)
        : current.capabilities;
      update({ tviewId: "main", generation: context.generation, capabilities: visibleCapabilities } as Partial<TestudoViewerState>);
      return context;
    };
    const reset = () => {
      generation++;
      selectionGeneration++;
      abort.abort(); abort = new AbortController();
      featureBridge.sessions.remove("main");
      void plugins.setTestudoResultsSessionKey(null);
      bridgeInstalled = false;
      bridgePluginId = null;
      comparisonDeclared = false;
      closeAllPlugins(); directory = null; bootstrap = null; declaredScenarioIds = [];
      persistentNetwork.clear();
      plugins.resetGeoAiChat();
      plugins.resetGeoAiBuildings();
      update({ ...empty });
    };
    const load = async (payload: TestudoLoadPackage) => {
      const candidate = payload?.bootstrap && validateTestudoBootstrap(payload.bootstrap, !!guestCredential);
      if (!candidate || containsCredentialField(payload) || (guestCredential && payload.challenge !== challenge)) throw new Error("Invalid Testudo package bootstrap");
      reset(); bootstrap = candidate;
      comparisonDeclared = candidate.capabilities.some(item => item.id === "scenario-comparison" && item.available);
      const getGuestEmbedToken = guestCredential ? () => {
        if (!guestCredential || guestCredential.expiresAt <= Date.now()) throw new Error("Guest demo access expired; refresh the package to continue.");
        return guestCredential.token;
      } : undefined;
      const byteOrigins = getGuestEmbedToken ? (readDeploymentEnvValue("VITE_TESTUDO_BYTE_ORIGINS") ?? "").split(/[\s,]+/).filter(Boolean).map(value => new URL(value).origin) : [];
      if (getGuestEmbedToken && !byteOrigins.length) throw new Error("Package byte origin is not configured");
      const source = getGuestEmbedToken
        ? createSignedPackageSource({ origin, artifactEndpoint: candidate.artifactEndpoint, getGuestEmbedToken, byteOrigins, signal: abort.signal })
        : createParentProxiedPackageSource({ parent: window.parent, allowedOrigins: allowed, targetOrigin: () => parentOrigin,
          challenge, tviewId: "main", generation: () => generation, signal: abort.signal });
      directory = sourceDirectory(source, candidate.label);
      if (getGuestEmbedToken) plugins.initGeoAiChat({ origin, packageId: candidate.packageId, packageVersionId: candidate.versionId,
        guest: { getGuestEmbedToken }, getViewerContext: getGeoAiViewerContext });
      else plugins.initGeoAiChat({ origin, packageId: candidate.packageId, packageVersionId: candidate.versionId,
        getViewerContext: getGeoAiViewerContext,
        relay: async ({ messages, viewerContext }) => {
          const allowedPlugins = new Set(["vehicle-playback", "network-kpi", "scenario-comparison", "path-analysis", "emissions-h3"]);
          const active = featureBridge.sessions.get("main");
          if (!active?.context.pluginId || !allowedPlugins.has(active.context.pluginId)) throw new Error("GeoAI is unavailable for this viewer mode.");
          const question = messages[messages.length - 1]?.content ?? "";
          const accepted = await featureBridge.requestInvestigation("main", question,
            typeof viewerContext.active_scenario_id === "number" ? String(viewerContext.active_scenario_id) : undefined,
            messages, viewerContext as Record<string, unknown>);
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { relayReplies.delete(accepted.requestId); featureBridge.cancelGeoAIRequest(accepted.requestId); reject(new Error("Timed out waiting for the Testudo host GeoAI response.")); }, 90_000);
            relayReplies.set(accepted.requestId, reply => {
              clearTimeout(timeout);
              if (reply.tviewId !== accepted.tviewId || reply.generation !== accepted.generation) return;
              resolve({ content: reply.content, error: reply.error, scenarioAnalysis: reply.scenarioAnalysis,
                viewerAction: reply.viewerAction ? { scenario_id: reply.viewerAction.scenario_id, section_id: reply.viewerAction.section_id } : undefined,
                proposedActions: reply.proposedActions?.map(action => ({ type: action.type, label: action.label, value: "value" in action ? action.value : undefined })) });
            });
          });
        } });
      const safeCapabilities = candidate.capabilities.map(capability => capability.id === "geoai-buildings"
        ? { ...capability, available: false, reason: "GeoAI building detection requires a host-authenticated API and is disabled in the iframe." }
        : capability.id === "geoai" && !getGuestEmbedToken
          ? { ...capability, available: Boolean(parentOrigin && allowed.includes(parentOrigin)),
            reason: parentOrigin && allowed.includes(parentOrigin) ? undefined : "The Testudo host has not enabled GeoAI request handling." }
          : capability);
      update({ package: { packageId: candidate.packageId, versionId: candidate.versionId, label: candidate.label, origin: "published" }, capabilities: safeCapabilities, status: "loading" });
      const defaultPlugin = payload.selectedPlugin ?? safeCapabilities.find(item => item.available && item.id !== "geoai")?.id as TestudoSelectablePluginId | undefined ?? null;
      const featureContext = await installFeatureSession(candidate, defaultPlugin, "published");
      await plugins.setTestudoResultsSessionKey(`${candidate.packageId}:${featureContext.generation}`);
      const raw = await readLocalNetworkKpiManifestJson(directory);
      await persistentNetwork.mount(featureContext, directory, raw, app.getMap?.() as any,
        context => featureBridge.sessions.isCurrent(context));
      const pkg = getGeolibrePackage(raw);
      const packageScenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
      declaredScenarioIds = packageScenarios.map(item => item.scid).filter((id): id is string | number => id !== undefined);
      let hasMatchedComparison = false;
      if (pkg?.viewModes.comparison && pkg.scenarios.length > 1) {
        handlers["scenario-comparison"].open(app);
        try {
          await plugins.loadLocalScenarioComparisonFolder(directory);
          const comparison = plugins.getScenarioComparisonStatus();
          hasMatchedComparison = Boolean(comparison.timelineA && comparison.timelineB && comparison.matchedIntervals.length > 0);
        } finally { handlers["scenario-comparison"].close(); }
      }
      let hasUsableEmissions = false;
      if (pkg?.viewModes.environment) {
        handlers["emissions-h3"].open(app);
        try { await plugins.loadLocalEmissionsH3Folder(directory); hasUsableEmissions = plugins.getEmissionsH3Status().hasEmissions; }
        finally { handlers["emissions-h3"].close(); }
      }
      const hasAnimation = packageScenarios.length > 0;
      const root = raw as Record<string, unknown>;
      const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
      const contracts = pkg?.dataContracts ?? {};
      const knownColumns = Object.values(contracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
      const hasMetric = (metric: "flow" | "density") => Object.hasOwn(ramps, metric) || knownColumns.some(column => column === metric);
      const availableModes = availableTestudoModes({
        animation: safeCapabilities.some(item => item.id === "vehicle-playback" && item.available) && hasAnimation,
        flow: safeCapabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("flow"),
        density: safeCapabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("density"),
        results: safeCapabilities.some(item => item.id === "network-kpi" && item.available) && Boolean(pkg?.viewModes.results),
        comparison: hasMatchedComparison,
        environment: safeCapabilities.some(item => item.id === "emissions-h3" && item.available) && hasUsableEmissions,
        paths: safeCapabilities.some(item => item.id === "path-analysis" && item.available)
          && (hasDeclaredPathIndex(root.path_index) || hasDeclaredPathIndex(root.path_indices)),
      });
      const matchedReason = "Scenario comparison is unavailable: this package has no matched simulation intervals.";
      comparisonDeclared = hasMatchedComparison;
      update({ availableModes, viewModes: pkg?.viewModes, timeAxis: pkg?.timeAxis ?? undefined, scenarios: declaredScenarioIds.map(id => ({ id: String(id), label: `Scenario ${id}` })), selectedScenarioId: declaredScenarioIds.length ? String(declaredScenarioIds[0]) : undefined,
        capabilities: current.capabilities.map(item => item.id === "scenario-comparison" ? { ...item, available: hasMatchedComparison, reason: hasMatchedComparison ? undefined : matchedReason }
          : item.id === "emissions-h3" && pkg?.viewModes.environment ? { ...item, available: hasUsableEmissions, reason: hasUsableEmissions ? undefined : "No declared scenario has usable emissions rows." } : item) });
      const installedSession = featureBridge.sessions.get("main");
      if (installedSession) {
        installedSession.capabilities = current.capabilities.map(item => ({ ...item })) as TestudoFeatureSession["capabilities"];
        installedSession.availableModes = [...availableModes] as TestudoFeatureSession["availableModes"];
        installedSession.scenarios = declaredScenarioIds.map(id => ({ id: String(id), label: `Scenario ${id}` }));
      }
      const initialMode = availableModes.includes("animation") ? "animation" : availableModes[0];
      const initialPlugin = payload.selectedPlugin ?? (initialMode ? (modes.find(item => item.id === initialMode)?.plugin ?? pluginForTestudoMode(initialMode)) : undefined);
      if (!initialPlugin) throw new Error("This package has no supported viewer data");
      const modeForPlugin: Partial<Record<TestudoSelectablePluginId, TestudoDemoMode>> = { "vehicle-playback": "animation", "network-kpi": "results", "scenario-comparison": "comparison", "emissions-h3": "environment", "path-analysis": "paths", "geoai-buildings": "environment" };
      const requestedMode = payload.selectedPlugin ? modeForPlugin[payload.selectedPlugin] : initialMode;
      if (requestedMode && availableModes.includes(requestedMode)) {
        if (payload.selectedPlugin) await select(initialPlugin);
        await selectMode(requestedMode);
      } else await select(initialPlugin);
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
        declaredScenarioIds = listVehicleManifestScenarios(raw, { includeAnimationVariants: true })
          .map(item => item.scid).filter((id): id is string | number => id !== undefined);
        if (!pkg) throw new Error("Choose a built Testudo package containing manifest.json and geolibre/package.json. Raw models must be built first.");
        reset(); directory = selected;
        // Local folder loads have no Testudo session (no origin or chat credential), so GeoAI
        // cannot reach the Testudo chat routes here — the alias intentionally never matches a
        // `pkg.capabilities` key, keeping "geoai" unavailable with a clear reason.
        const aliases: Record<TestudoCapabilityId, string> = { "vehicle-playback": "animation", "network-kpi": "results", "path-analysis": "paths", "emissions-h3": "results", "scenario-comparison": "results", "geoai": "", "geoai-buildings": "" };
        const emissions = pkg.dataContracts.emissions as { status?: string } | undefined;
        const comparisonCount = pkg.scenarios.reduce((count, scenario) => count + Math.max(1, scenario.replications.length), 0);
        const capabilities = ids.map(id => ({ id, available: id !== "geoai" && id !== "geoai-buildings" && pkg.capabilities[aliases[id]]?.state === "available"
          && (id !== "emissions-h3" || emissions?.status === "available")
          && (id !== "scenario-comparison" || comparisonCount > 1), reason: id === "geoai"
            ? "GeoAI chat is only available for packages loaded from Testudo, not local folders."
            : id === "geoai-buildings"
            ? "GeoAI building detection is only available for packages loaded from Testudo, not local folders."
            : id === "emissions-h3"
            ? "No usable emissions data is declared for this package." : pkg.capabilities[aliases[id]]?.reason ?? "No compatible dataset declared." }));
        comparisonDeclared = capabilities.some(item => item.id === "scenario-comparison" && item.available);
        const root = raw as Record<string, unknown>;
        const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
        const knownColumns = Object.values(pkg.dataContracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
        let availableModes = availableTestudoModes({
          animation: capabilities.some(item => item.id === "vehicle-playback" && item.available) && listVehicleManifestScenarios(raw, { includeAnimationVariants: true }).length > 0,
          flow: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "flow") || knownColumns.includes("flow")),
          density: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "density") || knownColumns.includes("density")),
          results: capabilities.some(item => item.id === "network-kpi" && item.available) && Boolean(pkg.viewModes.results),
          comparison: capabilities.some(item => item.id === "scenario-comparison" && item.available) && Boolean(pkg.viewModes.comparison?.scenarioDidPair?.length && (pkg.timeAxis?.intervals ?? 0) > 0),
          environment: capabilities.some(item => item.id === "emissions-h3" && item.available) && emissions?.status === "available" && Boolean(pkg.viewModes.environment),
          paths: capabilities.some(item => item.id === "path-analysis" && item.available) && (hasDeclaredPathIndex(root.path_index) || hasDeclaredPathIndex(root.path_indices)),
        });
        update({ package: { packageId: crypto.randomUUID(), versionId: null, label: selected.name, origin: "local" }, capabilities, availableModes, viewModes: pkg.viewModes, timeAxis: pkg.timeAxis ?? undefined, scenarios: declaredScenarioIds.map(id => ({ id: String(id), label: `Scenario ${id}` })), selectedScenarioId: declaredScenarioIds.length ? String(declaredScenarioIds[0]) : undefined, status: "loading" });
        const localBootstrap = { packageId: current.package!.packageId, versionId: "local", label: selected.name,
          origin: "published" as const, manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
          artifactEndpoint: "", capabilities: capabilities.filter(item => featureCapabilityIds.includes(item.id)), presets: [] };
        const localReader = async (artifactRef: string) => (await (await directory!.getFileHandle(artifactRef)).getFile()).arrayBuffer();
        const featureContext = await installFeatureSession(localBootstrap, null, "local", localReader);
        await plugins.setTestudoResultsSessionKey(`${localBootstrap.packageId}:${featureContext.generation}`);
        await persistentNetwork.mount(featureContext, directory, raw, app.getMap?.() as any,
          context => featureBridge.sessions.isCurrent(context));
        let hasMatchedComparison = false;
        if (pkg.viewModes.comparison && pkg.scenarios.length > 1) {
          handlers["scenario-comparison"].open(app);
          try {
            await plugins.loadLocalScenarioComparisonFolder(directory);
            const comparison = plugins.getScenarioComparisonStatus();
            hasMatchedComparison = Boolean(comparison.timelineA && comparison.timelineB && comparison.matchedIntervals.length > 0);
          } finally { handlers["scenario-comparison"].close(); }
        }
        comparisonDeclared = hasMatchedComparison;
        if (hasMatchedComparison && !availableModes.includes("comparison")) availableModes = [...availableModes, "comparison"];
        if (!hasMatchedComparison) availableModes = availableModes.filter(mode => mode !== "comparison");
        update({ availableModes, capabilities: current.capabilities.map(item => item.id === "scenario-comparison" ? { ...item, available: hasMatchedComparison, reason: hasMatchedComparison ? undefined : "Scenario comparison is unavailable: this package has no matched simulation intervals." } : item) });
        if (pkg.viewModes.environment) {
          handlers["emissions-h3"].open(app);
          try {
            await plugins.loadLocalEmissionsH3Folder(directory);
            const hasEmissions = plugins.getEmissionsH3Status().hasEmissions;
            if (hasEmissions && !availableModes.includes("environment")) availableModes = [...availableModes, "environment"];
            if (!hasEmissions) {
              availableModes = availableModes.filter(mode => mode !== "environment");
            }
            update({ availableModes, capabilities: current.capabilities.map(item => item.id === "emissions-h3" ? { ...item, available: hasEmissions, reason: hasEmissions ? undefined : "No declared scenario has usable emissions rows." } : item) });
          }
          finally { handlers["emissions-h3"].close(); }
        }
        const installedSession = featureBridge.sessions.get("main");
        if (installedSession) {
          installedSession.capabilities = current.capabilities.map(item => ({ ...item })) as TestudoFeatureSession["capabilities"];
          installedSession.availableModes = [...availableModes] as TestudoFeatureSession["availableModes"];
          installedSession.scenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true })
            .flatMap(item => item.scid === undefined ? [] : [{ id: String(item.scid), label: String(item.label ?? item.scid) }]);
        }
        const initial = availableModes[0];
        if (!initial) throw new Error("This folder declares no supported viewer datasets");
        await selectMode(initial);
      } catch (error) { update({ status: "error", error: error instanceof Error ? error.message : String(error) }); }
      finally { busy = false; }
    };
    const loadPickedLocalPackage = async (selected: VehicleDirectoryHandle, requestId: string) => {
      if (busy) throw new Error(t("testudo.loading"));
      const pickerWindow = window as LocalPackagePickerWindow;
      if (!pickerWindow.showDirectoryPicker) {
        const error = t("testudo.folderUnsupported");
        update({ status: "error", error });
        throw new Error(error);
      }
      try {
        await picker.current?.(selected);
        const result = current;
        if (requestId) emit("ack", { requestId, ok: true, result });
        return result;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          localPickerRequestRef.current = null;
          setLocalPickerRequest(null);
          if (requestId) emit("ack", { requestId, ok: true, result: current });
          return current;
        }
        throw error;
      }
    };
    const onLocalPickerActivation = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId;
      if (!requestId || requestId !== localPickerRequestRef.current) return;
      const pickerWindow = window as LocalPackagePickerWindow;
      if (!pickerWindow.showDirectoryPicker) {
        const error = t("testudo.folderUnsupported");
        update({ status: "error", error });
        localPickerRequestRef.current = null;
        setLocalPickerRequest(null);
        emit("ack", { requestId, ok: false, error });
        return;
      }
      if (openingLocalPicker) return;
      openingLocalPicker = true;
      localPickerRequestRef.current = null;
      setLocalPickerRequest(null);
      void openLocalPackageFromActivation(requestId, requestId,
        () => pickerWindow.showDirectoryPicker!({ mode: "read" }), selected => loadPickedLocalPackage(selected, requestId))
        .then(result => {
          if (result === null) return;
        }).catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") {
          emit("ack", { requestId, ok: true, result: current });
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        update({ status: "error", error: detail });
        localPickerRequestRef.current = null;
        setLocalPickerRequest(null);
        emit("ack", { requestId, ok: false, error: detail });
      }).finally(() => { openingLocalPicker = false; });
    };
    window.addEventListener("testudo-local-package-picker", onLocalPickerActivation);
    const requestInvestigation = (request: MessageEvent["data"]) => {
      const requestId = request.requestId as string;
      const question = request.payload.question as string;
      emit("ack", { requestId, ok: true, result: { requestId, accepted: true } });
      const publishError = (error: unknown) => emit("testudoGeoAiInvestigationUpdate", {
        requestId,
        question,
        status: "error",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      const capability = current.capabilities.find(item => item.id === "geoai");
      if (!directory || !capability?.available || !plugins.isGeoAiChatConfigured()) {
        publishError(new Error(capability?.reason ?? "GeoAI is unavailable for this package."));
        return;
      }
      if (investigationBusy || plugins.getGeoAiChatStatus().loading) {
        publishError(new Error("GeoAI is already responding to another question."));
        return;
      }
      investigationBusy = true;
      const messageStart = plugins.getGeoAiChatStatus().messages.length;
      void plugins.sendGeoAiChat(question).then(status => {
        const answer = status.messages.slice(messageStart).filter(message => message.role === "assistant" || message.role === "error").at(-1);
        if (!answer || answer.role !== "assistant") {
          publishError(new Error(answer?.text ?? status.error ?? "GeoAI did not return a response."));
          return;
        }
        emit("testudoGeoAiInvestigationUpdate", {
          requestId,
          question,
          status: "complete",
          summary: summarizeGeoAiInvestigation(answer.text, answer.scenarioAnalysis),
        });
      }).catch(publishError).finally(() => { investigationBusy = false; });
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
      if (request.type === "testudoOpenLocalPackage") {
        localPickerRequestRef.current = request.requestId;
        setLocalPickerRequest(request.requestId);
        return;
      }
      if (request.type === "testudoRequestInvestigation") {
        requestInvestigation(request);
        return;
      }
      const run = async () => {
        if (request.payload?.tviewId !== undefined && request.payload.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
        if (request.type === "testudoGetState") return { ...current, tviewId: "main", generation: featureBridge.getTViews()[0]?.generation ?? 0 };
        if (request.type === "testudoCreateTView") {
          if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
          return featureBridge.getTViews()[0];
        }
        if (request.type === "testudoGetTView") {
          if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
          return featureBridge.getTViews()[0];
        }
        if (request.type === "testudoGetTViews") return featureBridge.getTViews();
        if (request.type === "testudoSetActiveTView") {
          if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
          return featureBridge.setActiveTView("main");
        }
        if (request.type === "testudoGetActiveTView") return featureBridge.getActiveTView();
        if (busy) throw new Error("The viewer is loading a package. Please wait.");
        busy = true;
        try {
          if (request.type === "testudoDestroyTView") {
            if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
            reset();
            featureBridge.close("main");
            const tview = featureBridge.createTView("main");
            featureBridge.setActiveTView("main");
            return tview;
          }
          if (request.type === "testudoLoadPackage") return await load(request.payload);
          if (request.type === "testudoSetPlugin") {
            const id = String(request.payload?.id ?? "");
            if ((current.availableModes as string[]).includes(id)) return await selectMode(id as TestudoDemoMode);
            return await select(id as TestudoSelectablePluginId);
          }
          if (request.type === "testudoSetMode") return await selectMode(request.payload.mode);
          if (request.type === "testudoSetScenario") {
            const generationExpected = request.payload?.generation;
            if (request.payload?.tviewId !== undefined && request.payload.tviewId !== "main") throw new Error("Scenario command targets an unsupported TView.");
            if (generationExpected !== undefined && generationExpected !== generation) throw new Error("Scenario command belongs to a stale package generation.");
            const scenarioId = await featureBridge.selectScenario("main", String(request.payload?.scenarioId), generationExpected as number | undefined);
            if (bridgePluginId === "emissions-h3") {
              const hasEmissions = plugins.getEmissionsH3Status().hasEmissions;
              const reason = "Environment mode is unavailable for this scenario because it has no usable emissions rows.";
              const availableModes = hasEmissions && current.viewModes?.environment
                ? [...new Set([...current.availableModes, "environment" as TestudoDemoMode])]
                : current.availableModes.filter(mode => mode !== "environment");
              const capabilities = current.capabilities.map(item => item.id === "emissions-h3" ? { ...item, available: hasEmissions, reason: hasEmissions ? undefined : reason } : item);
              const activeSession = featureBridge.sessions.get("main");
              if (activeSession) { activeSession.availableModes = availableModes; activeSession.capabilities = capabilities.filter(item => featureCapabilityIds.includes(item.id)) as TestudoFeatureSession["capabilities"]; }
              update({ selectedScenarioId: scenarioId, availableModes, capabilities, ...(hasEmissions ? {} : { selectedMode: undefined }) });
              if (!hasEmissions) throw new Error(reason);
            } else update({ selectedScenarioId: scenarioId });
            return { scenarioId };
          }
          if (request.type === "testudoSetStyle") {
            if (request.payload?.tviewId !== "main" || request.payload?.generation !== generation) throw new Error("Style command belongs to a stale package generation.");
            const style = validateTestudoStyle(request.payload?.style, current.selectedMode, declaredScenarioIds.length);
            const { display, metric, interval, maxHeightM, scenarioA, scenarioB } = style;
            const extruded = display === "extrusion";
            if (current.selectedMode === "comparison") handlers["scenario-comparison"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setScenarioComparisonSettings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM), ...(scenarioA !== undefined ? { scenarioA: Number(scenarioA) } : {}), ...(scenarioB !== undefined ? { scenarioB: Number(scenarioB) } : {}) });
            else if (current.selectedMode === "environment") handlers["emissions-h3"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setEmissionsH3Settings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM) });
            else handlers["network-kpi"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setNetworkKpiSettings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM) });
            return update({ style });
          }
          if (request.type === "testudoSetScenarioPair") {
            if (!current.capabilities.some(item => item.id === "scenario-comparison" && item.available)) throw new Error("Scenario comparison is unavailable for this package.");
            const session = featureBridge.sessions.get("main");
            if (!session || (request.payload?.generation !== undefined && request.payload.generation !== session.context.generation)) throw new Error("Scenario pair command belongs to a stale package generation.");
            if (bridgePluginId !== "scenario-comparison") throw new Error("Select scenario comparison before changing its scenario pair.");
            const scenarioA = Number(request.payload?.scenarioA); const scenarioB = Number(request.payload?.scenarioB);
            const scenarioCount = plugins.getScenarioComparisonStatus().scenarios.length;
            if (!Number.isSafeInteger(scenarioA) || scenarioA < 0 || scenarioA >= scenarioCount || !Number.isSafeInteger(scenarioB) || scenarioB < 0 || scenarioB >= scenarioCount) throw new Error("Comparison scenario indexes are invalid.");
            scenarioAdapters.comparison(scenarioA, scenarioB);
            return { scenarioA, scenarioB };
          }
          if (request.type === "testudoSetPlaybackPlaying") return featureBridge.playback("main", request.payload?.playing ? "play" : "pause", undefined, request.payload?.generation);
          if (request.type === "testudoRestartPlayback") return featureBridge.playback("main", "restart", undefined, request.payload?.generation);
          if (request.type === "testudoSeekPlayback") return featureBridge.playback("main", "seek", Number(request.payload?.tick), request.payload?.generation);
          if (request.type === "testudoSetPlaybackSpeed") return featureBridge.playback("main", "speed", Number(request.payload?.speed), request.payload?.generation);
          if (request.type === "testudoGetPlaybackState") return featureBridge.getPlaybackState("main", request.payload?.generation);
          if (request.type === "testudoSetCameraView") {
            const view = request.payload?.view as TestudoCameraView;
            await featureBridge.setCameraView("main", view, request.payload?.generation);
            return featureBridge.getCameraView("main", request.payload?.generation);
          }
          if (request.type === "testudoGetCameraView") return featureBridge.getCameraView("main", request.payload?.generation);
          if (request.type === "testudoSetViewMode") return { mode: await featureBridge.setViewMode("main", request.payload?.mode) };
          if (request.type === "testudoFeatureRequestInvestigation") return featureBridge.requestInvestigation("main", String(request.payload?.question ?? ""),
            typeof request.payload?.activeScenarioId === "string" ? request.payload.activeScenarioId : undefined);
          if (request.type === "testudoRespondGeoAIRequest") return featureBridge.respondGeoAIRequestTuple(String(request.payload?.requestId ?? ""), String(request.payload?.tviewId ?? "main"),
            Number(request.payload?.generation), { content: typeof request.payload?.content === "string" ? request.payload.content : undefined,
              error: typeof request.payload?.error === "string" ? request.payload.error : undefined,
              scenarioAnalysis: isBoundedDisplayObject(request.payload?.scenario_analysis) ? request.payload.scenario_analysis
                : isBoundedDisplayObject(request.payload?.scenarioAnalysis) ? request.payload.scenarioAnalysis : undefined,
              proposedActions: Array.isArray(request.payload?.proposedActions) ? request.payload.proposedActions.slice(0, 8).filter(isDisplayOnlyAction) : undefined,
              viewerAction: bootstrap && validateScenarioAnalysisAction(request.payload?.viewer_action ?? request.payload?.viewerAction, bootstrap.versionId, declaredScenarioIds) || undefined });
          if (request.type === "testudoOpenGeoAiChat") {
            const open = request.payload.open as boolean;
            if (open) {
              const capability = current.capabilities.find(item => item.id === "geoai");
              if (!capability?.available) throw new Error(capability?.reason ?? "GeoAI is unavailable for this session.");
              if (!directory) throw new Error("Select a package first.");
              handlers.geoai.open(app);
            } else handlers.geoai.close(app);
            return update({ assistantOpen: plugins.isGeoAiChatPanelVisible() });
          }
          return await applyPreset(request.payload?.id);
        } finally { busy = false; }
      };
      void run().then(result => emit("ack", { requestId: request.requestId, ok: true, result }), error => {
        const detail = error instanceof Error ? error.message : String(error);
        if (request.type === "testudoLoadPackage" || request.type === "testudoOpenLocalPackage") update({ status: "error", error: detail });
        else update({ status: current.package ? "ready" : "empty", error: undefined });
        emit("ack", { requestId: request.requestId, ok: false, error: detail });
      });
    };
    window.addEventListener("message", message);
    document.title = "Testudo";
    ready();
    // The host can import the client after iframe load. Repeat readiness until
    // its first command so that ordering cannot strand a healthy map.
    readyTimer = setInterval(ready, 500);
    const readyStop = setTimeout(() => clearInterval(readyTimer), 60_000);
    return () => { disposed = true; generation++; guestCredential = null; parentOrigin = null; persistentNetwork.clear(); void plugins.setTestudoResultsSessionKey(null); clearInterval(readyTimer); clearTimeout(readyStop); abort.abort(); picker.current = null; modeSelector.current = null; window.removeEventListener("message", message); window.removeEventListener("testudo-local-package-picker", onLocalPickerActivation); window.removeEventListener("testudo-scenario-analysis-action", applyScenarioAnalysisAction); unsubscribeAssistantPanel(); unsubscribeBridgeGeoAI(); unsubscribeBridgeReplies(); featureBridge.close("main"); closeAllPlugins(); plugins.resetGeoAiChat(); plugins.resetGeoAiBuildings(); };
  }, [app]);

  const canOpenGeoAi = Boolean(app && state.capabilities.some(item => item.id === "geoai" && item.available));
  const hasVisibleStatus = state.status === "loading" || Boolean(state.error) || Boolean(localPickerRequest);
  if (!canOpenGeoAi && !hasVisibleStatus) return null;

  // The embedding Testudo shell renders its own "open package" control and mode/plugin
  // switcher outside this iframe (ProductApp.tsx / EmbeddedViewer.tsx), so this panel no
  // longer duplicates them here (see the Testudo-side UI reconciliation pass) — it now only
  // surfaces what the shell cannot: the GeoAI trigger and inline loading/error status.
  return <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex justify-end" data-testudo-controls>
    <div className="pointer-events-auto w-fit min-w-0 max-w-[min(20rem,100%)] rounded-md border border-border bg-background p-3 shadow-lg">
      {canOpenGeoAi && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => { if (app) handlers["geoai"].open(app); }}>{t("toolbar.geoai.open", "Ask GeoAI")}</button>}
      {localPickerRequest && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => window.dispatchEvent(new CustomEvent("testudo-local-package-picker", { detail: { requestId: localPickerRequest } }))}>{t("testudo.chooseLocalFolder", "Choose a local package folder")}</button>}
      {state.status === "loading" && <p role="status" className="text-sm">{t("testudo.loading")}</p>}
      {state.error && <p role="alert" className="mt-2 break-words text-sm text-red-600">{state.error}</p>}
    </div>
  </div>;
}
