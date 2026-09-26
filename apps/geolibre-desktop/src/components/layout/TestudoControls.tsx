import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as plugins from "@geolibre/plugins";
import type { GeoLibreAppAPI } from "@geolibre/plugins";
import type { TestudoBootstrap, TestudoCapabilityId, TestudoDemoMode, TestudoLoadPackage, TestudoViewerState } from "@geolibre/embed";
import { readEmbedOrigins } from "../../lib/embed-api";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage, availableTestudoModes, hasDeclaredPathIndex, validateTestudoBootstrap } from "../../lib/testudo-protocol";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";
import { listVehicleManifestScenarios } from "@geolibre/plugins";

/** Exported so tests can assert every Testudo capability is actually wired here (see #273: GeoAI
 * chat previously existed only in the legacy viewer, with zero entry in this list). */
export const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison", "geoai"];
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
  "geoai": { open: plugins.openGeoAiChatPanel, close: plugins.closeGeoAiChatPanel, load: plugins.loadGeoAiChat, status: plugins.getGeoAiChatStatus, settings: plugins.setGeoAiChatSettings },
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
    let abort = new AbortController();
    let disposed = false;
    let generation = 0;
    let selectionGeneration = 0;
    let busy = false;
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
    const close = () => { for (const id of ids) handlers[id].close(); };
    const select = async (id: TestudoCapabilityId) => {
      if (!ids.includes(id)) throw new Error("Unknown viewer plugin");
      const capability = current.capabilities.find(item => item.id === id);
      if (!capability?.available) throw new Error(capability?.reason ?? "This plugin is unavailable for this package.");
      if (!directory) throw new Error("Select a package first.");
      const version = generation;
      const selection = ++selectionGeneration;
      close();
      update({ selectedPlugin: id, status: "loading", error: undefined });
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
      close(); directory = null; bootstrap = null;
      plugins.resetGeoAiChat();
      update({ ...empty });
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
      // Guest-embed sessions have no principal bearer token, so GeoAI chat is left unconfigured
      // for them: `/api/v1/ai/chat` only accepts `Authorization: Bearer <principal>`, not the
      // `Testudo-Embed` guest scheme used for package bytes.
      plugins.initGeoAiChat({ origin, bearerToken: payload.transport?.bearerToken, packageId: candidate.packageId });
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
        // Local folder loads have no Testudo session (no origin, no bearer token), so GeoAI chat
        // cannot reach `/api/v1/ai/chat` here — the alias intentionally never matches a
        // `pkg.capabilities` key, keeping "geoai" unavailable with a clear reason.
        const aliases: Record<TestudoCapabilityId, string> = { "vehicle-playback": "animation", "network-kpi": "results", "path-analysis": "paths", "emissions-h3": "results", "scenario-comparison": "results", "geoai": "" };
        const emissions = pkg.dataContracts.emissions as { status?: string } | undefined;
        const comparisonCount = pkg.scenarios.reduce((count, scenario) => count + Math.max(1, scenario.replications.length), 0);
        const capabilities = ids.map(id => ({ id, available: id !== "geoai" && pkg.capabilities[aliases[id]]?.state === "available"
          && (id !== "emissions-h3" || emissions?.status === "available")
          && (id !== "scenario-comparison" || comparisonCount > 1), reason: id === "geoai"
            ? "GeoAI chat is only available for packages loaded from Testudo, not local folders."
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
        if (busy) throw new Error("The viewer is loading a package. Please wait.");
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
    document.title = "Testudo";
    ready();
    // The host can import the client after iframe load. Repeat readiness until
    // its first command so that ordering cannot strand a healthy map.
    readyTimer = setInterval(ready, 500);
    const readyStop = setTimeout(() => clearInterval(readyTimer), 60_000);
    return () => { disposed = true; generation++; guestCredential = null; parentOrigin = null; clearInterval(readyTimer); clearTimeout(readyStop); abort.abort(); picker.current = null; modeSelector.current = null; window.removeEventListener("message", message); close(); };
  }, [app]);

  return <div className="absolute end-3 top-3 z-40 max-w-xs rounded-md border border-border bg-background p-3 shadow-lg" data-testudo-controls>
    {state.package?.origin !== "published" && <button className="rounded border px-3 py-2 text-sm" disabled={state.status === "loading"} onClick={() => {
      const pick = (window as unknown as { showDirectoryPicker?: () => Promise<VehicleDirectoryHandle> }).showDirectoryPicker;
      if (!pick) { setState(current => ({ ...current, status: "error", error: t("testudo.folderUnsupported") })); return; }
      void pick().then(directory => picker.current?.(directory)).catch(error => { if (error?.name !== "AbortError") setState(current => ({ ...current, status: "error", error: String(error) })); });
    }}>{t("testudo.openLocal")}</button>}
    {state.package && <div role="group" aria-label="Demo modes" className="mt-2 flex flex-wrap gap-1">{modes.map(mode => <button key={mode.id} type="button" className={`rounded border px-2 py-1 text-xs ${state.selectedMode === mode.id ? "bg-primary text-primary-foreground" : ""}`} aria-pressed={state.selectedMode === mode.id} disabled={state.status === "loading" || !state.availableModes.includes(mode.id)} title={state.availableModes.includes(mode.id) ? mode.label : `${mode.label} is not declared by this package`} onClick={() => { void modeSelector.current?.(mode.id).catch(error => setState(current => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }))); }}>{mode.label}</button>)}</div>}
    {state.status === "loading" && <p role="status" className="text-sm">{t("testudo.loading")}</p>}
    {state.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
  </div>;
}
