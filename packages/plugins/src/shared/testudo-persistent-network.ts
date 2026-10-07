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

/** Mounts the package network once per Testudo generation and owns its cleanup. */
export class TestudoPersistentNetwork {
  private map: TestudoMapHandle | null = null;
  private readonly mountState = new TestudoGenerationMount();

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
      if (isCurrent(context) && this.map === map) this.addGeometry(map, geometry);
    });
  }

  clear(): void {
    if (this.map) {
      for (const id of Object.values(TESTUDO_NETWORK_LAYERS)) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        if (this.map.getSource(id)) this.map.removeSource(id);
      }
    }
    this.mountState.clear();
    this.map = null;
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
        id, type, source: id, layout: { visibility: "visible" },
        ...(key === "sections" ? { maxzoom: 17 } : key === "lanes" ? { minzoom: 17 } : {}),
        paint: { "line-color": "#94a3b8", "line-width": width, "line-opacity": 60 / 255 },
      } : {
        id, type, source: id, layout: { visibility: "visible" },
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
