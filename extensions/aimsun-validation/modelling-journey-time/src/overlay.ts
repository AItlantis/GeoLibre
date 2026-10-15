/**
 * Live map overlay of coloured subpath lines.
 * GeoLibre's public API has no "update layer data" / "remove layer" call for addGeoJsonLayer layers,
 * so the live (re-colourable) overlay is a plugin-owned MapLibre source + line layer obtained through
 * app.getMap() (null on the Cesium globe: then only snapshots are possible). A snapshot into the real
 * Layers panel uses app.addGeoJsonLayer (features carry simplestyle `stroke`, which the host honours).
 */
import type { GeoJSONFC, HostApp, HostMapLike } from "./host";
import { zoomCasingWidth, zoomLineWidth } from "./linePaint";

const SRC = "aimsun-jt-overlay";
const LYR = "aimsun-jt-overlay-line";
export const OVERLAY_CASING = "aimsun-jt-overlay-casing";

const WIDTH = ["coalesce", ["get", "stroke-width"], 4];
const OPACITY = ["coalesce", ["get", "stroke-opacity"], 0.9];

/** Paint of the casing / line layers (exported for tests). */
export const overlayCasingPaint = (): Record<string, unknown> => ({ "line-color": "#ffffff", "line-width": zoomCasingWidth(WIDTH as unknown[]), "line-opacity": ["*", OPACITY, 0.7] });
export const overlayLinePaint = (): Record<string, unknown> => ({ "line-color": ["get", "stroke"], "line-width": zoomLineWidth(WIDTH as unknown[]), "line-opacity": OPACITY });

export class MapOverlay {
  private map: HostMapLike | null = null;
  private data: GeoJSONFC | null = null;
  private readonly onStyle = (): void => {
    if (this.map && this.data && !this.map.getSource(SRC)) this.apply(this.map, this.data);
  };

  constructor(private readonly getApp: () => HostApp | null) {}

  /** False when no 2D MapLibre map is available (e.g. globe renderer). */
  available(): boolean {
    return !!this.getApp()?.getMap?.();
  }

  set(fc: GeoJSONFC): boolean {
    const map = this.getApp()?.getMap?.() ?? null;
    if (!map) return false;
    if (this.map && this.map !== map) this.detach();
    if (!this.map) {
      this.map = map;
      map.on?.("styledata", this.onStyle);
    }
    this.data = fc;
    this.apply(map, fc);
    return true;
  }

  private apply(map: HostMapLike, fc: GeoJSONFC): void {
    try {
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(fc);
      else map.addSource(SRC, { type: "geojson", data: fc });
      if (!map.getLayer(OVERLAY_CASING)) {
        map.addLayer({ id: OVERLAY_CASING, type: "line", source: SRC, layout: { "line-cap": "round", "line-join": "round" }, paint: overlayCasingPaint() });
      }
      if (!map.getLayer(LYR)) {
        map.addLayer({ id: LYR, type: "line", source: SRC, layout: { "line-cap": "round", "line-join": "round" }, paint: overlayLinePaint() });
      }
    } catch {
      /* the style may be mid-reload: onStyle retries on the next styledata */
    }
  }

  private detach(): void {
    this.map?.off?.("styledata", this.onStyle);
    this.map = null;
  }

  remove(): void {
    const map = this.map;
    this.data = null;
    if (map) {
      try {
        if (map.getLayer(LYR)) map.removeLayer(LYR);
        if (map.getLayer(OVERLAY_CASING)) map.removeLayer(OVERLAY_CASING);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        /* map already torn down */
      }
    }
    this.detach();
  }
}
