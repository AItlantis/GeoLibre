import type { FeatureCollection } from "geojson";
import type {
  TestudoFeatureContext, TestudoFeatureSession, TestudoPackageProgress,
  TestudoPlaybackState, TestudoScenario, TestudoRenderer,
  TestudoMapHandle,
} from "../shared/testudo-feature-session";
import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "../testudo-feature-bridge";
import { registerTestudoPackageProvider } from "../testudo-provider-registry";
import { declaredDefaultCamera, networkBounds, validateTestudoCameraView } from "./testudo-camera";
import {
  parseTestudoAnimationManifest, parseTestudoPackageStructure, vehiclesAtTick,
  type TestudoAnimationChunkDescriptor, type TestudoVehiclePoint,
} from "./testudo-package-data";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const json = async (bytes: ArrayBuffer, label: string): Promise<Json> => {
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new Error(`${label} is not valid JSON.`); }
};
const capability = (id: NonNullable<TestudoFeatureSession["capabilities"]>[number]["id"], available: boolean, reason?: string) => ({
  id, available, ...(reason ? { reason } : {}),
});
const asFeatureCollection = (value: unknown): FeatureCollection | null => {
  const data = record(value);
  return data.type === "FeatureCollection" && Array.isArray(data.features) ? data as unknown as FeatureCollection : null;
};
function parseScenarios(raw: Json, packageInfo: Json): TestudoScenario[] {
  const source = Array.isArray(raw.scenarios) ? raw.scenarios : Array.isArray(packageInfo.scenarios) ? packageInfo.scenarios : [];
  return source.flatMap((value, index) => {
    const item = record(value); const rawId = item.scid ?? item.id;
    if (typeof rawId !== "string" && typeof rawId !== "number") return [];
    const replications = Array.isArray(item.replications) ? item.replications : [];
    return [{
      id: String(rawId),
      label: typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : `Scenario ${index + 1}`,
      replications: replications.flatMap((rawReplication) => {
        const replication = record(rawReplication); const id = Number(replication.did ?? replication.id);
        return Number.isSafeInteger(id) ? [{ id, ...(typeof replication.didname === "string" ? { label: replication.didname } : {}) }] : [];
      }),
    }];
  });
}

/** Published Testudo packages are read exclusively through the bridge proxy. */
export const testudoVehiclePlaybackProvider: TestudoFeatureProviderFactory = {
  async open(bootstrap: TestudoPackageBootstrap, context: TestudoFeatureContext, onProgress: (p: TestudoPackageProgress) => void,
    fetchArtifact: (ref: string) => Promise<ArrayBuffer>, mapHandle?: TestudoMapHandle | null): Promise<TestudoFeatureSession> {
    let loaded = 0;
    const read = async (path: string, label: string) => {
      const bytes = await fetchArtifact(path);
      loaded += bytes.byteLength;
      // The proxy does not expose a package byte total. Keep intermediate
      // progress valid and indeterminate, then report measured bytes at finish.
      onProgress({ value: 0, loaded: 0, total: 0, label });
      return bytes;
    };
    const root = await json(await read("manifest.json", "Reading package manifest"), "Package manifest");
    const packageInfo = await json(await read("geolibre/package.json", "Reading GeoLibre package structure"), "GeoLibre package manifest");
    const structure = parseTestudoPackageStructure(root, packageInfo);
    const animationManifests = await Promise.all(structure.animationManifestPaths.map(async (path) => {
      try { return parseTestudoAnimationManifest(await json(await read(path, "Indexing animation chunks"), "Animation manifest")); }
      catch (error) {
        onProgress({ value: 0, loaded, total: loaded, label: `Animation metadata unavailable: ${error instanceof Error ? error.message : String(error)}` });
        return [];
      }
    }));
    const chunksByAnimation = animationManifests;
    const scenarios = parseScenarios(root, packageInfo);
    let scenarioIndex = 0;
    const maxTick = Math.max(0, ...chunksByAnimation.flatMap((chunks) => chunks.map((chunk) => chunk.endTick)), structure.maxTick);
    let state: TestudoPlaybackState = { available: true, loading: true, playing: false, tick: 0, maxTick, speed: 1, dt: structure.dt, loop: false };
    const namespace = `testudo-${context.tviewId}-${context.generation}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const map = mapHandle ?? null;
    const loadedChunks = new Map<string, Json>();
    const pendingChunks = new Map<string, Promise<Json>>();
    let owner: import("./testudo-package-renderer").TestudoLayerOwner | null = null;
    let currentPoints = new Map<string, TestudoVehiclePoint>();
    let sectionsLoaded = false;
    let lanesLoaded = false;
    let nodesLoaded = false;
    let centroidsLoaded = false;
    let disposed = false;
    let legendVisible = true;
    let kpiGeometry = { showLanes: false, showSections: true };
    let renderer: TestudoRenderer = "maplibre";
    let esriWorldImageryVisible = false;
    let cameraWasSetByHostOrUser = false;
    const onMapMoveStart = (event?: { originalEvent?: unknown }) => {
      if (event?.originalEvent) cameraWasSetByHostOrUser = true;
    };
    map?.on?.("movestart", onMapMoveStart);
    let interval: ReturnType<typeof setInterval> | undefined;
    const playbackListeners = new Set<(tviewId: string, generation: number, playback: TestudoPlaybackState) => void>();
    const vehicleCapability = capability("vehicle-playback", false, "No readable animation chunk is declared for this package.");
    const publishPlayback = () => {
      const snapshot = { ...state };
      for (const listener of playbackListeners) listener(context.tviewId, context.generation, snapshot);
      return snapshot;
    };
    const stopPlayback = () => { if (interval !== undefined) clearInterval(interval); interval = undefined; };
    // Rendering code is split from the main plugin graph and only loaded for a live map.
    const getOwner = async () => {
      if (!map) return null;
      if (!owner) {
        const drawing = await import("./testudo-package-renderer");
        if (disposed) return null;
        owner = drawing.createTestudoLayerOwner(map, namespace);
      }
      return owner;
    };
    const renderNetwork = async () => {
      if (!structure.sectionsPath) return;
      const geometryBytes = await read(structure.sectionsPath, "Loading network geometry");
      let sections: FeatureCollection | null;
      if (structure.sectionsPath.endsWith(".gz")) {
        const stream = new Blob([geometryBytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        sections = asFeatureCollection(JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer())));
      } else sections = asFeatureCollection(JSON.parse(new TextDecoder().decode(geometryBytes)));
      if (!sections) throw new Error("The package network sections artifact is not a GeoJSON FeatureCollection.");
      let lanes: FeatureCollection | undefined;
      if (structure.lanesPath) {
        try {
          const laneBytes = await read(structure.lanesPath, "Loading lane geometry");
          const laneData = structure.lanesPath.endsWith(".gz")
            ? await new Response(new Blob([laneBytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
            : laneBytes;
          lanes = asFeatureCollection(JSON.parse(new TextDecoder().decode(laneData))) ?? undefined;
        } catch { lanes = undefined; }
      }
      let nodes: FeatureCollection | undefined;
      if (structure.nodesPath) {
        try { nodes = asFeatureCollection(JSON.parse(new TextDecoder().decode(await read(structure.nodesPath, "Loading network nodes")))) ?? undefined; }
        catch { nodes = undefined; }
      }
      let centroids: FeatureCollection | undefined;
      if (structure.centroidPath) {
        try { centroids = asFeatureCollection(JSON.parse(new TextDecoder().decode(await read(structure.centroidPath, "Loading network centroids")))) ?? undefined; }
        catch { centroids = undefined; }
      }
      const drawing = await getOwner();
      // Layer owner scopes IDs, so pass stable local names through its adapter.
      if (drawing && !disposed) {
        const rendererModule = await import("./testudo-package-renderer");
        rendererModule.drawNetwork(drawing, sections, nodes, centroids, lanes);
      }
      sectionsLoaded = true; lanesLoaded = Boolean(lanes?.features.length);
      nodesLoaded = Boolean(nodes?.features.length); centroidsLoaded = Boolean(centroids?.features.length);
      const bounds = networkBounds(sections, lanes, nodes, centroids);
      if (map && bounds && !cameraWasSetByHostOrUser && !disposed) {
        const declared = declaredDefaultCamera(root, packageInfo);
        if (declared && !Array.isArray(declared)) {
          map.jumpTo?.(declared);
        } else if (declared) {
          map.fitBounds?.(declared, { padding: 48, maxZoom: 16, bearing: 0, pitch: 0 });
        } else {
          map.fitBounds?.(bounds, { padding: 48, maxZoom: 16, bearing: 0, pitch: 0 });
        }
      }
    };
    // Ensure the initial geometry has been fetched even when the map is not
    // available (unit fixtures and server-side consumers still get truthful flags).
    try { await renderNetwork(); } catch (error) {
      onProgress({ value: 0, loaded, total: loaded, label: `Network geometry unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
    const activeChunks = () => chunksByAnimation[scenarioIndex] ?? [];
    const chunkFor = (tick: number, chunks: TestudoAnimationChunkDescriptor[]) => chunks.findIndex((chunk) => tick >= chunk.startTick && tick <= chunk.endTick);
    const loadChunk = async (index: number): Promise<Json> => {
      const descriptor = activeChunks()[index];
      if (!descriptor) throw new Error("No animation chunk covers the selected playback tick.");
      const cached = loadedChunks.get(descriptor.path); if (cached) return cached;
      let task = pendingChunks.get(descriptor.path);
      if (!task) {
        task = (async () => {
          let bytes = await read(descriptor.path, `Loading animation chunk ${index + 1}`);
          if (descriptor.path.endsWith(".gz")) {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
            bytes = await new Response(stream).arrayBuffer();
          }
          const parsed = await json(bytes, "Animation chunk");
          if (!parsed.events || typeof parsed.events !== "object" || Array.isArray(parsed.events)) {
            throw new Error("Animation chunk does not contain a supported events_v1 event map.");
          }
          if (disposed) throw new Error("Animation chunk belongs to a stale package generation.");
          loadedChunks.set(descriptor.path, parsed); return parsed;
        })().finally(() => pendingChunks.delete(descriptor.path));
        pendingChunks.set(descriptor.path, task);
      }
      return task;
    };
    const updateVehicles = async (tick: number) => {
      const chunks = activeChunks();
      const target = chunkFor(tick, chunks);
      if (target < 0) throw new Error("The animation manifest has no chunk for this tick.");
      currentPoints = new Map();
      // Replay chunk manifests in order up to the requested tick. Reads remain
      // lazy: seeking into a later chunk never fetches a future chunk.
      for (let i = 0; i <= target; i++) {
        const chunk = await loadChunk(i);
        if (disposed) throw new Error("Playback update belongs to a stale package generation.");
        vehiclesAtTick(chunk, i === target ? tick : chunks[i].endTick, currentPoints);
      }
      const drawing = await getOwner();
      if (drawing && !disposed) {
        const rendererModule = await import("./testudo-package-renderer");
        rendererModule.drawVehicles(drawing, [...currentPoints.values()]);
      }
      state = { ...state, loading: false, available: true };
      vehicleCapability.available = true; delete vehicleCapability.reason;
    };
    const updateIfAnimationAvailable = async (tick: number) => {
      if (!activeChunks().length) return;
      try { await updateVehicles(tick); }
      catch (error) {
        if (disposed) throw error;
        vehicleCapability.available = false;
        vehicleCapability.reason = `Animation chunk unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    try {
      if (activeChunks().length) await updateVehicles(0);
      else state = { ...state, loading: false };
    } catch (error) {
      state = { ...state, loading: false };
      vehicleCapability.available = false;
      vehicleCapability.reason = `Animation data could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      onProgress({ value: 0, loaded, total: loaded, label: `Vehicle animation unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
    onProgress({ value: 100, loaded, total: loaded, label: bootstrap.label || "Testudo package ready" });
    const capabilities = [
      vehicleCapability,
      capability("network-kpi", false, "Packaged results data is not decoded in Stage 1."),
      capability("path-analysis", false, "Path assignment artifacts are not loaded in Stage 1."),
      capability("emissions-h3", false, "Environmental emissions data is not loaded in Stage 1."),
      capability("scenario-comparison", false, "Comparison results data is not decoded in Stage 1."),
    ];
    const assertScope = (tviewId: string, generation: number) => {
      if (tviewId !== context.tviewId || generation !== context.generation || disposed) throw new Error("Playback command belongs to a stale Testudo package.");
    };
    return {
      context, capabilities, scenarios, ...(scenarios[0] ? { selectedScenarioId: scenarios[0].id } : {}),
      playbackRange: { maxTick, dt: structure.dt },
      playback: {
        getPlaybackState(tviewId, generation) { assertScope(tviewId, generation); return { ...state }; },
        async play(tviewId, generation) {
          assertScope(tviewId, generation); stopPlayback();
          state = { ...state, playing: state.tick < state.maxTick };
          if (state.playing) interval = setInterval(() => {
            if (disposed) { stopPlayback(); return; }
            state = { ...state, tick: Math.min(state.maxTick, state.tick + 1) };
            if (state.tick >= state.maxTick) { state.playing = false; stopPlayback(); }
            void updateIfAnimationAvailable(state.tick).catch((error) => {
              if (!disposed) { vehicleCapability.available = false; vehicleCapability.reason = `Animation chunk unavailable: ${error instanceof Error ? error.message : String(error)}`; }
            }).finally(publishPlayback);
          }, Math.max(16, Math.round(1000 * state.dt / state.speed)));
          return publishPlayback();
        },
        pause(tviewId, generation) { assertScope(tviewId, generation); stopPlayback(); state = { ...state, playing: false }; return publishPlayback(); },
        async restart(tviewId, generation) { assertScope(tviewId, generation); stopPlayback(); state = { ...state, playing: false, tick: 0 }; await updateIfAnimationAvailable(0); return publishPlayback(); },
        async seek(tviewId, generation, tick) { assertScope(tviewId, generation); stopPlayback(); state = { ...state, playing: false, tick: Math.min(maxTick, Math.trunc(tick)) }; await updateIfAnimationAvailable(state.tick); return publishPlayback(); },
        async setSpeed(tviewId, generation, speed) { assertScope(tviewId, generation); const playing = state.playing; stopPlayback(); state = { ...state, playing: false, speed }; return playing ? this.play(tviewId, generation) : publishPlayback(); },
        subscribe(listener) { playbackListeners.add(listener); return () => playbackListeners.delete(listener); },
      },
      async onPlaybackTick(tviewId, generation, playback) {
        assertScope(tviewId, generation);
        if (!activeChunks().length) return;
        state = { ...playback, available: true, loading: true };
        try { await updateVehicles(playback.tick); }
        catch (error) {
          vehicleCapability.available = false;
          vehicleCapability.reason = `Animation chunk unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
      selectScenario(id) {
        const index = scenarios.findIndex((scenario) => scenario.id === id);
        if (index < 0) throw new Error(`Scenario ${id} is not declared in this package.`);
        scenarioIndex = index; loadedChunks.clear(); currentPoints.clear();
        return id;
      },
      setMapControl(controlId, visible) {
        if (controlId === "legend") {
          if (!owner) throw new Error("The package network legend layers are unavailable until network geometry is loaded.");
          legendVisible = visible; owner.setNetworkVisible(visible);
          kpiGeometry = { ...kpiGeometry, showSections: visible };
          return true;
        }
        if (controlId === "esri-world-imagery") {
          if (!owner || !map) throw new Error("Esri World Imagery requires an active MapLibre map.");
          owner.setEsriWorldImagery(visible); esriWorldImageryVisible = visible; return true;
        }
        if (controlId === "network-sections" || controlId === "sections") { owner?.setVisible("network-sections", visible); return sectionsLoaded; }
        if (controlId === "network-nodes" || controlId === "nodes") { owner?.setVisible("network-nodes", visible); return nodesLoaded; }
        if (controlId === "network-centroids" || controlId === "centroids") { owner?.setVisible("network-centroids", visible); return centroidsLoaded; }
        if (controlId === "network-lanes" || controlId === "lanes") { owner?.setVisible("network-lanes", visible); return lanesLoaded; }
        return false;
      },
      getMapControlState() { return { legendVisible, esriWorldImageryVisible, renderer }; },
      setRenderer(next) { if (next === "cesium") throw new Error("Cesium rendering is unavailable in the GeoLibre Testudo iframe."); renderer = next; return renderer; },
      setKpiGeometry(geometry, visible) {
        if (geometry === "lanes") {
          if (!lanesLoaded || !owner) throw new Error("Lane geometry is unavailable in this package.");
          owner.setVisible("network-lanes", visible);
          kpiGeometry = { ...kpiGeometry, showLanes: visible };
          return { ...kpiGeometry };
        }
        if (!sectionsLoaded || !owner) throw new Error("Section geometry is unavailable until the package network is loaded.");
        owner.setVisible("network-sections", visible);
        kpiGeometry = { ...kpiGeometry, showSections: visible };
        return { ...kpiGeometry };
      },
      getKpiGeometryState() { return { ...kpiGeometry }; },
      getCameraView() {
        if (!map?.getCenter || !map.getZoom) return null;
        const center = map.getCenter(); const zoom = map.getZoom();
        const bearing = map.getBearing?.() ?? 0; const pitch = map.getPitch?.() ?? 0;
        if (![center.lng, center.lat, zoom, bearing, pitch].every(Number.isFinite)) return null;
        return { center: [center.lng, center.lat], zoom, bearing, pitch };
      },
      setCameraView(view) {
        if (!map?.jumpTo) throw new Error("Map camera is unavailable.");
        const validated = validateTestudoCameraView(view);
        cameraWasSetByHostOrUser = true;
        map.jumpTo(validated);
      },
      dispose() { disposed = true; map?.off?.("movestart", onMapMoveStart); stopPlayback(); playbackListeners.clear(); owner?.remove(); owner = null; loadedChunks.clear(); pendingChunks.clear(); currentPoints.clear(); },
    };
  },
};

let unregisterProvider: (() => void) | undefined;
export function registerTestudoVehiclePlaybackProvider(): () => void {
  if (!unregisterProvider) unregisterProvider = registerTestudoPackageProvider({ capability: "vehicle-playback", factory: testudoVehiclePlaybackProvider }, "geolibre-vehicle-playback");
  return () => { unregisterProvider?.(); unregisterProvider = undefined; };
}
