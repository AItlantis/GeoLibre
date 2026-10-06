import type { FeatureCollection } from "geojson";
import type { TestudoMapHandle } from "../shared/testudo-feature-session";
import { pointCollection, type TestudoVehiclePoint } from "./testudo-package-data";

export interface TestudoLayerOwner {
  addGeoJson(id: string, data: FeatureCollection, kind: "line" | "circle", metricColorProperty?: string): void;
  setData(id: string, data: FeatureCollection): void;
  setVisible(id: string, visible: boolean): void;
  /** Keep metric legend publication typed; the session exposes the legend data to the shell. */
  setLegend(id: string, title: string, low: string, lowColor: string, high: string, highColor: string): void;
  setEsriWorldImagery(visible: boolean): void;
  remove(): void;
}

/** MapLibre layer mutations are scoped to unique ids for this package generation. */
export function createTestudoLayerOwner(map: TestudoMapHandle, namespace: string): TestudoLayerOwner {
  const sourceIds: string[] = [];
  const layerIds: string[] = [];
  const modeNamespace = namespace.replace(/-animation$/, "").replace(/^testudo-/, "");
  const ownedId = (id: string) => id === "vehicle-positions"
    ? `testudo-vehicle-${modeNamespace}-positions` : `${namespace}-${id}`;
  const networkLineId = `rendering-outputs.${modeNamespace}.line`;
  const esriSourceId = ownedId("esri-world-imagery");
  const esriLayerId = `${esriSourceId}-layer`;
  const addGeoJson = (id: string, data: FeatureCollection, kind: "line" | "circle", metricColorProperty?: string) => {
    id = ownedId(id);
    if (map.getSource(id)) return;
    map.addSource(id, { type: "geojson", data }); sourceIds.push(id);
    const layerId = `${id}-layer`;
    map.addLayer(kind === "line" ? {
      id: layerId, type: "line", source: id,
      paint: { "line-color": metricColorProperty ? ["get", metricColorProperty] : "#d97706", "line-width": 4, "line-opacity": 0.9 },
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
    setLegend(_id, _title, _low, _lowColor, _high, _highColor) {
      // Result legend values are exposed by the active session's
      // getPlaybackValues(); do not create a competing map legend here.
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
        const imagery = { id: esriLayerId, type: "raster", source: esriSourceId };
        if (map.getLayer(networkLineId)) map.addLayer(imagery, networkLineId);
        else map.addLayer(imagery);
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

export function drawVehicles(owner: TestudoLayerOwner, points: TestudoVehiclePoint[]): void {
  const id = "vehicle-positions";
  const data = pointCollection(points);
  // Create a valid empty FeatureCollection on the first playback update.
  owner.addGeoJson(id, data, "circle");
  owner.setData(id, data);
}
