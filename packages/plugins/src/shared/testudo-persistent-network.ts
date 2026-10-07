import { loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiGeometry } from "../plugins/network-kpi-data";
import { createNetworkKpiDirectorySource, type NetworkKpiDirectoryHandle } from "../plugins/network-kpi-data";
import type { TestudoFeatureContext, TestudoMapHandle } from "./testudo-feature-session";
import { TestudoGenerationMount } from "./testudo-generation-resources";

export const TESTUDO_NETWORK_LAYERS = {
  sections: "testudo-network-sections",
  lanes: "testudo-network-lanes",
  turns: "testudo-network-turns",
  nodes: "testudo-network-nodes",
} as const;
export type TestudoNetworkGeometry = keyof typeof TESTUDO_NETWORK_LAYERS;
export type TestudoNetworkGeometryState = Record<`show${Capitalize<TestudoNetworkGeometry>}`, boolean>;

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
    if (!map || !isCurrent(context)) return false;
    if (this.mountState.isMounted(context.generation)) {
      this.reconcileMap(map);
      return true;
    }
    this.clear();
    this.map = map;
    this.context = context;
    this.generation = context.generation;
    this.isCurrent = isCurrent;
    return this.mountState.mount(context.generation, () => isCurrent(context) && this.map === map, async () => {
      const source = createNetworkKpiDirectorySource(directory);
      const networkManifest = parseNetworkKpiManifest(manifestRaw, null);
      const geometry = await loadNetworkKpiGeometry(source, networkManifest.geometry);
      await this.waitForStyle(map);
      if (isCurrent(context) && this.map === map) {
        this.geometry = geometry;
        this.attachMap(map);
        if (this.esriVisible) this.ensureEsriImagery(map);
      }
    });
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
        paint: { "line-color": "#94a3b8", "line-width": width, "line-opacity": 60 / 255 },
      } : {
        id, type, source: id, layout: { visibility: this.visibility[key] ? "visible" : "none" },
        paint: { "fill-color": "#94a3b8", "fill-opacity": 60 / 255 },
      });
      const visibility = this.visibility[key] ? "visible" : "none";
      if (map.getLayoutProperty?.(id, "visibility") !== visibility) map.setLayoutProperty(id, "visibility", visibility);
    }
  }

  private waitForStyle(map: TestudoMapHandle): Promise<void> {
    if (map.isStyleLoaded?.() !== false) return Promise.resolve();
    return new Promise(resolve => {
      const ready = () => {
        if (!map.isStyleLoaded?.()) return;
        map.off?.("styledata", ready);
        resolve();
      };
      map.on?.("styledata", ready);
    });
  }
}
