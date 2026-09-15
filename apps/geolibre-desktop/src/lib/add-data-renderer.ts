import type { MapRendererKind } from "@geolibre/core";

// These loaders still depend on MapLibre protocols or custom render passes.
// Keep the menu and command palette in agreement until they have adapters.
const MAPBOX_UNSUPPORTED_SOURCES = new Set([
  "mbtiles",
  "pmtiles",
  "zarr",
  "lidar",
  "splatting",
  "3d-tiles",
  "duckdb",
  "deckgl-viz",
  "gltf-model",
  "cesium-ion",
  "czml",
  "kml",
]);

export function supportsAddDataRenderer(id: string, renderer: MapRendererKind): boolean {
  return renderer !== "mapbox" || !MAPBOX_UNSUPPORTED_SOURCES.has(id);
}
