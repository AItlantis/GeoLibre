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
    if (this.mountState.isMounted(context.generation)) return true;
    this.clear();
    this.map = map;
    return this.mountState.mount(context.generation, () => isCurrent(context) && this.map === map, async () => {
      const source = createNetworkKpiDirectorySource(directory);
      const networkManifest = parseNetworkKpiManifest(manifestRaw, null);
      const geometry = await loadNetworkKpiGeometry(source, networkManifest.geometry);
      await this.waitForStyle(map);
      if (isCurrent(context) && this.map === map) {
        this.addGeometry(map, geometry);
        if (this.esriVisible) this.ensureEsriImagery(map);
      }
    });
  }

  clear(): void {
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
    this.visibility = { sections: true, lanes: true, turns: true, nodes: true };
    this.esriVisible = false;
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
    } else map.setLayoutProperty(TestudoPersistentNetwork.esriLayer, "visibility", "visible");
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
      map.addSource(id, { type: "geojson", data });
      map.addLayer(type === "line" ? {
        id, type, source: id, layout: { visibility: this.visibility[key] ? "visible" : "none" },
        ...(key === "sections" ? { maxzoom: 17 } : key === "lanes" ? { minzoom: 17 } : {}),
        paint: { "line-color": "#94a3b8", "line-width": width, "line-opacity": 60 / 255 },
      } : {
        id, type, source: id, layout: { visibility: this.visibility[key] ? "visible" : "none" },
        paint: { "fill-color": "#94a3b8", "fill-opacity": 60 / 255 },
      });
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
