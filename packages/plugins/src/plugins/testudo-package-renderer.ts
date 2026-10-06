import type { FeatureCollection } from "geojson";
import type { TestudoMapHandle } from "../shared/testudo-feature-session";
import { pointCollection, type TestudoVehiclePoint } from "./testudo-package-data";

export interface TestudoLayerOwner {
  addGeoJson(id: string, data: FeatureCollection, kind: "line" | "circle"): void;
  setData(id: string, data: FeatureCollection): void;
  setVisible(id: string, visible: boolean): void;
  setNetworkVisible(visible: boolean): void;
  setEsriWorldImagery(visible: boolean): void;
  remove(): void;
}

/** MapLibre layer mutations are scoped to unique ids for this package generation. */
export function createTestudoLayerOwner(map: TestudoMapHandle, namespace: string): TestudoLayerOwner {
  const sourceIds: string[] = [];
  const layerIds: string[] = [];
  const ownedId = (id: string) => `${namespace}-${id}`;
  const esriSourceId = ownedId("esri-world-imagery");
  const esriLayerId = `${esriSourceId}-layer`;
  const addGeoJson = (id: string, data: FeatureCollection, kind: "line" | "circle") => {
    id = ownedId(id);
    if (map.getSource(id)) return;
    map.addSource(id, { type: "geojson", data }); sourceIds.push(id);
    const layerId = `${id}-layer`;
    map.addLayer(kind === "line" ? {
      id: layerId, type: "line", source: id,
      paint: { "line-color": "#d97706", "line-width": 2, "line-opacity": 0.8 },
    } : {
      id: layerId, type: "circle", source: id,
      paint: { "circle-color": "#2563eb", "circle-radius": 4, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
    });
    layerIds.push(layerId);
  };
  return {
    addGeoJson,
    setData(id, data) { map.getSource(ownedId(id))?.setData(data); },
    setVisible(id, visible) { const target = ownedId(id); if (map.getLayer(`${target}-layer`)) map.setLayoutProperty(`${target}-layer`, "visibility", visible ? "visible" : "none"); },
    setNetworkVisible(visible) {
      for (const id of ["network-sections", "network-nodes", "network-centroids"]) {
        const layer = `${ownedId(id)}-layer`;
        if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
      }
    },
    setEsriWorldImagery(visible) {
      if (visible) {
        if (map.getSource(esriSourceId)) return;
        map.addSource(esriSourceId, {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        });
        sourceIds.push(esriSourceId);
        map.addLayer({ id: esriLayerId, type: "raster", source: esriSourceId }, `${ownedId("network-sections")}-layer`);
        layerIds.push(esriLayerId);
        return;
      }
      if (map.getLayer(esriLayerId)) map.removeLayer(esriLayerId);
      if (map.getSource(esriSourceId)) map.removeSource(esriSourceId);
    },
    remove() {
      for (const id of [...layerIds].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [...sourceIds].reverse()) if (map.getSource(id)) map.removeSource(id);
      layerIds.length = 0; sourceIds.length = 0;
    },
  };
}

export function drawNetwork(owner: TestudoLayerOwner, sections: FeatureCollection, nodes?: FeatureCollection, centroids?: FeatureCollection, lanes?: FeatureCollection): void {
  owner.addGeoJson("network-sections", sections, "line");
  if (nodes?.features?.length) owner.addGeoJson("network-nodes", nodes, "circle");
  if (centroids?.features?.length) owner.addGeoJson("network-centroids", centroids, "circle");
  if (lanes?.features?.length) {
    owner.addGeoJson("network-lanes", lanes, "line");
    owner.setVisible("network-lanes", false);
  }
}

export function drawVehicles(owner: TestudoLayerOwner, points: TestudoVehiclePoint[]): void {
  const id = "vehicle-positions";
  const data = pointCollection(points);
  // Create a valid empty FeatureCollection on the first playback update.
  owner.addGeoJson(id, data, "circle");
  owner.setData(id, data);
}
