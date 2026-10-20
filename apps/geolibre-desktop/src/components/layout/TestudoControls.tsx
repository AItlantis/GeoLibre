import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as plugins from "@geolibre/plugins";
import { useAppStore } from "@geolibre/core";
import { validateTestudoCameraView } from "@geolibre/plugins";
import type { GeoAiViewerContext, GeoLibreAppAPI, TestudoCameraView, TestudoFeatureSession } from "@geolibre/plugins";
import type { TestudoAnalysisCapabilityId, TestudoBootstrap, TestudoCapabilityId, TestudoSelectablePluginId, TestudoDemoMode, TestudoLoadPackage, TestudoViewerState } from "@geolibre/embed";
import { resetTestudoPanels, setTestudoPanels, TESTUDO_PANELS_DEFAULT, testudoPanelsFromPayload, useTestudoPanels } from "../../lib/testudo-panels";
import { isSetPanelsPayload, isSetPresentSuspendedPayload } from "../../lib/testudo-protocol";
import { containsCredentialField, parseTestudoArtifactResponse, readEmbedOrigins, unsupportedTestudoCommand } from "../../lib/embed-api";
import { parentOriginHintFromBrowser, pickBroadcastTargets } from "../../hooks/embedHost";
import { mapViewFromMapLibre, type TestudoRendererReadinessRef, type TestudoTViewIdentityRef } from "../../lib/testudo-renderer-readiness";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { runWithPackageOwnerRelease, TestudoCommandGate } from "../../lib/testudo-command-gate";
import { createParentProxiedPackageSource, createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage, availableTestudoModes, createTestudoNativeActionEvent, createTestudoSupersedeStartupProjectEvent, isTestudoAnalysisCapabilityId, validateScenarioAnalysisAction, validateTestudoBootstrap } from "../../lib/testudo-protocol";
import { resolveTestudoViewerKind, TestudoAnalysisController } from "../../lib/testudo-analysis";
import { getPluginManager } from "../../hooks/usePlugins";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";
import { listVehicleManifestScenarios } from "@geolibre/plugins";
import { summarizeGeoAiInvestigation } from "../../lib/testudo-investigation";
import { availableModesForScenario, comparisonStyleState, finalizeModeSelection, initializeFirstAnimationScenarioIfNeeded, modeForScenarioChange, pluginForTestudoMode, reconcileEnvironmentCapability, reconcilePathCapability, reconcileResultsCapability, resolveComparisonScenarioPairIds, routeTestudoPluginSelection, selectScenarioInRoster, testudoViewerStyleState, validateTestudoStyle } from "../../lib/testudo-view-style";

function traceTestudoBridge(event: string, detail: Record<string, unknown> = {}): void {
  try {
    if (typeof window !== "undefined" && window.localStorage.getItem("testudo_bridge_trace") === "1") {
      console.info("[TestudoBridgeTrace:TestudoControls]", event, detail);
    }
  } catch { /* Diagnostics must not affect viewer startup. */ }
}

let playbackCommandTraceCount = 0;
const PLAYBACK_COMMAND_TRACE_LIMIT = 128;
function tracePlaybackCommand(event: string, detail: Record<string, unknown>): void {
  if (playbackCommandTraceCount >= PLAYBACK_COMMAND_TRACE_LIMIT) return;
  try {
    if (typeof window === "undefined" || !plugins.testudoLiveDiagnosticsEnabled(import.meta.env.DEV || import.meta.env.MODE === "test", window.location.search)) return;
    playbackCommandTraceCount++;
    console.info("[TestudoPlaybackTrace:TestudoControls]", event, detail);
  } catch { /* Trace must never affect the command path. */ }
}

/** Exported so tests can assert every Testudo capability is actually wired here (see #273: GeoAI
 * chat previously existed only in the legacy viewer, with zero entry in this list). */
export const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai", "geoai-buildings", "analysis-counts", "analysis-od", "analysis-journey-time"];
/** Capabilities driven through the shared `handlers` table; Analyse ids open via testudoOpenAnalysis instead. */
const handledIds = ids.filter((id): id is Exclude<TestudoCapabilityId, TestudoAnalysisCapabilityId> => !isTestudoAnalysisCapabilityId(id));
const featureCapabilityIds: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"];

function consistentComparisonDurationSeconds(
  timelineA: { initialTimeSeconds: number | null; durationSeconds: number | null; intervalDurationSeconds: number | null; intervalCount: number | null } | null | undefined,
  timelineB: { initialTimeSeconds: number | null; durationSeconds: number | null; intervalDurationSeconds: number | null; intervalCount: number | null } | null | undefined,
): number | null {
  const period = (timeline: typeof timelineA) => {
    if (!timeline || timeline.initialTimeSeconds === null || !Number.isFinite(timeline.initialTimeSeconds)) return null;
    const duration = timeline.durationSeconds ?? (timeline.intervalCount !== null && timeline.intervalCount > 0 && timeline.intervalDurationSeconds !== null
      ? Math.max(0, timeline.intervalCount - 1) * timeline.intervalDurationSeconds : null);
    if (duration === null || !Number.isFinite(duration) || duration < 0) return null;
    return { start: timeline.initialTimeSeconds, end: timeline.initialTimeSeconds + duration, duration };
  };
  const a = period(timelineA);
  const b = period(timelineB);
  const tolerance = 1e-6;
  return a && b && Math.abs(a.start - b.start) <= tolerance && Math.abs(a.end - b.end) <= tolerance
    ? a.duration : null;
}
const selectableIds = ids.filter((id): id is TestudoSelectablePluginId => id !== "geoai" && id !== "geoai-buildings" && !isTestudoAnalysisCapabilityId(id));
const modes: Array<{ id: TestudoDemoMode; label: string; plugin: TestudoSelectablePluginId }> = [
  { id: "animation", label: "Animation", plugin: "vehicle-playback" },
  { id: "flow", label: "Flow", plugin: "network-kpi" },
  { id: "paths", label: "Paths", plugin: "path-analysis" },
  { id: "density", label: "Density", plugin: "network-kpi" },
];
const empty: TestudoViewerState = { package: null, selectedPlugin: null, assistantOpen: false, capabilities: [], availableModes: [], status: "empty", panels: { ...TESTUDO_PANELS_DEFAULT } };
type TestudoCameraSnapshot = { center: [number, number]; zoom: number; bearing: number; pitch: number; renderer: "maplibre" | "cesium" };
/**
 * Renderer-aware camera access that never depends on a loaded plugin session (analysis-only packages have none).
 * Cesium has no MapLibre map (getMap() is null) and mirrors its camera into the store's engine-neutral mapView, so
 * the store is the camera of record there; MapLibre is read/written directly. Anything else fails loudly.
 */
function readTestudoCamera(app: GeoLibreAppAPI): TestudoCameraSnapshot {
  if (useAppStore.getState().primaryRenderer === "cesium") {
    const view = useAppStore.getState().mapView;
    if (!view || ![view.center?.[0], view.center?.[1], view.zoom, view.bearing, view.pitch].every(Number.isFinite)) throw new Error("The Cesium camera is not ready yet.");
    return { center: [view.center[0], view.center[1]], zoom: view.zoom, bearing: view.bearing, pitch: view.pitch, renderer: "cesium" };
  }
  const view = mapViewFromMapLibre(app.getMap?.());
  if (!view) throw new Error("The map camera is not ready yet.");
  return { center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch, renderer: "maplibre" };
}
function applyTestudoCamera(app: GeoLibreAppAPI, view: { center: [number, number]; zoom: number; bearing: number; pitch: number }): "maplibre" | "cesium" {
  if (useAppStore.getState().primaryRenderer === "cesium") {
    // The Cesium engine applies the store view to its camera.
    useAppStore.getState().setMapView({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
    return "cesium";
  }
  const map = app.getMap?.();
  if (!map) throw new Error("The map is not ready, so the camera cannot be applied.");
  map.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
  return "maplibre";
}
function intervalSampleTimes(intervals: number[], timeline: { initialTimeSeconds: number | null; intervalDurationSeconds: number | null } | null | undefined) {
  if (timeline?.initialTimeSeconds == null || timeline.intervalDurationSeconds == null) return [];
  return intervals.filter(value => Number.isFinite(value) && value > 0).map(value => ({ value, timeSeconds: timeline.initialTimeSeconds! + (value - 1) * timeline.intervalDurationSeconds! }));
}
function isVehicleDirectoryHandle(value: unknown): value is VehicleDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<VehicleDirectoryHandle> & { kind?: unknown };
  return handle.kind === "directory" && typeof handle.name === "string" && handle.name.length <= 255
    && typeof handle.getFileHandle === "function" && typeof handle.getDirectoryHandle === "function";
}
type TestudoControlMap = {
  getSource(id: string): unknown;
  addSource(id: string, source: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  addLayer(layer: Record<string, unknown>, beforeId?: string): void;
  getStyle(): { layers?: Array<{ id?: string; type?: string }> };
  getLayoutProperty(id: string, name: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): void;
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
export function TestudoControls({ app, rendererReadinessRef, currentTViewRef }: { app: GeoLibreAppAPI | null; rendererReadinessRef: TestudoRendererReadinessRef; currentTViewRef: TestudoTViewIdentityRef }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TestudoViewerState>(empty);
  const picker = useRef<((directory: VehicleDirectoryHandle, operation?: number) => Promise<void>) | null>(null);
  const modeSelector = useRef<((mode: TestudoDemoMode) => Promise<TestudoViewerState>) | null>(null);
  useEffect(() => {
    if (!app) {
      traceTestudoBridge("controls-waiting-for-map-api", {
        origin: window.location.origin,
        referrer: document.referrer,
        renderer: rendererReadinessRef.current.renderer,
        rendererEpoch: rendererReadinessRef.current.epoch,
        rendererReady: rendererReadinessRef.current.ready,
        rendererError: rendererReadinessRef.current.error,
        controllerApiAvailable: false,
      });
      return;
    }
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
    let declaredScenarioRoster: NonNullable<TestudoFeatureSession["scenarios"]> = [];
    let declaredVariantScenarioRoster: NonNullable<TestudoFeatureSession["scenarios"]> = [];
    let environmentScenarioCoverage: ReturnType<typeof plugins.resolveEnvironmentScenarioCoverage> = { byScid: {}, packageEligible: true };
    let environmentPackageEligible = true;
    let preferredMode: TestudoDemoMode | undefined;
    let declaredAvailableModes: TestudoDemoMode[] = [];
    let abort = new AbortController();
    let disposed = false;
    let generation = 0;
    let packageOperation = 0;
    let selectionGeneration = 0;
    const commandGate = new TestudoCommandGate();
    let comparisonPairRequest = 0;
    let investigationBusy = false;
    let bridgeInstalled = false;
    let bridgePluginId: TestudoSelectablePluginId | null = null;
    let scenarioToPreserveOnPluginSelect: string | number | undefined;
    const persistentNetwork = new plugins.TestudoPersistentNetwork();
    const persistentNetworkMapWatch = setInterval(() => persistentNetwork.reconcileMap(app.getMap?.() as any ?? null), 200);
    // Present data is framed once per package version, never after the user moved the map (see testudo-package-fit).
    const packageFitter = new plugins.PackageFitter();
    const fitPackageView = (key: string, rawManifest: unknown) => {
      try {
        const bounds = plugins.manifestBounds(rawManifest) ?? persistentNetwork.getGeometryBounds();
        const cesium = useAppStore.getState().primaryRenderer === "cesium";
        packageFitter.fit(key, bounds, {
          map: cesium ? null : (app.getMap?.() as unknown as plugins.PackageFitMap | null) ?? null,
          applyCamera: cesium ? camera => { applyTestudoCamera(app, { ...camera, bearing: 0, pitch: 0 }); } : undefined,
          viewport: { width: window.innerWidth || 1280, height: window.innerHeight || 720 },
        });
      } catch { /* framing the package is best-effort and must never fail a package load */ }
    };
    // Mode switch (testudoSetPresentSuspended): Analyse suspends the Present plugin panel(s) and playback, Present resumes them.
    let presentSuspended: { plugin: TestudoSelectablePluginId | null } | null = null;
    let comparisonDeclared = false;
    let standaloneEsriVisible = false;
    const scenarioAdapters = plugins.createScenarioSelectionAdapters({ setNetworkKpiScenario: plugins.setNetworkKpiScenario,
      setVehiclePlaybackScenario: plugins.setVehiclePlaybackScenario, setScenarioComparisonSettings: async ({ scenarioA, scenarioB }) => plugins.selectScenarioComparisonPair(scenarioA, scenarioB) });
    const seenLocalPackageRequests = new Set<string>();
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    let mapControlsTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribeMapControls: (() => void) | undefined;
    const ownsPackageOperation = (operation: number) => !disposed && packageOperation === operation;
    const assertPackageOperation = (operation: number) => {
      if (!ownsPackageOperation(operation)) throw new Error("Package selection was superseded by a newer request.");
    };
    // Analyse plugins open one at a time through PluginManager.openWithParams; reset() tears them down.
    // Bundled drop-ins register asynchronously after startup, so wait (bounded) for the target to appear.
    const analysisManager = getPluginManager();
    const analysisHost = {
      openWithParams: async (id: string, params: Record<string, string>, appApi: GeoLibreAppAPI) => {
        if (!analysisManager.list().some(item => item.id === id)) {
          await new Promise<void>(resolve => {
            const stop = (): void => { clearTimeout(timer); unsubscribe(); resolve(); };
            const unsubscribe = analysisManager.subscribe(() => { if (analysisManager.list().some(item => item.id === id)) stop(); });
            const timer = setTimeout(stop, 15_000);
          });
        }
        return analysisManager.openWithParams(id, params, appApi);
      },
      deactivate: (id: string, appApi: GeoLibreAppAPI) => analysisManager.deactivate(id, appApi),
      getPlugin: (id: string) => analysisManager.list().find(item => item.id === id) ?? null,
    };
    const analysis = new TestudoAnalysisController(analysisHost, app, status => emit("testudoAnalysisStatus", status), Date.now, info => emit("testudoAnalysisInfo", info));
    const featureBridge = new plugins.TestudoFeatureBridge((packageBootstrap) => ({
      open: async (_bootstrap, context) => {
        plugins.setVehiclePlaybackLiveDiagnosticsGeneration(context.generation);
        const providerOpenStartedAt = performance.now();
        traceTestudoBridge("provider-open-callback", { phase: "start", elapsedMs: 0 });
        const traceProviderOpen = (phase: "complete") => traceTestudoBridge("provider-open-callback", {
          phase, elapsedMs: Math.round(performance.now() - providerOpenStartedAt),
        });
        bridgePluginId = context.pluginId as TestudoSelectablePluginId | null;
        const isCurrent = (tviewId: string, expectedGeneration: number) => tviewId === "main" && featureBridge.sessions.isCurrent({ tviewId, generation: expectedGeneration });
        const vehiclePlayback = plugins.createVehiclePlaybackAdapter({ getStatus: () => { const status = plugins.getVehiclePlaybackStatus(); return { ...status, available: status.scenarios.length > 0, initialTimeSeconds: status.timeline?.initialTimeSeconds ?? null, simulationDurationSeconds: status.timeline?.durationSeconds ?? null }; }, getSettings: plugins.getVehiclePlaybackSnapshot,
          setTick: plugins.setVehiclePlaybackTick, setSettings: plugins.setVehiclePlaybackSettings, setScenario: plugins.setVehiclePlaybackScenario,
          subscribe: listener => plugins.subscribeToPlaybackSources([plugins.subscribeVehiclePlayback, plugins.subscribeVehiclePlaybackStatus], listener) }, isCurrent, context);
        const kpiPlayback = plugins.createNetworkKpiPlaybackAdapter({ getStatus: () => { const status = plugins.getNetworkKpiStatus(); return { loading: status.loading, intervals: status.intervals, error: status.error, dt: status.timeline?.intervalDurationSeconds, sampleTimes: intervalSampleTimes(status.intervals, status.timeline), simulationDurationSeconds: status.timeline?.durationSeconds ?? null }; }, getSettings: plugins.getNetworkKpiSnapshot,
          setSettings: plugins.setNetworkKpiSettings, stepNetworkKpiInterval: plugins.stepNetworkKpiInterval, setScenario: plugins.setNetworkKpiScenario,
          // KPI settings (interval, play/pause, speed, loop) and load/status
          // changes use separate stores; observe both so the host timeline
          // follows timer ticks as well as load progress and scenario changes.
          subscribe: listener => plugins.subscribeToPlaybackSources(
            [plugins.subscribeNetworkKpiStatus, plugins.subscribeNetworkKpi], listener,
          ) }, isCurrent, context);
        const emissionsPlayback = plugins.createNetworkKpiPlaybackAdapter({
          getStatus: () => { const status = plugins.getEmissionsH3Status(); return { loading: status.loading, intervals: status.intervals, error: status.error, dt: status.timeline?.intervalDurationSeconds, sampleTimes: intervalSampleTimes(status.intervals, status.timeline), simulationDurationSeconds: status.timeline?.durationSeconds ?? null }; },
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
        const comparisonPlayback = plugins.createScenarioComparisonPlaybackAdapter({ getStatus: () => { const status = plugins.getScenarioComparisonStatus(); return { loading: status.loading, intervals: status.intervals, error: status.error, matchedIntervals: status.matchedIntervals, dt: status.timelineA?.intervalDurationSeconds, simulationDurationSeconds: consistentComparisonDurationSeconds(status.timelineA, status.timelineB) }; }, getSettings: plugins.getScenarioComparisonSnapshot,
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
        const scenarios = () => scenarioRosterForPlugin(bridgePluginId);
        const capabilities = (packageBootstrap.capabilities ?? []).filter(item => ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"].includes(item.id));
        const session: TestudoFeatureSession = {
          context, capabilities, availableModes: current.availableModes as TestudoFeatureSession["availableModes"], selectedMode: current.selectedMode as TestudoFeatureSession["selectedMode"],
          scenarios: scenarios(), playback,
          selectPlugin: async id => {
            bridgePluginId = id as TestudoSelectablePluginId;
            if (!(bridgePluginId === "network-kpi" && scenarioToPreserveOnPluginSelect !== undefined)) syncScenarioRoster(bridgePluginId);
            return id;
          },
          applyPreset: id => id,
          selectScenario: async id => {
            const packageGenerationAtStart = generation;
            const packageOperationAtStart = packageOperation;
            const sessionAtStart = featureBridge.sessions.get("main") ?? null;
            const assertCurrent = () => {
              if (disposed || generation !== packageGenerationAtStart || packageOperation !== packageOperationAtStart
                || sessionAtStart && !featureBridge.sessions.isCurrent(sessionAtStart.context)) {
                throw new Error("Scenario selection belongs to a stale package generation.");
              }
            };
            const row = scenarios().find(item => item.id === id);
            if (!row) throw new Error(`Scenario ${id} is unavailable for ${bridgePluginId}.`);
            if (bridgePluginId === "vehicle-playback") {
              const variantIndex = plugins.vehiclePlaybackVariantIndex(plugins.getVehiclePlaybackStatus().scenarios, id);
              if (variantIndex < 0) throw new Error(`Scenario ${id} has no animation variant.`);
              await scenarioAdapters.vehiclePlayback(variantIndex);
            } else if (bridgePluginId === "scenario-comparison") {
              const comparisonScenarios = plugins.getScenarioComparisonStatus().scenarios;
              const scenarioIndex = comparisonScenarios.findIndex(item => String(item.scid) === String(row.scenarioId ?? row.id));
              if (scenarioIndex < 0) throw new Error(`Scenario ${id} is unavailable for comparison.`);
              const prior = plugins.getScenarioComparisonSnapshot();
              await scenarioAdapters.comparison(scenarioIndex, prior.scenarioB);
              const comparisonStatus = plugins.getScenarioComparisonStatus();
              if (comparisonStatus.error) throw new Error(comparisonStatus.error);
            } else if (bridgePluginId === "emissions-h3") {
              const coverage = environmentScenarioCoverage.byScid[String(row.scenarioId ?? row.id)] ?? { status: "unknown" as const, dids: [] };
              if (coverage.status === "available") await loadEnvironmentScenarioData(row.scenarioId ?? row.id, preferredEnvironmentDid(coverage)!);
              else if (coverage.status === "unavailable") plugins.clearEmissionsH3Scenario(row.scenarioId ?? row.id);
              else await plugins.verifyEnvironmentScenarioCandidates(
                coverage.candidateDids ?? [],
                did => loadEnvironmentScenarioData(row.scenarioId ?? row.id, did),
                () => plugins.clearEmissionsH3Scenario(row.scenarioId ?? row.id),
                assertCurrent,
              );
            } else if (bridgePluginId === "path-analysis") await plugins.setPathAnalysisScenario(id);
            else {
              const scenarioIndex = plugins.getNetworkKpiStatus().scenarios.findIndex(item => String(item.scid) === String(row.scenarioId ?? row.id));
              if (scenarioIndex < 0) throw new Error(`Scenario ${id} is unavailable for network KPI.`);
              await scenarioAdapters.networkKpi(scenarioIndex);
            }
            syncScenarioRoster(bridgePluginId);
            return id;
          },
          setViewMode: mode => mode,
          setKpiGeometry: (geometry, visible) => {
            if (useAppStore.getState().primaryRenderer === "cesium") throw new Error("Network geometry controls require the MapLibre renderer.");
            return persistentNetwork.setVisible(geometry, visible);
          },
          getKpiGeometryState: () => persistentNetwork.getVisibility(),
          setMapControl: (controlId, visible) => {
            if (controlId === "legend") {
              if (visible) plugins.openLegendPanel(app); else plugins.closeLegendPanel(app);
              return plugins.isLegendPanelVisible() === visible;
            }
            if (controlId === "esri-world-imagery") return setStandaloneEsriVisible(visible);
            throw new Error(`Map control ${controlId} is unavailable.`);
          },
          getMapControlState: () => ({
            legendVisible: plugins.isLegendPanelVisible(),
            esriWorldImageryVisible: getStandaloneEsriVisible(),
            renderer: useAppStore.getState().primaryRenderer === "cesium" ? "cesium" : "maplibre",
          }),
          setRenderer: renderer => {
            if (renderer === "cesium" && useAppStore.getState().primaryRenderer !== "cesium") {
              const currentMapView = mapViewFromMapLibre(app.getMap?.());
              if (currentMapView) useAppStore.getState().setMapView(currentMapView);
            }
            useAppStore.getState().setPrimaryRenderer(renderer);
            return renderer;
          },
          setNetworkFilter: () => { throw new Error("Network filters are unavailable: the original network plugins expose no Testudo filter control."); },
          getCameraView: () => {
            const center = app.getMap?.()?.getCenter?.(); const activeMap = app.getMap?.();
            if (!center || !activeMap) return null;
            return { center: [center.lng, center.lat], zoom: activeMap.getZoom?.() ?? 0, bearing: activeMap.getBearing?.() ?? 0, pitch: activeMap.getPitch?.() ?? 0 };
          },
          setCameraView: view => { app.getMap?.()?.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing ?? 0, pitch: view.pitch ?? 0 }); },
          dispose: () => { bridgePluginId = null; },
        };
        traceProviderOpen("complete");
        return session;
      },
    }), (request, signal) => requestArtifactFromParent(request, signal));
    featureBridge.setMapResolver(() => app.getMap?.() as any ?? null);
    featureBridge.createTView("main");
    featureBridge.setActiveTView("main");
    const requireMainGeneration = (payload: Record<string, unknown>) => {
      if (payload.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
      const main = featureBridge.getTViews().find(view => view.tviewId === "main");
      if (!main) throw new Error("The main TView is not ready.");
      if (payload.generation !== undefined && payload.generation !== main.generation) {
        throw new Error("This command belongs to a stale Testudo TView generation.");
      }
      return main;
    };
    const esriProjectLayer = () => useAppStore.getState().layers.find(layer => layer.id === "basemap-esri-world-imagery"
      || (layer.metadata as Record<string, unknown> | undefined)?.basemapId === "esri-world-imagery");
    const getStandaloneEsriVisible = () => {
      const projectLayer = esriProjectLayer();
      if (projectLayer) return projectLayer.visible;
      const map = app.getMap?.() as TestudoControlMap | null | undefined;
      if (map?.getLayer("testudo-esri-world-imagery")) {
        return map.getLayoutProperty("testudo-esri-world-imagery", "visibility") !== "none";
      }
      return standaloneEsriVisible;
    };
    const setStandaloneEsriVisible = (visible: boolean) => {
      const projectLayer = esriProjectLayer();
      if (projectLayer) {
        useAppStore.getState().setLayerVisibility(projectLayer.id, visible);
        standaloneEsriVisible = visible;
        return visible;
      }
      const map = app.getMap?.() as TestudoControlMap | null | undefined;
      if (!map) throw new Error("World Imagery is unavailable until the map is ready.");
      const sourceId = "testudo-esri-world-imagery";
      const layerId = sourceId;
      if (visible && !map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Tiles © Esri",
        });
      }
      if (visible && !map.getLayer(layerId)) {
        const beforeId = map.getStyle()?.layers?.find(layer => layer.id && layer.type !== "background")?.id;
        map.addLayer({ id: layerId, type: "raster", source: sourceId,
          layout: { visibility: "visible" }, paint: { "raster-opacity": 1 } }, beforeId);
      } else if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
      standaloneEsriVisible = visible;
      return visible;
    };
    const emit = (type: string, payload: unknown, target = parentOrigin) => {
      if (!disposed && target && allowed.includes(target)) window.parent.postMessage({ v: 2, source: "geolibre", type, payload }, target);
    };
    let lastEmittedMapControlState = "";
    const currentRendererReadiness = () => {
      const readiness = rendererReadinessRef.current;
      const renderer = useAppStore.getState().primaryRenderer === "cesium" ? "cesium" : "maplibre";
      return { controllerReady: readiness.ready && readiness.renderer === renderer && !readiness.error, rendererEpoch: readiness.epoch, rendererError: readiness.renderer === renderer ? readiness.error : null };
    };
    const emitMapControlState = () => {
      currentTViewRef.current = () => featureBridge.getTViews().find(view => view.tviewId === "main") ?? null;
      const main = featureBridge.getTViews().find(view => view.tviewId === "main");
      if (!main) return;
      const state = {
        tviewId: "main",
        generation: main.generation,
        legendVisible: plugins.isLegendPanelVisible(),
        // World Imagery is the project layer basemap-esri-world-imagery (or
        // metadata basemapId=esri-world-imagery); the helper also reads the
        // package-free testudo-esri-world-imagery fallback layer.
        esriWorldImageryVisible: getStandaloneEsriVisible(),
        renderer: useAppStore.getState().primaryRenderer === "cesium" ? "cesium" as const : "maplibre" as const,
        ...currentRendererReadiness(),
      };
      const signature = JSON.stringify(state);
      if (signature === lastEmittedMapControlState) return;
      lastEmittedMapControlState = signature;
      emit("testudoMapControlStateChanged", state);
    };
    unsubscribeMapControls = useAppStore.subscribe(emitMapControlState);
    mapControlsTimer = setInterval(emitMapControlState, 250);
    emitMapControlState();
    const unsubscribeBridgeGeoAI = featureBridge.subscribeGeoAIRequests(request => emit("testudoGeoAIRequest", request));
    const unsubscribePlayback = featureBridge.subscribePlayback((tviewId, playback) => {
      const session = featureBridge.sessions.get(tviewId);
      if (session && featureBridge.sessions.isCurrent({ tviewId, generation: session.context.generation })) {
        bridgePluginId = session.context.pluginId as TestudoSelectablePluginId | null;
        syncScenarioRoster(bridgePluginId);
        emit("testudoPlaybackChanged", { ...playback, tviewId, generation: session.context.generation });
      }
    });
    const relayReplies = new Map<string, (reply: plugins.TestudoGeoAIReply & { requestId: string; tviewId: string; generation: number }) => void>();
    const unsubscribeBridgeReplies = featureBridge.subscribeGeoAIReplies(reply => {
      relayReplies.get(reply.requestId)?.(reply);
      relayReplies.delete(reply.requestId);
      emit("testudoGeoAIReply", reply);
    });
    const parentOriginHint = parentOriginHintFromBrowser();
    const readyTargets = pickBroadcastTargets(null, allowed, parentOriginHint).filter(target => target !== "*");
    traceTestudoBridge("bridge-listener-install", {
      origin,
      referrer: document.referrer,
      parentOriginHint,
      allowedOrigins: allowed,
      readyTargets,
      renderer: rendererReadinessRef.current.renderer,
      rendererEpoch: rendererReadinessRef.current.epoch,
      rendererReady: rendererReadinessRef.current.ready,
      controllerApiAvailable: true,
    });
    let readyLogged = false;
    const ready = () => {
      if (!disposed) {
        if (!readyLogged) {
          readyLogged = true;
          traceTestudoBridge("ready-post", { targetCount: readyTargets.length, readyTargets });
        }
        for (const target of readyTargets) window.parent.postMessage({ v: 2, source: "geolibre", type: "ready", payload: { version: "testudo-v1", challenge } }, target);
      }
    };
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
      if (current.style) current = { ...current, style: testudoViewerStyleState(current.style, current.scenarios ?? []) };
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
        else if (plugin === "emissions-h3") mode = "environment";
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
    const closeMapPlugins = () => { for (const id of handledIds) if (id !== "geoai") handlers[id].close(); };
    const closeAllPlugins = () => { for (const id of handledIds) handlers[id].close(); };
    const suspendPresent = () => {
      if (presentSuspended) return;
      presentSuspended = { plugin: current.selectedPlugin };
      for (const stop of [() => plugins.setVehiclePlaybackSettings({ playing: false }), () => plugins.setNetworkKpiSettings({ intervalPlaying: false }),
        () => plugins.setEmissionsH3Settings({ intervalPlaying: false }), () => { void Promise.resolve(featureBridge.playback("main", "pause")).catch(() => undefined); }]) {
        try { stop(); } catch { /* no active session or plugin: nothing to pause */ }
      }
      // The independent GeoAI assistant panel is left alone. A plugin that was never opened (or has no session) may throw from close():
      // isolate each one so suspending can never abort the mode switch.
      for (const id of handledIds) { if (id === "geoai") continue; try { handlers[id].close(); } catch (error) { console.warn("[Testudo] suspend: closing " + id + " failed", error); } }
      update({ presentSuspended: true });
    };
    const resumePresent = () => {
      const held = presentSuspended;
      if (!held) return;
      presentSuspended = null;
      // Reopen the panel from the data already loaded; never reloads the package.
      if (held.plugin && directory && current.selectedPlugin === held.plugin && selectableIds.includes(held.plugin)) handlers[held.plugin].open(app);
      update({ presentSuspended: false });
    };
    const diagnosticWindow = window as Window & { __testudoLiveDiagnostics?: () => unknown };
    const liveDiagnosticsGetter = plugins.createTestudoLiveDiagnosticsGetter(
      plugins.testudoLiveDiagnosticsEnabled(import.meta.env.DEV || import.meta.env.MODE === 'test', window.location.search),
      () => {
        const session = featureBridge.sessions.get("main");
        if (!session || !featureBridge.sessions.isCurrent(session.context)) return { available: false };
        const generation = session.context.generation;
        const requestedScid = current.selectedScenarioId ?? null;
        return {
          available: true,
          tviewId: "main",
          generation,
          packageIdentity: { packageId: current.package?.packageId ?? null, versionId: current.package?.versionId ?? null },
          mode: current.selectedMode ?? null,
          requested: { scid: current.selectedScenarioId ?? null,
            scenarioA: current.style?.scenarioA ?? null, scenarioB: current.style?.scenarioB ?? null },
          results: { tviewId: "main", generation, requestedScid, ...plugins.getNetworkKpiLiveDiagnostics() },
          environment: { tviewId: "main", generation, requestedScid, ...plugins.getEmissionsH3LiveDiagnostics() },
          comparison: { tviewId: "main", generation,
            requestedPair: { scenarioA: current.style?.scenarioA ?? null, scenarioB: current.style?.scenarioB ?? null },
            ...plugins.getScenarioComparisonLiveDiagnostics() },
          animation: { tviewId: "main", generation, requestedScid, ...plugins.getVehiclePlaybackLiveDiagnostics(), trace: plugins.getVehiclePlaybackTraceSnapshot() },
        };
      },
    );
    if (liveDiagnosticsGetter) Object.defineProperty(diagnosticWindow, "__testudoLiveDiagnostics", {
      configurable: true, enumerable: false, value: liveDiagnosticsGetter,
    });
    const removeLiveDiagnostics = () => {
      if (diagnosticWindow.__testudoLiveDiagnostics === liveDiagnosticsGetter) delete diagnosticWindow.__testudoLiveDiagnostics;
    };
    const syncAssistantOpen = () => update({ assistantOpen: plugins.isGeoAiChatPanelVisible() });
    const unsubscribeAssistantPanel = plugins.subscribeGeoAiChatPanel(syncAssistantOpen);
    const scenarioRosterForPlugin = (pluginId: TestudoSelectablePluginId | null): NonNullable<TestudoFeatureSession["scenarios"]> => {
      const uniqueByScenario = (rows: Array<{ scid?: string | number; label?: string; did?: string | number; id?: string }>) => [...new Map(rows.flatMap(row => row.scid === undefined || row.scid === null ? [] : [[String(row.scid), { id: String(row.scid), label: String(row.label ?? row.scid), scenarioId: row.scid, ...(Number.isSafeInteger(Number(row.did)) ? { did: Number(row.did) } : {}) }] as const])).values()];
      if (pluginId === "vehicle-playback") { const loaded = plugins.getVehiclePlaybackStatus().scenarios; return declaredVariantScenarioRoster.length ? declaredVariantScenarioRoster : plugins.vehiclePlaybackScenarioRoster(loaded); }
      if (pluginId === "scenario-comparison") { const rows = plugins.getScenarioComparisonStatus().scenarios; return rows.length ? uniqueByScenario(rows.map(row => ({ scid: row.scid, label: row.label }))) : declaredScenarioRoster; }
      if (pluginId === "emissions-h3") { const rows = plugins.getEmissionsH3Status().scenarios; return rows.length ? rows.map(row => ({ id: String(row.id), label: row.label, ...(row.scid !== undefined ? { scenarioId: row.scid } : {}) })) : declaredScenarioRoster; }
      if (pluginId === "path-analysis") return declaredScenarioRoster;
      if (pluginId === "network-kpi") {
        const rows = plugins.getNetworkKpiStatus().scenarios;
        if (!rows.length) return declaredScenarioRoster;
        const declared = new Map(declaredScenarioRoster.map(row => [String(row.scenarioId ?? row.id), row]));
        return rows.map(row => {
          const own = declared.get(String(row.scid));
          return { ...(own ?? {}), id: String(row.scid), label: String(row.label ?? own?.label ?? row.scid), scenarioId: row.scid };
        });
      }
      return declaredScenarioRoster;
    };
    const selectedScenarioForPlugin = (pluginId: TestudoSelectablePluginId | null, roster = scenarioRosterForPlugin(pluginId)): string | undefined => {
      if (pluginId === "vehicle-playback") { const row = plugins.getVehiclePlaybackStatus().scenarios[plugins.getVehiclePlaybackStatus().scenarioIndex]; return row ? plugins.vehiclePlaybackVariantSelectionId(row) : roster[0]?.id; }
      if (pluginId === "scenario-comparison") { const index = plugins.getScenarioComparisonSnapshot().scenarioA; const row = plugins.getScenarioComparisonStatus().scenarios[index]; return row?.scid === undefined ? roster[0]?.id : String(row.scid); }
      if (pluginId === "network-kpi") { const status = plugins.getNetworkKpiStatus(); const row = status.scenarios[status.scenarioIndex]; return row?.scid === undefined ? roster[0]?.id : String(row.scid); }
      if (pluginId === "emissions-h3") { const status = plugins.getEmissionsH3Status(); return status.scenarios.find(row => row.index === status.scenarioIndex)?.id ?? roster[0]?.id; }
      return roster[0]?.id;
    };
    const loadEnvironmentScenarioData = async (scenarioId: string | number, did: number): Promise<void> => {
      const index = declaredScenarioRoster.findIndex(row => String(row.scenarioId ?? row.id) === String(scenarioId));
      if (index < 0) throw new Error(`Environment scenario ${String(scenarioId)} is not declared by this package.`);
      if (directory) await plugins.loadLocalEmissionsH3Folder(directory, index, did);
      else {
        const status = plugins.getEmissionsH3Status();
        const pluginIndex = status.scenarios.findIndex(row => String(row.scid ?? row.id) === String(scenarioId));
        if (pluginIndex < 0) throw new Error(`Environment scenario ${String(scenarioId)} is unavailable in the emissions loader.`);
        await plugins.setEmissionsH3Scenario(pluginIndex, did);
      }
      const loaded = plugins.getEmissionsH3Status();
      if (loaded.loading || loaded.error) throw new Error(loaded.error ?? "Environment data is still loading.");
      if (String(loaded.scenarios[loaded.scenarioIndex]?.scid ?? "") !== String(scenarioId)) throw new Error(`Environment loaded a different scenario than ${String(scenarioId)}.`);
      if (loaded.did !== did) throw new Error(`Environment did not load requested replication ${did}.`);
      if (!loaded.hasEmissions) throw new Error(`Environment replication ${did} contains no usable emissions rows.`);
    };
    const verifyUnknownEnvironmentScenario = async (
      scenarioId: string | number,
      coverage: { candidateDids?: number[] },
      assertCurrent: () => void,
    ) => plugins.verifyEnvironmentScenarioCandidates(
      coverage.candidateDids ?? [],
      did => loadEnvironmentScenarioData(scenarioId, did),
      () => plugins.clearEmissionsH3Scenario(scenarioId),
      assertCurrent,
    );
    const preferredEnvironmentDid = (coverage: { status: "available" | "unavailable" | "unknown"; dids: number[] }): number | undefined => {
      if (coverage.status !== "available" || !coverage.dids.length) return undefined;
      const currentDid = plugins.getEmissionsH3Snapshot().did;
      return currentDid !== null && coverage.dids.includes(currentDid) ? currentDid : coverage.dids[0];
    };
    const syncScenarioRoster = (pluginId: TestudoSelectablePluginId | null) => {
      const roster = scenarioRosterForPlugin(pluginId); const selectedScenarioId = selectedScenarioForPlugin(pluginId, roster);
      const shellRoster = roster.map(({ id, label }) => ({ id, label }));
      const session = featureBridge.sessions.get("main");
      const sessionMatches = Boolean(session && session.selectedScenarioId === selectedScenarioId && plugins.scenarioRosterMatches(session.scenarios ?? [], roster));
      if (session && !sessionMatches) { session.scenarios = roster; session.selectedScenarioId = selectedScenarioId; }
      if (current.selectedScenarioId === selectedScenarioId && plugins.scenarioRosterMatches(current.scenarios ?? [], shellRoster)) return current;
      return update({ scenarios: shellRoster, selectedScenarioId });
    };
    const select = async (id: TestudoSelectablePluginId, operation?: number, preserveScenarioId?: string | number) => {
      if (operation !== undefined) assertPackageOperation(operation);
      if (!selectableIds.includes(id)) throw new Error("Unknown map plugin");
      const capability = current.capabilities.find(item => item.id === id);
      const comparisonProbe = id === "scenario-comparison" && comparisonDeclared && !capability?.available;
      if (!capability?.available && !comparisonProbe) throw new Error(capability?.reason ?? "This plugin is unavailable for this package.");
      if (!directory) throw new Error("Select a package first.");
      presentSuspended = null; // an explicit Present selection ends the Analyse suspension
      const version = generation;
      const selection = ++selectionGeneration;
      const leavingPaths = current.selectedMode === "paths" && id !== "path-analysis";
      if (leavingPaths) persistentNetwork.setPathsMode(false, featureBridge.sessions.get("main")?.context.generation ?? generation);
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
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection
          || operation !== undefined && !ownsPackageOperation(operation)) return;
        const status = handlers[id].status();
        update(status.error ? { status: "error", error: status.error } : { status: "ready", error: undefined });
      }, error => {
        if (!timedOut || disposed || generation !== version || selectionGeneration !== selection
          || operation !== undefined && !ownsPackageOperation(operation)) return;
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
      if (operation !== undefined) assertPackageOperation(operation);
      if (disposed || generation !== version || selectionGeneration !== selection) throw new Error("Package selection changed");
      const status = handlers[id].status();
      if (id === "path-analysis" && declaredScenarioIds.length > 0) {
        await plugins.setPathAnalysisScenario(declaredScenarioIds[0]);
        if (operation !== undefined) assertPackageOperation(operation);
        if (disposed || generation !== version || selectionGeneration !== selection) throw new Error("Package selection changed");
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
      if (bridgeInstalled) {
        scenarioToPreserveOnPluginSelect = id === "network-kpi" ? preserveScenarioId : undefined;
        try { await featureBridge.selectPlugin("main", id); }
        finally { scenarioToPreserveOnPluginSelect = undefined; }
      }
      if (operation !== undefined) assertPackageOperation(operation);
      if (preserveScenarioId !== undefined && id === "network-kpi") {
        await selectScenarioInRoster(preserveScenarioId, plugins.getNetworkKpiStatus().scenarios,
          index => plugins.setNetworkKpiScenario(index), () => {
            if (operation !== undefined) assertPackageOperation(operation);
            if (disposed || generation !== version || selectionGeneration !== selection) throw new Error("Package selection changed");
          });
        const selectedKpiScenario = plugins.getNetworkKpiStatus().scenarios[plugins.getNetworkKpiStatus().scenarioIndex];
        if (String(selectedKpiScenario?.scid) !== String(preserveScenarioId)) throw new Error("The selected scenario could not be loaded in Results.");
      }
      syncScenarioRoster(id);
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
        syncScenarioRoster(bridgePluginId);
        if (typeof detail.section_id === "string" || (typeof detail.section_id === "number" && Number.isSafeInteger(detail.section_id))) {
          plugins.highlightNetworkKpiSection(detail.section_id as string | number);
        }
        update({ assistantOpen: plugins.isGeoAiChatPanelVisible(), selectedMode: undefined });
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      }
    };
    window.addEventListener("testudo-scenario-analysis-action", applyScenarioAnalysisAction);
    const selectMode = async (mode: TestudoDemoMode, rememberPreference = true, operation?: number, preserveScenarioId?: string | number) => {
      if (operation !== undefined) assertPackageOperation(operation);
      const packageOperationAtStart = packageOperation;
      if (!current.availableModes.includes(mode)) {
        const capabilityId = mode === "animation" ? "vehicle-playback" : mode === "paths" ? "path-analysis" : mode === "environment" ? "emissions-h3" : mode === "comparison" ? "scenario-comparison" : "network-kpi";
        const reason = current.capabilities.find(item => item.id === capabilityId)?.reason;
        throw new Error(reason ?? (mode === "comparison" ? "Scenario comparison requires a declared scenario pair and at least one matched interval."
          : mode === "environment" ? "Environment mode requires usable CO2, NOx, or noise data."
          : mode === "animation" ? "Animation requires at least one playable scenario."
          : mode === "paths" ? "Path analysis requires a scenario path index." : "Results mode requires a supported network KPI."));
      }
      if (rememberPreference) preferredMode = mode;
      const target = modes.find(item => item.id === mode) ?? { id: mode, plugin: pluginForTestudoMode(mode) };
      const result = current.status === "ready" && current.selectedPlugin === target.plugin ? current : await select(target.plugin, operation, preserveScenarioId);
      if (operation !== undefined) assertPackageOperation(operation);
      if (packageOperation !== packageOperationAtStart) throw new Error("Package selection changed");
      const selectionAtStart = selectionGeneration;
      const sessionAtStart = featureBridge.sessions.get("main") ?? null;
      const assertSelectionCurrent = () => {
        if (operation !== undefined) assertPackageOperation(operation);
        if (packageOperation !== packageOperationAtStart || selectionGeneration !== selectionAtStart
          || (sessionAtStart && featureBridge.sessions.get("main") !== sessionAtStart)) {
          throw new Error("Package selection changed");
        }
      };
      if (mode === "animation") {
        const playback = plugins.getVehiclePlaybackStatus();
        if (await initializeFirstAnimationScenarioIfNeeded(playback.scenarioIndex, playback.scenarios.length, index => plugins.setVehiclePlaybackScenario(index))) assertSelectionCurrent();
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
        const scenarioId = current.selectedScenarioId;
        const coverage = scenarioId === undefined ? { status: "unknown" as const, dids: [] } : environmentScenarioCoverage.byScid[String(scenarioId)] ?? { status: "unknown" as const, dids: [] };
        if (coverage.status === "unavailable") throw new Error("Environment mode is unavailable: the selected scenario has no usable emissions data.");
        if (coverage.status === "available") {
          const expectedDid = preferredEnvironmentDid(coverage)!;
          const emissionStatus = plugins.getEmissionsH3Status();
          if (String(emissionStatus.scenarios[emissionStatus.scenarioIndex]?.scid ?? "") !== String(scenarioId)
              || emissionStatus.did !== expectedDid) {
            await loadEnvironmentScenarioData(scenarioId!, expectedDid);
            assertSelectionCurrent();
          }
          const committed = plugins.getEmissionsH3Status();
          if (committed.did !== expectedDid) throw new Error(`Environment did not load requested replication ${expectedDid}.`);
          if (committed.loading || committed.error || !committed.hasEmissions) throw new Error(committed.error ?? `Environment replication ${expectedDid} contains no usable emissions rows.`);
        } else await verifyUnknownEnvironmentScenario(scenarioId!, coverage, assertSelectionCurrent);
      }
      const viewMode = current.viewModes?.[mode as "results" | "comparison" | "environment"];
      const defaultMetric = viewMode?.style.id === "cmp_flow_delta" ? "flow_delta" : viewMode?.style.id === "delay" || viewMode?.column === "dtime" ? "delay" : (viewMode?.column ?? "flow");
      const pair = mode === "comparison" ? plugins.getScenarioComparisonStatus().scenarios : [];
      const comparisonSettings = mode === "comparison" ? plugins.getScenarioComparisonSnapshot() : undefined;
      const pairA = comparisonSettings?.scenarioA ?? (viewMode?.scenarioDidPair?.[0] ? pair.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![0].scid)) : -1);
      const pairB = comparisonSettings?.scenarioB ?? (viewMode?.scenarioDidPair?.[1] ? pair.findIndex(row => String(row.scid) === String(viewMode.scenarioDidPair![1].scid)) : -1);
      const style = viewMode || mode === "comparison" ? {
        display: viewMode?.style.type ?? "ramp", metric: defaultMetric, interval: comparisonSettings?.interval ?? 0,
        maxHeightM: viewMode?.style.max ?? comparisonSettings?.maxHeightM ?? 100,
        ...(pairA >= 0 ? { scenarioA: String(pair[pairA]?.scid ?? pairA) } : {}),
        ...(pairB >= 0 ? { scenarioB: String(pair[pairB]?.scid ?? pairB) } : {}),
        ...(mode === "comparison" ? { showDifference: comparisonSettings?.mode === "diff" } : {}),
      } : current.style;
      assertSelectionCurrent();
      const activeSessionGeneration = sessionAtStart?.context.generation ?? generation;
      if (mode === "paths") persistentNetwork.setPathsMode(true, activeSessionGeneration);
      else if (current.selectedMode === "paths") persistentNetwork.setPathsMode(false, activeSessionGeneration);
      update({ ...result, selectedMode: mode, ...(style ? { style } : {}) });
      const finalized = await finalizeModeSelection({
        syncScenarioRoster: () => { syncScenarioRoster(target.plugin); },
        synchronizeViewMode: async () => {
          if (bridgeInstalled) await featureBridge.setViewMode("main", mode, sessionAtStart?.context.generation);
        },
        publishPlayback: () => {
          if (!bridgeInstalled) return;
          const session = featureBridge.sessions.get("main");
          if (session) emit("testudoPlaybackChanged", { ...featureBridge.getPlaybackState("main", session.context.generation), tviewId: "main", generation: session.context.generation });
        },
        assertCurrent: assertSelectionCurrent,
        getCurrentState: () => current,
      });
      window.dispatchEvent(new CustomEvent("testudo-view-mode-changed", { detail: { mode, generation: activeSessionGeneration } }));
      return finalized;
    };
    modeSelector.current = async mode => {
      if (commandGate.packageBusy || commandGate.commandBusy) return current;
      const operationAtStart = packageOperation;
      const commandOwner = commandGate.beginCommand("testudoSetMode");
      try { return await selectMode(mode); }
      finally { if (operationAtStart === packageOperation) commandGate.finishCommand(commandOwner); }
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
      featureBridge.unloadPackage("main");
      void plugins.setTestudoResultsSessionKey(null);
      bridgeInstalled = false;
      bridgePluginId = null;
      comparisonDeclared = false;
      preferredMode = undefined;
      declaredAvailableModes = [];
      analysis.setPackage(null);
      packageFitter.reset(); presentSuspended = null;
      closeAllPlugins(); directory = null; bootstrap = null; declaredScenarioIds = []; declaredScenarioRoster = []; declaredVariantScenarioRoster = []; environmentScenarioCoverage = { byScid: {}, packageEligible: true }; environmentPackageEligible = true;
      persistentNetwork.clear();
      plugins.resetGeoAiChat();
      plugins.resetGeoAiBuildings();
      resetTestudoPanels();
      update({ ...empty, panels: { ...TESTUDO_PANELS_DEFAULT } });
    };
    const load = async (payload: TestudoLoadPackage, operation: number) => {
      const packageLoadStartedAt = performance.now();
      const tracePackageLoadStage = (stage: string, phase: "start" | "complete") =>
        traceTestudoBridge("package-load-stage", { stage, phase, elapsedMs: Math.round(performance.now() - packageLoadStartedAt) });
      const candidate = payload?.bootstrap && validateTestudoBootstrap(payload.bootstrap, !!guestCredential);
      if (!candidate || containsCredentialField(payload) || (guestCredential && payload.challenge !== challenge)) throw new Error("Invalid Testudo package bootstrap");
      assertPackageOperation(operation);
      reset(); bootstrap = candidate;
      packageFitter.begin(candidate.versionId); packageFitter.watch((app.getMap?.() as unknown as plugins.PackageFitMap | null) ?? null);
      analysis.setPackage(guestCredential ? null : candidate.analysis, candidate.versionId);
      comparisonDeclared = candidate.capabilities.some(item => item.id === "scenario-comparison" && item.available);
      const getGuestEmbedToken = guestCredential ? () => {
        if (!guestCredential || guestCredential.expiresAt <= Date.now()) throw new Error("Guest demo access expired; refresh the package to continue.");
        return guestCredential.token;
      } : undefined;
      const byteOrigins = getGuestEmbedToken ? (readDeploymentEnvValue("VITE_TESTUDO_BYTE_ORIGINS") ?? "").split(/[\s,]+/).filter(Boolean).map(value => new URL(value).origin) : [];
      if (getGuestEmbedToken && !byteOrigins.length) throw new Error("Package byte origin is not configured");
      assertPackageOperation(operation);
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
      const defaultPlugin = payload.selectedPlugin ?? safeCapabilities.find(item => item.available && item.id !== "geoai" && !isTestudoAnalysisCapabilityId(item.id))?.id as TestudoSelectablePluginId | undefined ?? null;
      tracePackageLoadStage("feature-session-install", "start");
      const featureContext = await installFeatureSession(candidate, defaultPlugin, "published");
      tracePackageLoadStage("feature-session-install", "complete");
      assertPackageOperation(operation);
      tracePackageLoadStage("results-session-key", "start");
      await plugins.setTestudoResultsSessionKey(`${candidate.packageId}:${featureContext.generation}`);
      tracePackageLoadStage("results-session-key", "complete");
      assertPackageOperation(operation);
      tracePackageLoadStage("network-kpi-manifest-read", "start");
      const raw = await readLocalNetworkKpiManifestJson(directory);
      tracePackageLoadStage("network-kpi-manifest-read", "complete");
      assertPackageOperation(operation);
      tracePackageLoadStage("persistent-network-mount", "start");
      await persistentNetwork.mount(featureContext, directory, raw, app.getMap?.() as any,
        context => featureBridge.sessions.isCurrent(context));
      tracePackageLoadStage("persistent-network-mount", "complete");
      assertPackageOperation(operation);
      const pkg = getGeolibrePackage(raw);
      environmentScenarioCoverage = plugins.resolveEnvironmentScenarioCoverage(pkg, raw);
      const packageScenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
      declaredScenarioIds = [...new Set(packageScenarios.map(item => item.scid).filter((id): id is string | number => id !== undefined))];
      declaredVariantScenarioRoster = plugins.vehiclePlaybackScenarioRoster(packageScenarios);
      declaredScenarioRoster = plugins.testudoScenarioCatalog(pkg?.scenarios ?? []);
      let hasMatchedComparison = false;
      if (pkg?.viewModes.comparison && pkg.scenarios.length > 1) {
        handlers["scenario-comparison"].open(app);
        try {
          tracePackageLoadStage("scenario-comparison-load", "start");
          await plugins.loadLocalScenarioComparisonFolder(directory);
          tracePackageLoadStage("scenario-comparison-load", "complete");
          assertPackageOperation(operation);
          const comparison = plugins.getScenarioComparisonStatus();
          hasMatchedComparison = Boolean(comparison.timelineA && comparison.timelineB && comparison.matchedIntervals.length > 0);
        } finally { if (ownsPackageOperation(operation)) handlers["scenario-comparison"].close(); }
      }
      if (pkg?.viewModes.environment && environmentScenarioCoverage.packageEligible) {
        const availableScenario = pkg.scenarios.find(scenario => environmentScenarioCoverage.byScid[String(scenario.scid)]?.status === "available");
        const availableScenarioIndex = availableScenario ? pkg.scenarios.indexOf(availableScenario) : -1;
        const preferredDid = availableScenario ? environmentScenarioCoverage.byScid[String(availableScenario.scid)]?.dids[0] : undefined;
        if (availableScenario && preferredDid !== undefined) {
        handlers["emissions-h3"].open(app);
        try {
          tracePackageLoadStage("emissions-load", "start");
          await plugins.loadLocalEmissionsH3Folder(directory, availableScenarioIndex, preferredDid);
          tracePackageLoadStage("emissions-load", "complete");
          assertPackageOperation(operation);
        }
        finally { if (ownsPackageOperation(operation)) handlers["emissions-h3"].close(); }
        }
      }
      const hasAnimation = packageScenarios.length > 0;
      const root = raw as Record<string, unknown>;
      const resolvedPathIndex = plugins.parsePathAnalysisManifest(raw, null).pathIndex;
      const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
      const contracts = pkg?.dataContracts ?? {};
      const knownColumns = Object.values(contracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
      const hasMetric = (metric: "flow" | "density") => Object.hasOwn(ramps, metric) || knownColumns.some(column => column === metric);
      const resultsCapability = reconcileResultsCapability(current.capabilities, Boolean(pkg?.viewModes.results));
      const pathCapability = reconcilePathCapability(current.capabilities, Boolean(resolvedPathIndex));
      const availableModes = availableTestudoModes({
        animation: safeCapabilities.some(item => item.id === "vehicle-playback" && item.available) && hasAnimation,
        flow: safeCapabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("flow"),
        density: safeCapabilities.some(item => item.id === "network-kpi" && item.available) && hasMetric("density"),
        results: resultsCapability.available,
        comparison: hasMatchedComparison,
        environment: reconcileEnvironmentCapability(current.capabilities, Boolean(pkg?.viewModes.environment), environmentScenarioCoverage.packageEligible).available,
        paths: pathCapability.available,
      });
      declaredAvailableModes = [...availableModes];
      const initialMode = availableModes.includes("animation") ? "animation" : availableModes[0];
      const initialPlugin = payload.selectedPlugin ?? (initialMode ? (modes.find(item => item.id === initialMode)?.plugin ?? pluginForTestudoMode(initialMode)) : undefined);
      const initialScenarioRoster = scenarioRosterForPlugin(initialPlugin ?? null);
      const initialScenarioId = selectedScenarioForPlugin(initialPlugin ?? null, initialScenarioRoster);
      const matchedReason = "Scenario comparison is unavailable: this package has no matched simulation intervals.";
      comparisonDeclared = hasMatchedComparison;
      const environmentCapability = reconcileEnvironmentCapability(current.capabilities, Boolean(pkg?.viewModes.environment), environmentScenarioCoverage.packageEligible);
      environmentPackageEligible = environmentCapability.available;
      const finalCapabilities = reconcileResultsCapability(reconcilePathCapability(environmentCapability.capabilities,
        Boolean(resolvedPathIndex)).capabilities.map(item => item.id === "scenario-comparison"
        ? { ...item, available: hasMatchedComparison, reason: hasMatchedComparison ? undefined : matchedReason }
        : item), Boolean(pkg?.viewModes.results)).capabilities;
      update({ availableModes, viewModes: pkg?.viewModes, timeAxis: pkg?.timeAxis ?? undefined, scenarios: initialScenarioRoster.map(({ id, label }) => ({ id, label })), selectedScenarioId: initialScenarioId,
        capabilities: finalCapabilities });
      const installedSession = featureBridge.sessions.get("main");
      if (installedSession) {
        installedSession.capabilities = finalCapabilities.map(item => ({ ...item })) as TestudoFeatureSession["capabilities"];
        installedSession.availableModes = [...availableModes] as TestudoFeatureSession["availableModes"];
        installedSession.scenarios = initialScenarioRoster;
        installedSession.selectedScenarioId = initialScenarioId;
      }
      const viewerKind = resolveTestudoViewerKind(initialPlugin, guestCredential ? null : candidate.analysis);
      if (viewerKind === "analysis-only" || !initialPlugin) {
        // Analysis-only package: no map plugin to initialise; keep package identity and the analysis grant.
        tracePackageLoadStage("initial-mode-and-plugin-selection", "complete");
        update({ selectedPlugin: null, selectedMode: undefined, status: "ready", error: undefined });
        return current;
      }
      const modeForPlugin: Partial<Record<TestudoSelectablePluginId, TestudoDemoMode>> = { "vehicle-playback": "animation", "network-kpi": "results", "scenario-comparison": "comparison", "emissions-h3": "environment", "path-analysis": "paths" };
      const requestedMode = payload.selectedPlugin ? modeForPlugin[payload.selectedPlugin] : initialMode;
      tracePackageLoadStage("initial-mode-and-plugin-selection", "start");
      if (requestedMode && availableModes.includes(requestedMode)) {
        if (payload.selectedPlugin) { await select(initialPlugin, operation); assertPackageOperation(operation); }
        await selectMode(requestedMode, true, operation);
      } else await select(initialPlugin, operation);
      tracePackageLoadStage("initial-mode-and-plugin-selection", "complete");
      assertPackageOperation(operation);
      fitPackageView(candidate.versionId, raw);
      if (payload.presetId) {
        tracePackageLoadStage("preset-application", "start");
        await applyPreset(payload.presetId);
        tracePackageLoadStage("preset-application", "complete");
      }
      assertPackageOperation(operation);
      return current;
    };
    picker.current = async (selected, requestedOperation) => {
      const operation = requestedOperation ?? ++packageOperation;
      commandGate.beginPackage(operation);
      let didInvalidate = false;
      try {
        // Validate before discarding the previous selection; cancellation never enters this function.
        const raw = await readLocalNetworkKpiManifestJson(selected);
        assertPackageOperation(operation);
        const pkg = getGeolibrePackage(raw);
        if (!pkg) throw new Error("Choose a built Testudo package containing manifest.json and geolibre/package.json. Raw models must be built first.");
        reset(); didInvalidate = true; assertPackageOperation(operation); directory = selected; environmentScenarioCoverage = plugins.resolveEnvironmentScenarioCoverage(pkg, raw);
        const localPackageScenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
        declaredScenarioIds = [...new Set(localPackageScenarios.map(item => item.scid).filter((id): id is string | number => id !== undefined))];
        declaredVariantScenarioRoster = plugins.vehiclePlaybackScenarioRoster(localPackageScenarios);
        declaredScenarioRoster = plugins.testudoScenarioCatalog(pkg.scenarios);
        // Local folder loads have no Testudo session (no origin or chat credential), so GeoAI
        // cannot reach the Testudo chat routes here — the alias intentionally never matches a
        // `pkg.capabilities` key, keeping "geoai" unavailable with a clear reason.
        const aliases: Record<TestudoCapabilityId, string> = { "vehicle-playback": "animation", "network-kpi": "results", "path-analysis": "paths", "emissions-h3": "results", "scenario-comparison": "results", "geoai": "", "geoai-buildings": "", "analysis-counts": "", "analysis-od": "", "analysis-journey-time": "" };
        const emissions = pkg.dataContracts.emissions as { status?: string; reason?: string } | undefined;
        const comparisonCount = pkg.scenarios.reduce((count, scenario) => count + Math.max(1, scenario.replications.length), 0);
        let capabilities = ids.map(id => ({ id, available: id !== "geoai" && id !== "geoai-buildings" && !isTestudoAnalysisCapabilityId(id) && pkg.capabilities[aliases[id]]?.state === "available"
          && (id !== "emissions-h3" || emissions?.status === "available")
          && (id !== "scenario-comparison" || comparisonCount > 1), reason: id === "geoai"
            ? "GeoAI chat is only available for packages loaded from Testudo, not local folders."
            : id === "geoai-buildings"
            ? "GeoAI building detection is only available for packages loaded from Testudo, not local folders."
            : isTestudoAnalysisCapabilityId(id)
            ? "Analysis is only available for packages loaded from Testudo, not local folders."
            : id === "emissions-h3"
            ? emissions?.reason ?? pkg.capabilities[aliases[id]]?.reason ?? "No usable emissions data is declared for this package." : pkg.capabilities[aliases[id]]?.reason ?? "No compatible dataset declared." }));
        const initialResultsCapability = reconcileResultsCapability(capabilities, Boolean(pkg.viewModes.results));
        capabilities = initialResultsCapability.capabilities;
        const initialEnvironmentCapability = reconcileEnvironmentCapability(capabilities, Boolean(pkg.viewModes.environment), environmentScenarioCoverage.packageEligible);
        capabilities = initialEnvironmentCapability.capabilities;
        environmentPackageEligible = initialEnvironmentCapability.available;
        comparisonDeclared = capabilities.some(item => item.id === "scenario-comparison" && item.available);
        const root = raw as Record<string, unknown>;
        const resolvedPathIndex = plugins.parsePathAnalysisManifest(raw, null).pathIndex;
        const pathCapability = reconcilePathCapability(capabilities, Boolean(resolvedPathIndex));
        capabilities = pathCapability.capabilities;
        const ramps = root.default_ramps && typeof root.default_ramps === "object" ? root.default_ramps as Record<string, unknown> : {};
        const knownColumns = Object.values(pkg.dataContracts).flatMap(value => value && typeof value === "object" && Array.isArray((value as { columns?: unknown }).columns) ? (value as { columns: unknown[] }).columns : []);
        let availableModes = availableTestudoModes({
          animation: capabilities.some(item => item.id === "vehicle-playback" && item.available) && listVehicleManifestScenarios(raw, { includeAnimationVariants: true }).length > 0,
          flow: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "flow") || knownColumns.includes("flow")),
          density: capabilities.some(item => item.id === "network-kpi" && item.available) && (Object.hasOwn(ramps, "density") || knownColumns.includes("density")),
          results: initialResultsCapability.available,
          comparison: capabilities.some(item => item.id === "scenario-comparison" && item.available) && Boolean(pkg.viewModes.comparison?.scenarioDidPair?.length && (pkg.timeAxis?.intervals ?? 0) > 0),
          environment: environmentPackageEligible,
          paths: pathCapability.available,
        });
        declaredAvailableModes = [...availableModes];
        const initial = availableModes[0];
        if (!initial) throw new Error("This folder declares no supported viewer datasets");
        const initialPlugin = pluginForTestudoMode(initial);
        const initialScenarioRoster = scenarioRosterForPlugin(initialPlugin);
        const initialScenarioId = selectedScenarioForPlugin(initialPlugin, initialScenarioRoster);
        update({ package: { packageId: crypto.randomUUID(), versionId: null, label: selected.name, origin: "local" }, capabilities, availableModes, viewModes: pkg.viewModes, timeAxis: pkg.timeAxis ?? undefined, scenarios: initialScenarioRoster.map(({ id, label }) => ({ id, label })), selectedScenarioId: initialScenarioId, status: "loading" });
        const localBootstrap = { packageId: current.package!.packageId, versionId: "local", label: selected.name,
          origin: "published" as const, manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
          artifactEndpoint: "", capabilities: capabilities.filter(item => featureCapabilityIds.includes(item.id)), presets: [] };
        const localReader = async (artifactRef: string) => (await (await directory!.getFileHandle(artifactRef)).getFile()).arrayBuffer();
        const featureContext = await installFeatureSession(localBootstrap, null, "local", localReader);
        assertPackageOperation(operation);
        await plugins.setTestudoResultsSessionKey(`${localBootstrap.packageId}:${featureContext.generation}`);
        assertPackageOperation(operation);
        await persistentNetwork.mount(featureContext, directory, raw, app.getMap?.() as any,
          context => featureBridge.sessions.isCurrent(context));
        assertPackageOperation(operation);
        let hasMatchedComparison = false;
        if (pkg.viewModes.comparison && pkg.scenarios.length > 1) {
          handlers["scenario-comparison"].open(app);
          try {
            await plugins.loadLocalScenarioComparisonFolder(directory);
            assertPackageOperation(operation);
            const comparison = plugins.getScenarioComparisonStatus();
            hasMatchedComparison = Boolean(comparison.timelineA && comparison.timelineB && comparison.matchedIntervals.length > 0);
          } finally { if (ownsPackageOperation(operation)) handlers["scenario-comparison"].close(); }
        }
        comparisonDeclared = hasMatchedComparison;
        if (hasMatchedComparison && !availableModes.includes("comparison")) availableModes = [...availableModes, "comparison"];
        if (!hasMatchedComparison) availableModes = availableModes.filter(mode => mode !== "comparison");
        update({ availableModes, capabilities: current.capabilities.map(item => item.id === "scenario-comparison" ? { ...item, available: hasMatchedComparison, reason: hasMatchedComparison ? undefined : "Scenario comparison is unavailable: this package has no matched simulation intervals." } : item) });
        if (pkg.viewModes.environment && environmentScenarioCoverage.packageEligible) {
          const availableScenario = pkg.scenarios.find(scenario => environmentScenarioCoverage.byScid[String(scenario.scid)]?.status === "available");
          const availableScenarioIndex = availableScenario ? pkg.scenarios.indexOf(availableScenario) : -1;
          const preferredDid = availableScenario ? environmentScenarioCoverage.byScid[String(availableScenario.scid)]?.dids[0] : undefined;
          if (availableScenario && preferredDid !== undefined) {
          handlers["emissions-h3"].open(app);
          try {
            await plugins.loadLocalEmissionsH3Folder(directory, availableScenarioIndex, preferredDid);
            assertPackageOperation(operation);
          }
          finally { if (ownsPackageOperation(operation)) handlers["emissions-h3"].close(); }
          }
        }
        const resultsCapability = reconcileResultsCapability(capabilities, Boolean(pkg.viewModes.results));
        const environmentCapability = reconcileEnvironmentCapability(resultsCapability.capabilities, Boolean(pkg.viewModes.environment), environmentScenarioCoverage.packageEligible);
        environmentPackageEligible = environmentCapability.available;
        availableModes = environmentCapability.available
          ? availableModes.includes("environment") ? availableModes : [...availableModes, "environment"]
          : availableModes.filter(mode => mode !== "environment");
        update({ availableModes, capabilities: environmentCapability.capabilities });
        const installedSession = featureBridge.sessions.get("main");
        if (installedSession) {
          installedSession.capabilities = environmentCapability.capabilities.map(item => ({ ...item })) as TestudoFeatureSession["capabilities"];
          installedSession.availableModes = [...availableModes] as TestudoFeatureSession["availableModes"];
          installedSession.scenarios = initialScenarioRoster;
          installedSession.selectedScenarioId = initialScenarioId;
        }
        await selectMode(initial, true, operation);
        assertPackageOperation(operation);
        fitPackageView(`local:${current.package?.packageId ?? ""}`, raw);
      } catch (error) {
        if (ownsPackageOperation(operation)) {
          const detail = error instanceof Error ? error.message : String(error);
          if (didInvalidate) { reset(); update({ status: "error", error: detail }); }
          else if (current.status === "loading") { reset(); update({ status: "error", error: detail }); }
          throw error;
        }
        throw error;
      } finally { commandGate.finishPackage(operation); }
    };
    const loadPickedLocalPackage = async (selected: VehicleDirectoryHandle, operation: number) => {
      if (!picker.current) throw new Error("The local package loader is not ready.");
      await picker.current(selected, operation);
      assertPackageOperation(operation);
      return current;
    };
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
      const isPlaybackCommand = request.type === "testudoSetPlaybackPlaying";
      if (isPlaybackCommand) {
        const playbackStatus = plugins.getVehiclePlaybackStatus();
        const selectedVariant = playbackStatus.scenarios[playbackStatus.scenarioIndex];
        const traceSnapshot = plugins.getVehiclePlaybackTraceSnapshot();
        tracePlaybackCommand("native-command-received", {
          requestId: String(request.requestId ?? "").slice(0, 128),
          type: request.type,
          generation: Number.isSafeInteger(request.payload?.generation) ? request.payload.generation : null,
          variantId: selectedVariant?.variantId ?? selectedVariant?.id ?? null,
          loadToken: traceSnapshot?.loadToken ?? null,
          playing: request.payload?.playing === true,
        });
      }
      if (request.type === "testudoOpenLocalPackage") {
        if (seenLocalPackageRequests.has(request.requestId)) return;
        seenLocalPackageRequests.add(request.requestId);
        if (seenLocalPackageRequests.size > 128) seenLocalPackageRequests.delete(seenLocalPackageRequests.values().next().value!);
      }
      if (request.type === "testudoLoadPackage" || request.type === "testudoOpenLocalPackage") {
        window.dispatchEvent(createTestudoSupersedeStartupProjectEvent(request.requestId));
      }
      parentOrigin = event.origin;
      if (request.type === "testudoSetGuestCapability") {
        guestCredential = { token: request.payload.guestEmbedToken, expiresAt: request.payload.expiresAt };
        emit("ack", { requestId: request.requestId, ok: true, result: { protocol: 1, challenge, expiresAt: guestCredential.expiresAt } });
        return;
      }
      if (request.type === "testudoRequestInvestigation") {
        requestInvestigation(request);
        return;
      }
      const packageRequest = request.type === "testudoLoadPackage" || request.type === "testudoOpenLocalPackage";
      const operation = packageRequest ? ++packageOperation : null;
      const operationAtStart = packageOperation;
      if (operation !== null) commandGate.beginPackage(operation);
      const run = async () => {
        if (request.payload?.tviewId !== undefined && request.payload.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
        if (request.type === "testudoOpenLocalPackage") {
          requireMainGeneration(request.payload);
          if (!isVehicleDirectoryHandle(request.payload.directoryHandle)) throw new Error("A valid local package directory handle is required.");
          return await loadPickedLocalPackage(request.payload.directoryHandle, operation!);
        }
        if (request.type === "testudoLoadPackage") return await load(request.payload, operation!);
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
        if (request.type === "testudoSetPanels") {
          // Layout-only and idempotent (latest call wins): usable before a package loads and with selectedPlugin null.
          if (!isSetPanelsPayload(request.payload)) throw new Error("testudoSetPanels needs boolean layers, plugins and comments (optional boolean results, layersCollapsed, hostGeoAi); unknown keys are rejected.");
          const next = setTestudoPanels(testudoPanelsFromPayload(request.payload));
          return update({ panels: { ...next } });
        }
        if (request.type === "testudoSetPresentSuspended") {
          // Idempotent and not gated: it only opens/closes already loaded Present panels (never reloads data).
          if (!isSetPresentSuspendedPayload(request.payload)) throw new Error("testudoSetPresentSuspended needs a boolean suspended (optional tviewId main); unknown keys are rejected.");
          if (commandGate.packageBusy) throw new Error("The viewer is loading a package. Please wait.");
          if (request.payload.suspended) suspendPresent(); else resumePresent();
          return current;
        }
        if (request.type === "testudoSetActiveTView") {
          if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
          return featureBridge.setActiveTView("main");
        }
        if (request.type === "testudoGetActiveTView") return featureBridge.getActiveTView();
        if (request.type === "testudoOpenAnalysis" || request.type === "testudoCloseAnalysis" || request.type === "testudoRefreshAnalysisGrant" || request.type === "testudoSetAnalysisTime") {
          // Not under the command gate: closing must stay possible while an open is still loading.
          if (commandGate.packageBusy) throw new Error("The viewer is loading a package. Please wait.");
          if (guestCredential) throw new Error("Analysis is not available to guest sessions.");
          if (request.type === "testudoCloseAnalysis") return analysis.close(request.payload);
          if (request.type === "testudoRefreshAnalysisGrant") return analysis.refreshGrant(request.payload);
          if (request.type === "testudoSetAnalysisTime") return analysis.setTime(request.payload);
          if (!current.package) throw new Error("Select a package first.");
          return await analysis.open(request.payload);
        }
        const commandOwner = commandGate.beginCommand(request.type);
        try {
          if (request.type === "testudoDestroyTView") {
            if (request.payload?.tviewId !== "main") throw new Error("This Testudo shell exposes only the main TView.");
            reset();
            featureBridge.close("main");
            const tview = featureBridge.createTView("main");
            featureBridge.setActiveTView("main");
            return tview;
          }
          if (request.type === "testudoSetPlugin") {
            const id = String(request.payload?.id ?? "");
            return await routeTestudoPluginSelection(
              id,
              mode => selectMode(mode),
              pluginId => select(pluginId as TestudoSelectablePluginId),
            );
          }
          if (request.type === "testudoSetMode") return await selectMode(request.payload.mode);
          if (request.type === "testudoSetScenario") {
            const generationExpected = request.payload?.generation;
            if (request.payload?.tviewId !== undefined && request.payload.tviewId !== "main") throw new Error("Scenario command targets an unsupported TView.");
            if (generationExpected !== undefined && generationExpected !== generation) throw new Error("Scenario command belongs to a stale package generation.");
            const packageOperationAtStart = packageOperation;
            const generationAtStart = generation;
            const sessionAtStart = featureBridge.sessions.get("main") ?? null;
            const assertScenarioRequestCurrent = () => {
              if (disposed || packageOperation !== packageOperationAtStart || generation !== generationAtStart
                || (sessionAtStart && !featureBridge.sessions.isCurrent(sessionAtStart.context))) throw new Error("Scenario command belongs to a stale package generation.");
            };
            const selectionId = await featureBridge.selectScenario("main", String(request.payload?.scenarioId), generationExpected as number | undefined);
            assertScenarioRequestCurrent();
            syncScenarioRoster(bridgePluginId);
            const selectedScenario = featureBridge.sessions.get("main")?.scenarios?.find(row => row.id === selectionId);
            const scenarioId = String(selectedScenario?.scenarioId ?? selectionId);
            if (current.viewModes?.environment) {
              const coverage = environmentScenarioCoverage.byScid[scenarioId] ?? { status: "unknown" as const, dids: [] };
              if (coverage.status === "available") {
                const expectedDid = preferredEnvironmentDid(coverage)!;
                await loadEnvironmentScenarioData(scenarioId, expectedDid);
                assertScenarioRequestCurrent();
                const loadedEmissions = plugins.getEmissionsH3Status();
                if (loadedEmissions.did !== expectedDid) throw new Error(`Environment did not load requested replication ${expectedDid}.`);
              } else if (coverage.status === "unavailable") {
                plugins.clearEmissionsH3Scenario(scenarioId);
              } else {
                await verifyUnknownEnvironmentScenario(scenarioId, coverage, assertScenarioRequestCurrent);
              }
              assertScenarioRequestCurrent();
              const hasEmissions = coverage.status === "available" || coverage.status === "unknown" && environmentPackageEligible;
              const declaredReason = current.capabilities.find(item => item.id === "emissions-h3")?.reason;
              const reason = !environmentPackageEligible && declaredReason
                ? declaredReason
                : coverage.status === "unavailable"
                  ? "Environment mode is unavailable for this scenario because it has no usable emissions rows."
                  : declaredReason;
              const scenarioModeState = modeForScenarioChange(declaredAvailableModes, hasEmissions && environmentPackageEligible, preferredMode, current.selectedMode);
              const availableModes = scenarioModeState.availableModes;
              const capabilities = current.capabilities.map(item => item.id === "emissions-h3" ? { ...item, available: hasEmissions && environmentPackageEligible, ...(hasEmissions && environmentPackageEligible ? { reason: undefined } : reason ? { reason } : {}) } : item);
              const activeSession = featureBridge.sessions.get("main");
              if (activeSession) { activeSession.availableModes = availableModes; activeSession.capabilities = capabilities.filter(item => featureCapabilityIds.includes(item.id)) as TestudoFeatureSession["capabilities"]; }
              const selectedMode = current.selectedMode;
              update({ selectedScenarioId: selectionId, availableModes, capabilities });
              if (scenarioModeState.selectedMode && scenarioModeState.selectedMode !== selectedMode) {
                await selectMode(scenarioModeState.selectedMode, false, packageOperationAtStart,
                  scenarioModeState.selectedMode === "results" ? scenarioId : undefined);
                assertScenarioRequestCurrent();
              }
            } else update({ selectedScenarioId: selectionId });
            const finalScenario = featureBridge.sessions.get("main")?.scenarios?.find(row => row.id === current.selectedScenarioId);
            const finalScenarioId = current.selectedScenarioId ?? selectionId;
            return { scenarioId: finalScenarioId, modelScenarioId: finalScenario?.scenarioId ?? selectedScenario?.scenarioId };
          }
          if (request.type === "testudoSetStyle") {
            if (request.payload?.tviewId !== "main" || request.payload?.generation !== generation) throw new Error("Style command belongs to a stale package generation.");
            const styleGeneration = generation;
            const comparisonScenarios = current.selectedMode === "comparison" ? plugins.getScenarioComparisonStatus().scenarios : undefined;
            const style = validateTestudoStyle(request.payload?.style, current.selectedMode, declaredScenarioIds.length, comparisonScenarios);
            const comparisonSnapshot = current.selectedMode === "comparison" ? plugins.getScenarioComparisonSnapshot() : undefined;
            const scenarioA = style.scenarioA ?? (current.style?.scenarioA === undefined ? comparisonSnapshot?.scenarioA : validateTestudoStyle({ ...style, scenarioA: current.style.scenarioA }, current.selectedMode, declaredScenarioIds.length, current.selectedMode === "comparison" ? plugins.getScenarioComparisonStatus().scenarios : undefined).scenarioA);
            const scenarioB = style.scenarioB ?? (current.style?.scenarioB === undefined ? comparisonSnapshot?.scenarioB : validateTestudoStyle({ ...style, scenarioB: current.style.scenarioB }, current.selectedMode, declaredScenarioIds.length, current.selectedMode === "comparison" ? plugins.getScenarioComparisonStatus().scenarios : undefined).scenarioB);
            const showDifference = style.showDifference ?? current.style?.showDifference ?? (scenarioA !== undefined || scenarioB !== undefined);
            const { display, metric, interval, maxHeightM } = style;
            const extruded = display === "extrusion";
            if (current.selectedMode === "comparison") {
              const pair = {
                ...(scenarioA !== undefined ? { scenarioA } : {}),
                ...(scenarioB !== undefined ? { scenarioB } : {}),
              };
              await handlers["scenario-comparison"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setScenarioComparisonSettings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM), mode: showDifference ? "diff" : "side-by-side", ...pair });
              requireMainGeneration({ tviewId: "main", generation: styleGeneration });
              if (generation !== styleGeneration) throw new Error("Style command belongs to a stale package generation.");
            }
            else if (current.selectedMode === "environment") handlers["emissions-h3"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setEmissionsH3Settings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM) });
            else handlers["network-kpi"].settings({ metric: metric as NonNullable<Parameters<typeof plugins.setNetworkKpiSettings>[0]["metric"]>, interval: Number(interval), extruded, maxHeightM: Number(maxHeightM) });
            const echoedStyle = current.selectedMode === "comparison"
              ? comparisonStyleState({ ...style, ...(scenarioA !== undefined ? { scenarioA } : {}), ...(scenarioB !== undefined ? { scenarioB } : {}) }, plugins.getScenarioComparisonStatus().scenarios, showDifference)
              : testudoViewerStyleState(style, current.scenarios ?? []);
            return update({ style: echoedStyle });
          }
          if (request.type === "testudoSetScenarioPair" || request.type === "testudoSetScenarioPairById") {
            const byId = request.type === "testudoSetScenarioPairById";
            if (!current.capabilities.some(item => item.id === "scenario-comparison" && item.available)) throw new Error("Scenario comparison is unavailable for this package.");
            const session = featureBridge.sessions.get("main");
            if (!session || request.payload?.tviewId !== "main" || (byId && request.payload?.generation !== session.context.generation) || (!byId && request.payload?.generation !== undefined && request.payload?.generation !== session.context.generation)) throw new Error("Scenario pair command belongs to a stale TView or package generation.");
            if (bridgePluginId !== "scenario-comparison") throw new Error("Select scenario comparison before changing its scenario pair.");
            const scenarios = plugins.getScenarioComparisonStatus().scenarios;
            if (byId && (typeof request.payload?.scenarioAId !== "string" || typeof request.payload?.scenarioBId !== "string")) throw new Error("Comparison scenario IDs are invalid.");
            const byIdPair = byId ? resolveComparisonScenarioPairIds(request.payload.scenarioAId as string, request.payload.scenarioBId as string, scenarios) : undefined;
            const scenarioA = byIdPair?.scenarioA ?? Number(request.payload?.scenarioA);
            const scenarioB = byIdPair?.scenarioB ?? Number(request.payload?.scenarioB);
            if (!Number.isSafeInteger(scenarioA) || scenarioA < 0 || scenarioA >= scenarios.length || !Number.isSafeInteger(scenarioB) || scenarioB < 0 || scenarioB >= scenarios.length) throw new Error(byId ? "Comparison scenario IDs are not available for this package." : "Comparison scenario indexes are invalid.");
            const pairRequest = ++comparisonPairRequest;
            await scenarioAdapters.comparison(scenarioA, scenarioB);
            if (pairRequest !== comparisonPairRequest) throw new Error("Scenario pair selection was superseded.");
            requireMainGeneration({ tviewId: "main", generation: session.context.generation });
            const comparisonStatus = plugins.getScenarioComparisonStatus();
            if (comparisonStatus.error) throw new Error(comparisonStatus.error);
            const resolvedScenarios = comparisonStatus.scenarios;
            const style = current.style ?? { display: "ramp" as const, metric: "flow_delta", interval: 0, maxHeightM: 100 };
            const echoedStyle = comparisonStyleState({ ...style, scenarioA, scenarioB }, resolvedScenarios, style.showDifference ?? true);
            if (byId) {
              const scenarioAId = String(resolvedScenarios[scenarioA]?.scid);
              const scenarioBId = String(resolvedScenarios[scenarioB]?.scid);
              if (!scenarioAId || !scenarioBId || scenarioAId === "undefined" || scenarioBId === "undefined") throw new Error("The selected comparison scenarios have no stable IDs.");
              update({ style: echoedStyle, selectedScenarioId: scenarioAId });
              return { scenarioAId, scenarioBId, selectedScenarioId: scenarioAId };
            }
            update({ style: echoedStyle });
            return { scenarioA, scenarioB };
          }
          if (request.type === "testudoSetLegendVisibility" || request.type === "testudoSetEsriWorldImagery") {
            if (typeof request.payload?.visible !== "boolean") throw new Error("visible must be a boolean.");
            const controlId = request.type === "testudoSetLegendVisibility" ? "legend" : "esri-world-imagery";
            requireMainGeneration(request.payload);
            const session = featureBridge.sessions.get("main");
            if (session) await featureBridge.setMapControl("main", controlId, request.payload.visible, request.payload.generation as number | undefined);
            else if (controlId === "legend") {
              if (request.payload.visible) plugins.openLegendPanel(app); else plugins.closeLegendPanel(app);
            } else setStandaloneEsriVisible(request.payload.visible);
            const state = session ? {
              ...featureBridge.getMapControlState("main", request.payload.generation as number | undefined),
              esriWorldImageryVisible: getStandaloneEsriVisible(),
              ...currentRendererReadiness(),
            } : {
              legendVisible: plugins.isLegendPanelVisible(), esriWorldImageryVisible: getStandaloneEsriVisible(),
              renderer: useAppStore.getState().primaryRenderer === "cesium" ? "cesium" as const : "maplibre" as const,
              ...currentRendererReadiness(),
            };
            return { visible: controlId === "legend" ? state.legendVisible : state.esriWorldImageryVisible };
          }
          if (request.type === "testudoSetMapControl") {
            const controlId = request.payload?.controlId;
            if (typeof controlId !== "string" || typeof request.payload?.visible !== "boolean") throw new Error("controlId and boolean visible are required.");
            return { visible: await featureBridge.setMapControl("main", controlId, request.payload.visible, request.payload?.generation) };
          }
          if (request.type === "testudoGetMapControlState") {
            requireMainGeneration(request.payload);
            const session = featureBridge.sessions.get("main");
            return session ? {
              ...featureBridge.getMapControlState("main", request.payload.generation as number | undefined),
              esriWorldImageryVisible: getStandaloneEsriVisible(),
              ...currentRendererReadiness(),
            } : {
              legendVisible: plugins.isLegendPanelVisible(), esriWorldImageryVisible: getStandaloneEsriVisible(),
              renderer: useAppStore.getState().primaryRenderer === "cesium" ? "cesium" as const : "maplibre" as const,
              ...currentRendererReadiness(),
            };
          }
          if (request.type === "testudoSetKpiGeometry") {
            const geometry = request.payload?.geometry;
            if (!["sections", "lanes", "turns", "nodes"].includes(String(geometry)) || typeof request.payload?.visible !== "boolean") {
              throw new Error("geometry must be sections, lanes, turns, or nodes, and visible must be boolean.");
            }
            return featureBridge.setKpiGeometry("main", geometry as "sections" | "lanes" | "turns" | "nodes", request.payload.visible, request.payload?.generation);
          }
          if (request.type === "testudoGetKpiGeometryState") return featureBridge.getKpiGeometryState("main", request.payload?.generation);
          if (request.type === "testudoSetRenderer") {
            const renderer = request.payload?.renderer;
            if (renderer !== "maplibre" && renderer !== "cesium") throw new Error("renderer must be maplibre or cesium.");
            requireMainGeneration(request.payload);
            const session = featureBridge.sessions.get("main");
            if (session) return { renderer: await featureBridge.setRenderer("main", renderer, request.payload.generation as number | undefined) };
            useAppStore.getState().setPrimaryRenderer(renderer);
            return { renderer };
          }
          if (request.type === "testudoSetNetworkFilter") {
            const filter = request.payload?.filter;
            if (!filter || typeof filter !== "object" || typeof filter.id !== "string" || !filter.id.trim() || typeof filter.enabled !== "boolean"
              || (filter.value !== undefined && !["string", "number", "boolean"].includes(typeof filter.value))) throw new Error("filter must contain an id, enabled flag, and optional scalar value.");
            await featureBridge.setNetworkFilter("main", filter, request.payload?.generation);
            return { applied: true as const };
          }
          if (request.type === "testudoOpenAnnotations" || request.type === "testudoOpenRecordTour" || request.type === "testudoRecordTour"
            || request.type === "testudoOpenRecordVideo" || request.type === "testudoRecordVideo") {
            const main = requireMainGeneration(request.payload);
            const action = request.type === "testudoOpenAnnotations" ? "annotations"
              : request.type === "testudoOpenRecordVideo" || request.type === "testudoRecordVideo" ? "record-video" : "record-tour";
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const timeout = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("The requested map action did not receive a response."));
              }, 15_000);
              const respond = (result: import("../../lib/testudo-protocol").TestudoNativeActionResult) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                if (result.ok) {
                  try {
                    requireMainGeneration({ tviewId: "main", generation: main.generation });
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                } else reject(new Error(result.error));
              };
              window.dispatchEvent(createTestudoNativeActionEvent({ source: "testudo", action,
                requestId: request.requestId, tviewId: "main", generation: main.generation, respond }));
            });
            return action === "annotations" ? { active: true } : { opened: true };
          }
          if (request.type === "testudoSetPlaybackPlaying") {
            const session = featureBridge.sessions.get("main");
            const expectedGeneration = request.payload?.generation;
            const currentGeneration = session?.context.generation ?? null;
            const generationAccepted = Boolean(session && featureBridge.sessions.isCurrent(session.context)
              && (expectedGeneration === undefined || expectedGeneration === currentGeneration));
            const playbackStatus = plugins.getVehiclePlaybackStatus();
            const selectedVariant = playbackStatus.scenarios[playbackStatus.scenarioIndex];
            const traceSnapshot = plugins.getVehiclePlaybackTraceSnapshot();
            tracePlaybackCommand("native-generation-gate", {
              requestId: String(request.requestId ?? "").slice(0, 128),
              generation: Number.isSafeInteger(expectedGeneration) ? expectedGeneration : null,
              currentGeneration,
              variantId: selectedVariant?.variantId ?? selectedVariant?.id ?? null,
              loadToken: traceSnapshot?.loadToken ?? null,
              accepted: generationAccepted,
            });
            if (generationAccepted && request.payload?.playing === true) plugins.setVehiclePlaybackTraceCommandContext({
              requestId: String(request.requestId ?? "").slice(0, 128),
              generation: currentGeneration,
              variantId: selectedVariant?.variantId ?? selectedVariant?.id ?? null,
            });
            return featureBridge.playback("main", request.payload?.playing ? "play" : "pause", undefined, request.payload?.generation);
          }
          if (request.type === "testudoRestartPlayback") return featureBridge.playback("main", "restart", undefined, request.payload?.generation);
          if (request.type === "testudoSeekPlayback") return featureBridge.playback("main", "seek", Number(request.payload?.tick), request.payload?.generation);
          if (request.type === "testudoSetPlaybackSpeed") return featureBridge.playback("main", "speed", Number(request.payload?.speed), request.payload?.generation);
          if (request.type === "testudoGetPlaybackState") return featureBridge.getPlaybackState("main", request.payload?.generation);
          if (request.type === "testudoSetCameraView" || request.type === "testudoGetCameraView") {
            // Works for analysis-only packages (no session) and on either renderer; never a silent no-op.
            if (request.payload?.tviewId !== undefined && request.payload.tviewId !== "main") throw new Error("Camera command targets an unsupported TView.");
            const cameraGeneration = generation;
            const assertCameraCurrent = () => {
              if (disposed || generation !== cameraGeneration || (request.payload?.generation !== undefined && request.payload.generation !== cameraGeneration)) throw new Error("Camera command belongs to a stale package generation.");
            };
            assertCameraCurrent();
            if (request.type === "testudoSetCameraView") {
              const validated = validateTestudoCameraView(request.payload?.view);
              applyTestudoCamera(app, validated);
              assertCameraCurrent();
            }
            const camera = readTestudoCamera(app);
            assertCameraCurrent();
            return camera;
          }
          if (request.type === "testudoSetViewMode") {
            const mode = await featureBridge.setViewMode("main", request.payload?.mode, request.payload?.generation);
            window.dispatchEvent(new CustomEvent("testudo-view-mode-changed", { detail: { mode, generation: request.payload?.generation } }));
            return { mode };
          }
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
          if (request.type === "testudoSetPreset") return await applyPreset(request.payload?.id);
          throw unsupportedTestudoCommand(request.type);
        } finally {
          if (operation === null) commandGate.finishCommand(commandOwner);
        }
      };
      const completion = packageRequest && operation !== null
        ? runWithPackageOwnerRelease(run, () => commandGate.finishPackage(operation))
        : run();
      void completion.then(result => {
        if (isPlaybackCommand) {
          const playbackResult = result && typeof result === "object" ? result as { generation?: unknown; playing?: unknown; tick?: unknown } : {};
          tracePlaybackCommand("native-command-ack", {
            requestId: String(request.requestId ?? "").slice(0, 128), ok: true,
            generation: Number.isSafeInteger(playbackResult.generation) ? playbackResult.generation : request.payload?.generation ?? null,
            variantId: plugins.getVehiclePlaybackStatus().scenarios[plugins.getVehiclePlaybackStatus().scenarioIndex]?.variantId ?? null,
            playing: typeof playbackResult.playing === "boolean" ? playbackResult.playing : request.payload?.playing === true,
            tick: Number.isFinite(playbackResult.tick) ? playbackResult.tick : null,
          });
        }
        emit("ack", { requestId: request.requestId, ok: true, result });
      }, error => {
        const detail = error instanceof Error ? error.message : String(error);
        if (operation !== null && ownsPackageOperation(operation)) {
          if (current.status === "loading" && current.error !== detail) { reset(); update({ status: "error", error: detail }); }
        } else if (operation === null && !commandGate.packageBusy && !commandGate.commandBusy) update({ status: current.package ? "ready" : "empty", error: undefined });
        if (isPlaybackCommand) tracePlaybackCommand("native-command-ack", {
          requestId: String(request.requestId ?? "").slice(0, 128), ok: false, error: true,
          generation: request.payload?.generation ?? null,
          variantId: plugins.getVehiclePlaybackStatus().scenarios[plugins.getVehiclePlaybackStatus().scenarioIndex]?.variantId ?? null,
        });
        emit("ack", { requestId: request.requestId, ok: false, error: detail });
      });
    };
    window.addEventListener("message", message);
    traceTestudoBridge("bridge-message-listener-installed", { origin, allowedOriginCount: allowed.length });
    document.title = "Testudo";
    ready();
    // The host can import the client after iframe load. Repeat readiness until
    // its first command so that ordering cannot strand a healthy map.
    readyTimer = setInterval(ready, 500);
    const readyStop = setTimeout(() => clearInterval(readyTimer), 60_000);
    return () => { removeLiveDiagnostics(); analysis.teardown(); disposed = true; generation++; guestCredential = null; parentOrigin = null; clearInterval(persistentNetworkMapWatch); clearInterval(mapControlsTimer); unsubscribeMapControls?.(); persistentNetwork.clear(); packageFitter.dispose(); void plugins.setTestudoResultsSessionKey(null); clearInterval(readyTimer); clearTimeout(readyStop); abort.abort(); picker.current = null; modeSelector.current = null; window.removeEventListener("message", message); window.removeEventListener("testudo-scenario-analysis-action", applyScenarioAnalysisAction); unsubscribeAssistantPanel(); unsubscribeBridgeGeoAI(); unsubscribeBridgeReplies(); unsubscribePlayback(); featureBridge.close("main"); closeAllPlugins(); plugins.resetGeoAiChat(); plugins.resetGeoAiBuildings(); };
  }, [app]);

  const hostGeoAi = useTestudoPanels().hostGeoAi;
  const canOpenGeoAi = Boolean(app && !hostGeoAi && state.capabilities.some(item => item.id === "geoai" && item.available));
  const hasVisibleStatus = state.status === "loading" || Boolean(state.error);
  if (!canOpenGeoAi && !hasVisibleStatus) return null;

  // The embedding Testudo shell renders its own "open package" control and mode/plugin
  // switcher outside this iframe (ProductApp.tsx / EmbeddedViewer.tsx), so this panel no
  // longer duplicates them here (see the Testudo-side UI reconciliation pass) — it now only
  // surfaces what the shell cannot: the GeoAI trigger and inline loading/error status.
  return <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex justify-end" data-testudo-controls>
    <div className="pointer-events-auto w-fit min-w-0 max-w-[min(20rem,100%)] rounded-md border border-border bg-background p-3 shadow-lg">
      {canOpenGeoAi && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => { if (app) handlers["geoai"].open(app); }}>{t("toolbar.geoai.open", "Ask GeoAI")}</button>}
      {state.status === "loading" && <p role="status" className="text-sm">{t("testudo.loading")}</p>}
      {state.error && <p role="alert" className="mt-2 break-words text-sm text-red-600">{state.error}</p>}
    </div>
  </div>;
}
