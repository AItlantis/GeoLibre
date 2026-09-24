import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as plugins from "@geolibre/plugins";
import type { GeoLibreAppAPI } from "@geolibre/plugins";
import type { TestudoBootstrap, TestudoCapabilityId, TestudoLoadPackage, TestudoViewerState } from "@geolibre/embed";
import { readEmbedOrigins } from "../../lib/embed-api";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createSignedPackageSource, sourceDirectory } from "../../lib/testudo-source";
import { acceptsTestudoMessage } from "../../lib/testudo-protocol";
import { readLocalNetworkKpiManifestJson } from "@geolibre/plugins";
import { getGeolibrePackage } from "@geolibre/plugins";
import type { VehicleDirectoryHandle } from "@geolibre/plugins";

const ids: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"];
const empty: TestudoViewerState = { package: null, selectedPlugin: null, capabilities: [], status: "empty" };
const handlers = {
  "vehicle-playback": { open: plugins.openVehiclePlaybackPanel, close: plugins.closeVehiclePlaybackPanel, load: plugins.loadLocalVehiclePlaybackFolder, status: plugins.getVehiclePlaybackStatus, settings: plugins.setVehiclePlaybackSettings },
  "network-kpi": { open: plugins.openNetworkKpiPanel, close: plugins.closeNetworkKpiPanel, load: plugins.loadLocalNetworkKpiFolder, status: plugins.getNetworkKpiStatus, settings: plugins.setNetworkKpiSettings },
  "path-analysis": { open: plugins.openPathAnalysisPanel, close: plugins.closePathAnalysisPanel, load: plugins.loadLocalPathAnalysisFolder, status: plugins.getPathAnalysisSnapshot, settings: plugins.setPathAnalysisSettings },
  "emissions-h3": { open: plugins.openEmissionsH3Panel, close: plugins.closeEmissionsH3Panel, load: plugins.loadLocalEmissionsH3Folder, status: plugins.getEmissionsH3Status, settings: plugins.setEmissionsH3Settings },
  "scenario-comparison": { open: plugins.openScenarioComparisonPanel, close: plugins.closeScenarioComparisonPanel, load: plugins.loadLocalScenarioComparisonFolder, status: plugins.getScenarioComparisonStatus, settings: plugins.setScenarioComparisonSettings },
};

/** Curated native runtime. The host owns navigation; these plugins own their map layers. */
export function TestudoControls({ app }: { app: GeoLibreAppAPI | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TestudoViewerState>(empty);
  const picker = useRef<((directory: VehicleDirectoryHandle) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!app) return;
    const origin = window.location.origin;
    const allowed = readEmbedOrigins().filter(value => value !== "*");
    if (!allowed.includes(origin) || window.parent === window) return;
    let current = empty;
    let directory: VehicleDirectoryHandle | null = null;
    let bootstrap: TestudoBootstrap | null = null;
    let abort = new AbortController();
    let disposed = false;
    let generation = 0;
    let selectionGeneration = 0;
    let busy = false;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const emit = (type: string, payload: unknown) => {
      if (!disposed) window.parent.postMessage({ v: 2, source: "geolibre", type, payload }, origin);
    };
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
      update({ ...empty });
    };
    const load = async (payload: TestudoLoadPackage) => {
      const candidate = payload?.bootstrap;
      if (!candidate || typeof candidate.versionId !== "string" || typeof candidate.packageId !== "string" || typeof candidate.label !== "string"
        || candidate.origin !== "published" || candidate.manifestPath !== "manifest.json" || candidate.nativeManifestPath !== "geolibre/package.json"
        || !Array.isArray(candidate.capabilities) || !Array.isArray(candidate.presets) || !payload.transport?.bearerToken) throw new Error("Invalid Testudo package bootstrap");
      if (candidate.artifactEndpoint !== `/api/v1/view/${encodeURIComponent(candidate.versionId)}/artifact/`) throw new Error("Package endpoint does not match its version");
      if (candidate.capabilities.some(item => !ids.includes(item.id) || typeof item.available !== "boolean")) throw new Error("Invalid package capabilities");
      reset(); bootstrap = candidate;
      const byteOrigins = (readDeploymentEnvValue("VITE_TESTUDO_BYTE_ORIGINS") ?? "").split(/[\s,]+/).filter(Boolean).map(value => new URL(value).origin);
      if (!byteOrigins.length) throw new Error("Package byte origin is not configured");
      const source = createSignedPackageSource({ origin, artifactEndpoint: candidate.artifactEndpoint, bearerToken: payload.transport.bearerToken, byteOrigins, signal: abort.signal });
      directory = sourceDirectory(source, candidate.label);
      update({ package: { packageId: candidate.packageId, versionId: candidate.versionId, label: candidate.label, origin: "published" }, capabilities: candidate.capabilities, status: "loading" });
      await readLocalNetworkKpiManifestJson(directory);
      const initial = payload.selectedPlugin ?? candidate.capabilities.find(item => item.available)?.id;
      if (!initial) throw new Error("This package has no supported viewer data");
      await select(initial);
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
        update({ package: { packageId: crypto.randomUUID(), versionId: null, label: selected.name, origin: "local" }, capabilities, status: "loading" });
        const initial = capabilities.find(item => item.available)?.id;
        if (!initial) throw new Error("This folder declares no supported viewer datasets");
        await select(initial);
      } catch (error) { update({ status: "error", error: error instanceof Error ? error.message : String(error) }); }
      finally { busy = false; }
    };
    const message = (event: MessageEvent) => {
      if (!acceptsTestudoMessage(event, window.parent, origin, allowed)) return;
      clearInterval(readyTimer);
      const request = event.data;
      const run = async () => {
        if (request.type === "testudoGetState") return current;
        if (busy) throw new Error("The viewer is loading a package. Please wait.");
        busy = true;
        try {
          if (request.type === "testudoLoadPackage") return await load(request.payload);
          if (request.type === "testudoSetPlugin") return await select(request.payload?.id);
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
    emit("ready", { version: "testudo-v1" });
    // The host can import the client after iframe load. Repeat readiness until
    // its first command so that ordering cannot strand a healthy map.
    readyTimer = setInterval(() => emit("ready", { version: "testudo-v1" }), 500);
    const readyStop = setTimeout(() => clearInterval(readyTimer), 60_000);
    return () => { disposed = true; generation++; clearInterval(readyTimer); clearTimeout(readyStop); abort.abort(); picker.current = null; window.removeEventListener("message", message); close(); };
  }, [app]);

  return <div className="absolute end-3 top-3 z-40 max-w-xs rounded-md border border-border bg-background p-3 shadow-lg" data-testudo-controls>
    {state.package?.origin !== "published" && <button className="rounded border px-3 py-2 text-sm" disabled={state.status === "loading"} onClick={() => {
      const pick = (window as unknown as { showDirectoryPicker?: () => Promise<VehicleDirectoryHandle> }).showDirectoryPicker;
      if (!pick) { setState(current => ({ ...current, status: "error", error: t("testudo.folderUnsupported") })); return; }
      void pick().then(directory => picker.current?.(directory)).catch(error => { if (error?.name !== "AbortError") setState(current => ({ ...current, status: "error", error: String(error) })); });
    }}>{t("testudo.openLocal")}</button>}
    {state.status === "loading" && <p role="status" className="text-sm">{t("testudo.loading")}</p>}
    {state.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
  </div>;
}
