import type { MapRendererKind } from "@geolibre/core";

// These loaders still depend on MapLibre protocols or custom render passes.
// Keep the menu and command palette in agreement until they have adapters.
// Sources drawn through the shared deck.gl overlay (Deck.gl Layer, 3D Model,
// DuckDB, 3D Tiles, LiDAR) are not listed: `@deck.gl/mapbox` hosts them on
// Mapbox natively.
const MAPBOX_UNSUPPORTED_SOURCES = new Set(["mbtiles", "splatting", "cesium-ion", "czml", "kml"]);

export function supportsAddDataRenderer(id: string, renderer: MapRendererKind): boolean {
  return renderer !== "mapbox" || !MAPBOX_UNSUPPORTED_SOURCES.has(id);
}
