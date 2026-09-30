import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as plugins from "@geolibre/plugins";
import type { GeoAiViewerContext, GeoLibreAppAPI } from "@geolibre/plugins";
import type { TestudoBootstrap, TestudoCapabilityId, TestudoSelectablePluginId, TestudoDemoMode, TestudoLoadPackage, TestudoViewerState } from "@geolibre/embed";
import { readEmbedOrigins } from "../../lib/embed-api";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage, availableTestudoModes, hasDeclaredPathIndex, validateScenarioAnalysisAction, validateTestudoBootstrap } from "../../lib/testudo-protocol";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";
import { listVehicleManifestScenarios } from "@geolibre/plugins";
import { summarizeGeoAiInvestigation } from "../../lib/testudo-investigation";

/** Exported so tests can assert every Testudo capability is actually wired here (see #273: GeoAI
 * chat previously existed only in the legacy viewer, with zero entry in this list). */
export const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai", "geoai-buildings"];
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
    let openingLocalPicker = false;
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
      if (!capability?.available) throw new Error(capability?.reason ?? "This plugin is unavailable for this package.");
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
      if (status.error) throw new Error(status.error);
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
    const reset = () => {
      generation++;
      selectionGeneration++;
      abort.abort(); abort = new AbortController();
      closeAllPlugins(); directory = null; bootstrap = null; declaredScenarioIds = [];
      plugins.resetGeoAiChat();
      plugins.resetGeoAiBuildings();
      update({ ...empty });
    };
    const load = async (payload: TestudoLoadPackage) => {
      const candidate = payload?.bootstrap && validateTestudoBootstrap(payload.bootstrap, !!guestCredential);
      if (!candidate || (!payload.transport?.bearerToken && !guestCredential) || (payload.transport?.bearerToken && guestCredential)
        || (guestCredential && payload.challenge !== challenge)) throw new Error("Invalid Testudo package bootstrap");
      reset(); bootstrap = candidate;
      const byteOrigins = (readDeploymentEnvValue("VITE_TESTUDO_BYTE_ORIGINS") ?? "").split(/[\s,]+/).filter(Boolean).map(value => new URL(value).origin);
      if (!byteOrigins.length) throw new Error("Package byte origin is not configured");
      const getGuestEmbedToken = guestCredential ? () => {
        if (!guestCredential || guestCredential.expiresAt <= Date.now()) throw new Error("Guest demo access expired; refresh the package to continue.");
        return guestCredential.token;
      } : undefined;
      const source = createSignedPackageSource({ origin, artifactEndpoint: candidate.artifactEndpoint,
        ...(getGuestEmbedToken ? { getGuestEmbedToken } : { bearerToken: payload.transport!.bearerToken }), byteOrigins, signal: abort.signal });
      directory = sourceDirectory(source, candidate.label);
      plugins.initGeoAiChat({
        origin,
        bearerToken: payload.transport?.bearerToken,
        packageId: candidate.packageId,
        packageVersionId: candidate.versionId,
        ...(getGuestEmbedToken ? { guest: { getGuestEmbedToken } } : {}),
        getViewerContext: getGeoAiViewerContext,
      });
      plugins.initGeoAiBuildings({ origin, bearerToken: payload.transport?.bearerToken, packageId: candidate.packageId });
      update({ package: { packageId: candidate.packageId, versionId: candidate.versionId, label: candidate.label, origin: "published" }, capabilities: candidate.capabilities, status: "loading" });
      const raw = await readLocalNetworkKpiManifestJson(directory);
      const pkg = getGeolibrePackage(raw);
      const packageScenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
      declaredScenarioIds = packageScenarios.map(item => item.scid).filter((id): id is string | number => id !== undefined);
      const hasAnimation = packageScenarios.length > 0;
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
    const openLocalPackage = async () => {
      if (busy || openingLocalPicker) throw new Error(t("testudo.loading"));
      const pickerWindow = window as LocalPackagePickerWindow;
      if (!pickerWindow.showDirectoryPicker) {
        const error = t("testudo.folderUnsupported");
        update({ status: "error", error });
        throw new Error(error);
      }
      // Invoke the browser picker immediately in response to the validated
      // host command so transient user activation is still available.
      openingLocalPicker = true;
      try {
        const selected = await pickerWindow.showDirectoryPicker({ mode: "read" });
        await picker.current?.(selected);
        return current;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return current;
        throw error;
      } finally {
        openingLocalPicker = false;
      }
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
      parentOrigin = event.origin;
      if (request.type === "testudoSetGuestCapability") {
        guestCredential = { token: request.payload.guestEmbedToken, expiresAt: request.payload.expiresAt };
        emit("ack", { requestId: request.requestId, ok: true, result: { protocol: 1, challenge, expiresAt: guestCredential.expiresAt } });
        return;
      }
      if (request.type === "testudoOpenLocalPackage") {
        void openLocalPackage().then(result => emit("ack", { requestId: request.requestId, ok: true, result }), error => {
          const detail = error instanceof Error ? error.message : String(error);
          update({ status: "error", error: detail });
          emit("ack", { requestId: request.requestId, ok: false, error: detail });
        });
        return;
      }
      if (request.type === "testudoRequestInvestigation") {
        requestInvestigation(request);
        return;
      }
      const run = async () => {
        if (request.type === "testudoGetState") return current;
        if (busy) throw new Error("The viewer is loading a package. Please wait.");
        busy = true;
        try {
          if (request.type === "testudoLoadPackage") return await load(request.payload);
          if (request.type === "testudoSetPlugin") return await select(request.payload?.id);
          if (request.type === "testudoSetMode") return await selectMode(request.payload.mode);
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
        update({ status: "error", error: detail });
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
    return () => { disposed = true; generation++; guestCredential = null; parentOrigin = null; clearInterval(readyTimer); clearTimeout(readyStop); abort.abort(); picker.current = null; modeSelector.current = null; window.removeEventListener("message", message); window.removeEventListener("testudo-scenario-analysis-action", applyScenarioAnalysisAction); unsubscribeAssistantPanel(); closeAllPlugins(); plugins.resetGeoAiChat(); plugins.resetGeoAiBuildings(); };
  }, [app]);

  const canOpenGeoAi = Boolean(app && state.capabilities.some(item => item.id === "geoai" && item.available));
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
