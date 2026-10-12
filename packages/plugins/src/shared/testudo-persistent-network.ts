import { loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiGeometry } from "../plugins/network-kpi-data";
import { createNetworkKpiDirectorySource, type NetworkKpiDirectoryHandle } from "../plugins/network-kpi-data";
import type { TestudoFeatureContext, TestudoMapHandle } from "./testudo-feature-session";
import { TestudoGenerationMount } from "./testudo-generation-resources";
import { laneWidthMetersExpression, metersLineWidthExpression, sectionWidthMetersExpression } from "./map-ground-width";

export const TESTUDO_NETWORK_LAYERS = {
  sections: "testudo-network-sections",
  lanes: "testudo-network-lanes",
  turns: "testudo-network-turns",
  nodes: "testudo-network-nodes",
} as const;
export type TestudoNetworkGeometry = keyof typeof TESTUDO_NETWORK_LAYERS;
export type TestudoNetworkGeometryState = Record<`show${Capitalize<TestudoNetworkGeometry>}`, boolean>;

const packageLoadTraceStartedAt = Date.now();
function tracePersistentNetwork(stage: string, phase: "start" | "complete", details: Record<string, unknown> = {}): void {
  try {
    if (typeof localStorage === "undefined" || localStorage.getItem("testudo_bridge_trace") !== "1") return;
    console.info("[TestudoBridgeTrace:PersistentNetwork]", stage, {
      phase,
      elapsedMs: Date.now() - packageLoadTraceStartedAt,
      ...details,
    });
  } catch { /* diagnostics must never affect package loading */ }
}

/** Mounts comparison-specific package geometry directly on one map instance. */
export function mountTestudoComparisonGeometry(
  map: TestudoMapHandle,
  geometry: NetworkKpiGeometry | null,
  prefix: string,
): () => void {
  let active = true;
  const entries = [
    ["sections", geometry?.sections, "line", 2.2],
    ["lanes", geometry?.lanes, "line", 1.3],
    ["turns", geometry?.turns, "line", 1.5],
  ] as const;
  const ownedEntries = entries.filter(([, data]) => Boolean(data?.features.length));
  const ids = ownedEntries.map(([key]) => `${prefix}-${key}`);
  const add = () => {
    if (!active || map.isStyleLoaded?.() === false) return;
    for (const [key, data, type, width] of ownedEntries) {
      if (!data?.features.length) continue;
      const id = `${prefix}-${key}`;
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data });
      if (map.getLayer(id)) continue;
      const beforeId = map.getStyle?.().layers?.find(layer => layer.id && layer.type !== "background")?.id;
      map.addLayer({
        id, type, source: id,
        ...(key === "sections" ? { maxzoom: 17 } : key === "lanes" ? { minzoom: 17 } : {}),
        layout: { visibility: "visible" },
        paint: {
          "line-color": "#94a3b8",
          "line-width": key === "sections" ? metersLineWidthExpression(sectionWidthMetersExpression())
            : key === "lanes" ? metersLineWidthExpression(laneWidthMetersExpression()) : width,
          "line-opacity": 60 / 255,
        },
      }, beforeId);
    }
  };
  const removeOwned = () => {
    for (const id of [...ids].reverse()) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  };
  const onStyleData = () => {
    if (!active || map.isStyleLoaded?.() === false) return;
    // A style replacement drops the map-owned resources. Recreate only what is
    // missing; never remove healthy owned layers during repeated styledata.
    if (ids.some(id => !map.getLayer(id) || !map.getSource(id))) add();
  };
  map.on?.("styledata", onStyleData);
  add();
  return () => {
    if (!active) return;
    active = false;
    map.off?.("styledata", onStyleData);
    removeOwned();
  };
}

/** Mounts the package network once per Testudo generation and owns its cleanup. */
export class TestudoPersistentNetwork {
  private map: TestudoMapHandle | null = null;
  private geometry: NetworkKpiGeometry | null = null;
  private generation = 0;
  private isCurrent: ((context: TestudoFeatureContext) => boolean) | null = null;
  private context: TestudoFeatureContext | null = null;
  private readonly styleListeners = new Map<TestudoMapHandle, (event?: { originalEvent?: unknown }) => void>();
  private readonly mountState = new TestudoGenerationMount();
  private visibility: Record<TestudoNetworkGeometry, boolean> = { sections: true, lanes: true, turns: true, nodes: true };
  private pathsModeSnapshot: { generation: number; visibility: Record<TestudoNetworkGeometry, boolean> } | null = null;
  private esriVisible = false;
  private static readonly esriSource = "testudo-esri-world-imagery";
  private static readonly esriLayer = "testudo-esri-world-imagery";

  async mount(
    context: TestudoFeatureContext,
    directory: NetworkKpiDirectoryHandle,
    manifestRaw: unknown,
    map: TestudoMapHandle | null,
    isCurrent: (context: TestudoFeatureContext) => boolean,
  ): Promise<boolean> {
    tracePersistentNetwork("mount-entry", "start", { hasMap: Boolean(map), isCurrent: isCurrent(context), styleLoaded: map?.isStyleLoaded?.() ?? null });
    if (!map || !isCurrent(context)) return false;
    if (this.mountState.isMounted(context.generation)) {
      this.reconcileMap(map);
      tracePersistentNetwork("already-mounted-reconcile", "complete", { styleLoaded: map.isStyleLoaded?.() ?? null });
      return true;
    }
    this.clear();
    this.map = map;
    this.context = context;
    this.generation = context.generation;
    this.isCurrent = isCurrent;
    tracePersistentNetwork("generation-mount", "start", { styleLoaded: map.isStyleLoaded?.() ?? null });
    const mounted = await this.mountState.mount(context.generation, () => isCurrent(context) && this.map === map, async () => {
      const source = createNetworkKpiDirectorySource(directory);
      const networkManifest = parseNetworkKpiManifest(manifestRaw, null);
      tracePersistentNetwork("geometry-load", "start");
      const geometry = await loadNetworkKpiGeometry(source, networkManifest.geometry);
      tracePersistentNetwork("geometry-load", "complete", {
        sections: geometry.sections?.features.length ?? 0,
        lanes: geometry.lanes?.features.length ?? 0,
        turns: geometry.turns?.features.length ?? 0,
        nodes: geometry.nodes?.features.length ?? 0,
      });
      tracePersistentNetwork("style-readiness", "complete", { styleLoaded: map.isStyleLoaded?.() ?? null });
      if (isCurrent(context) && this.map === map) {
        this.geometry = geometry;
        tracePersistentNetwork("geometry-attach", "start", { styleLoaded: map.isStyleLoaded?.() ?? null });
        this.attachMap(map);
        tracePersistentNetwork("geometry-attach", "complete", { styleLoaded: map.isStyleLoaded?.() ?? null });
        if (this.esriVisible) this.ensureEsriImagery(map);
      }
    });
    tracePersistentNetwork("generation-mount", "complete", { mounted, isCurrent: isCurrent(context), styleLoaded: map.isStyleLoaded?.() ?? null });
    tracePersistentNetwork("mount-entry", "complete", { mounted, isCurrent: isCurrent(context) });
    return mounted;
  }

  clear(): void {
    for (const [map, listener] of this.styleListeners) map.off?.("styledata", listener);
    this.styleListeners.clear();
    if (this.map) {
      for (const id of Object.values(TESTUDO_NETWORK_LAYERS)) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        if (this.map.getSource(id)) this.map.removeSource(id);
      }
      if (this.map.getLayer(TestudoPersistentNetwork.esriLayer)) this.map.removeLayer(TestudoPersistentNetwork.esriLayer);
      if (this.map.getSource(TestudoPersistentNetwork.esriSource)) this.map.removeSource(TestudoPersistentNetwork.esriSource);
    }
    this.mountState.clear();
    this.map = null;
    this.geometry = null;
    this.context = null;
    this.isCurrent = null;
    this.generation = 0;
    this.visibility = { sections: true, lanes: true, turns: true, nodes: true };
    this.pathsModeSnapshot = null;
    this.esriVisible = false;
  }

  /** Rebinds the active generation's cached geometry when the host replaces its map. */
  reconcileMap(map: TestudoMapHandle | null): void {
    const context = this.context;
    if (!map || !context || !this.geometry || !this.mountState.isMounted(this.generation)
      || context.generation !== this.generation || !this.isCurrent?.(context)) return;
    if (this.map !== map) {
      if (this.map) {
        const previousListener = this.styleListeners.get(this.map);
        if (previousListener) this.map.off?.("styledata", previousListener);
        this.styleListeners.delete(this.map);
      }
      this.map = map;
      this.attachMap(map);
      return;
    }
    this.attachMap(map);
  }

  private attachMap(map: TestudoMapHandle): void {
    if (!this.geometry || !this.context || !this.isCurrent?.(this.context)) return;
    const existing = this.styleListeners.get(map);
    if (!existing) {
      const listener = () => {
        if (this.map === map && this.context && this.isCurrent?.(this.context)) this.attachMap(map);
      };
      this.styleListeners.set(map, listener);
      map.on?.("styledata", listener);
    }
    if (map.isStyleLoaded?.() === false) return;
    this.addGeometry(map, this.geometry);
    if (this.esriVisible) this.ensureEsriImagery(map);
  }

  setVisible(geometry: TestudoNetworkGeometry, visible: boolean): TestudoNetworkGeometryState {
    this.visibility[geometry] = visible;
    const id = TESTUDO_NETWORK_LAYERS[geometry];
    if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    return this.getVisibility();
  }

  /** Apply the Paths presentation while retaining the user's prior geometry choices. */
  setPathsMode(active: boolean, generation: number): TestudoNetworkGeometryState {
    if (active) {
      if (!this.pathsModeSnapshot || this.pathsModeSnapshot.generation !== generation) {
        this.pathsModeSnapshot = { generation, visibility: { ...this.visibility } };
      }
      this.setVisible("sections", true);
      this.setVisible("lanes", false);
      this.setVisible("turns", true);
      this.setVisible("nodes", false);
      return this.getVisibility();
    }
    const snapshot = this.pathsModeSnapshot;
    this.pathsModeSnapshot = null;
    if (snapshot?.generation === generation) {
      for (const geometry of ["sections", "lanes", "turns", "nodes"] as const) {
        this.setVisible(geometry, snapshot.visibility[geometry]);
      }
    }
    return this.getVisibility();
  }

  getVisibility(): TestudoNetworkGeometryState {
    return {
      showSections: this.visibility.sections,
      showLanes: this.visibility.lanes,
      showTurns: this.visibility.turns,
      showNodes: this.visibility.nodes,
    };
  }

  setEsriWorldImagery(visible: boolean): boolean {
    if (!this.map) throw new Error("Esri World Imagery requires an active MapLibre map.");
    this.esriVisible = visible;
    if (visible) this.ensureEsriImagery(this.map);
    else if (this.map.getLayer(TestudoPersistentNetwork.esriLayer)) this.map.setLayoutProperty(TestudoPersistentNetwork.esriLayer, "visibility", "none");
    return this.esriVisible;
  }

  isEsriWorldImageryVisible(): boolean { return this.esriVisible; }

  private ensureEsriImagery(map: TestudoMapHandle): void {
    if (!map.getSource(TestudoPersistentNetwork.esriSource)) {
      map.addSource(TestudoPersistentNetwork.esriSource, {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles © Esri",
      });
    }
    if (!map.getLayer(TestudoPersistentNetwork.esriLayer)) {
      const beforeId = map.getStyle?.().layers?.find(layer => layer.id && layer.type !== "background")?.id;
      map.addLayer({ id: TestudoPersistentNetwork.esriLayer, type: "raster", source: TestudoPersistentNetwork.esriSource,
        layout: { visibility: "visible" }, paint: { "raster-opacity": 1 } }, beforeId);
    } else if (map.getLayoutProperty?.(TestudoPersistentNetwork.esriLayer, "visibility") !== "visible") {
      map.setLayoutProperty(TestudoPersistentNetwork.esriLayer, "visibility", "visible");
    }
  }

  isMounted(generation: number): boolean {
    return this.mountState.isMounted(generation);
  }

  private addGeometry(map: TestudoMapHandle, geometry: NetworkKpiGeometry): void {
    const entries = [
      ["sections", geometry.sections, "line", 2.2],
      ["lanes", geometry.lanes, "line", 1.3],
      ["turns", geometry.turns, "line", 1.5],
      ["nodes", geometry.nodes, "fill", 1],
    ] as const;
    for (const [key, data, type, width] of entries) {
      if (!data || !data.features.length) continue;
      const id = TESTUDO_NETWORK_LAYERS[key];
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data });
      if (!map.getLayer(id)) map.addLayer(type === "line" ? {
        id, type, source: id, layout: { visibility: this.visibility[key] ? "visible" : "none" },
        ...(key === "sections" ? { maxzoom: 17 } : key === "lanes" ? { minzoom: 17 } : {}),
        paint: { "line-color": "#94a3b8", "line-width": key === "sections" ? metersLineWidthExpression(sectionWidthMetersExpression()) : key === "lanes" ? metersLineWidthExpression(laneWidthMetersExpression()) : width, "line-opacity": 60 / 255 },
      } : {
        id, type, source: id, layout: { visibility: this.visibility[key] ? "visible" : "none" },
        paint: { "fill-color": "#94a3b8", "fill-opacity": 60 / 255 },
      });
      const visibility = this.visibility[key] ? "visible" : "none";
      if (map.getLayoutProperty?.(id, "visibility") !== visibility) map.setLayoutProperty(id, "visibility", visibility);
    }
  }

}
