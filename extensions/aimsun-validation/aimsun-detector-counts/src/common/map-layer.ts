/**
 * Detector points on the map. The layer is added natively (data-driven circle size/colour,
 * which addGeoJsonLayer's single-style layers cannot express) and mirrored into the Layers
 * panel with registerExternalNativeLayer. Hover shows a DOM tooltip, click selects.
 */
import type { DetFeatureCollection } from "./geo.ts";
import type { AppLike, MapLike } from "./host.ts";

export interface CircleStyle {
  radius: unknown;
  color: unknown;
}

export interface MapLayerHooks {
  /** Lines shown in the hover tooltip (already translated/formatted). */
  describe: (props: Record<string, unknown>) => string[];
  onSelect: (eid: string) => void;
}

const SELECT_COLOR = "#0b57d0";

export class DetectorMapLayer {
  private map: MapLike | null = null;
  private fc: DetFeatureCollection = { type: "FeatureCollection", features: [] };
  private style: CircleStyle;
  private selected: [number, number] | null = null;
  private tip: HTMLElement | null = null;
  private readonly src: string;
  private readonly pts: string;
  private readonly selSrc: string;
  private readonly sel: string;
  private registered = false;
  private opacity = 0.85;
  private disposed = false;
  private readonly onMove = (e: any): void => this.move(e);
  private readonly onLeave = (): void => this.leave();
  private readonly onClick = (e: any): void => {
    const eid = e?.features?.[0]?.properties?.eid;
    if (eid !== undefined && eid !== null && eid !== "") this.hooks.onSelect(String(eid));
  };
  private readonly onStyleData = (): void => {
    if (this.disposed || !this.map || this.map.getSource(this.src)) return;
    this.ensure();
  };

  constructor(
    private readonly app: AppLike,
    private readonly id: string,
    private readonly name: string,
    private readonly hooks: MapLayerHooks,
    initialStyle: CircleStyle,
  ) {
    this.src = `${id}-src`;
    this.pts = `${id}-pts`;
    this.selSrc = `${id}-sel-src`;
    this.sel = `${id}-sel`;
    this.style = initialStyle;
  }

  /** True when a map is available (otherwise the plugin stays in table/chart-only mode). */
  get available(): boolean {
    return !!this.app.getMap?.();
  }

  update(fc: DetFeatureCollection, style: CircleStyle): void {
    this.fc = fc;
    this.style = style;
    this.ensure();
    this.register();
  }

  /** Empty the layer if it exists; never creates one (degraded mode draws nothing). */
  clear(): void {
    this.selected = null;
    if (!this.map?.getSource(this.src)) return;
    this.update({ type: "FeatureCollection", features: [] }, this.style);
    this.setSelected(null);
  }

  private ensure(): void {
    const map = this.app.getMap?.() ?? null;
    if (!map || this.disposed) return;
    try {
      if (this.map !== map) {
        this.detach();
        this.map = map;
        map.on("styledata", this.onStyleData);
      }
      const existing = map.getSource(this.src);
      if (existing?.setData) {
        existing.setData(this.fc);
        map.setPaintProperty(this.pts, "circle-radius", this.style.radius);
        map.setPaintProperty(this.pts, "circle-color", this.style.color);
        return;
      }
      map.addSource(this.src, { type: "geojson", data: this.fc });
      map.addLayer({
        id: this.pts,
        type: "circle",
        source: this.src,
        paint: {
          "circle-radius": this.style.radius,
          "circle-color": this.style.color,
          "circle-opacity": this.opacity,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addSource(this.selSrc, { type: "geojson", data: this.selectedData() });
      map.addLayer({
        id: this.sel,
        type: "circle",
        source: this.selSrc,
        paint: { "circle-radius": 14, "circle-color": SELECT_COLOR, "circle-opacity": 0.15, "circle-stroke-width": 2.5, "circle-stroke-color": SELECT_COLOR },
      });
      map.on("mousemove", this.pts, this.onMove);
      map.on("mouseleave", this.pts, this.onLeave);
      map.on("click", this.pts, this.onClick);
    } catch (e) {
      // style still loading: the styledata hook retries
      if (typeof console !== "undefined") console.debug("[aimsun] map layer deferred:", e);
    }
  }

  private register(): void {
    if (!this.app.registerExternalNativeLayer || !this.map) return;
    this.app.registerExternalNativeLayer({
      id: this.id,
      name: this.name,
      type: "geojson",
      nativeLayerIds: [this.pts, this.sel],
      sourceIds: [this.src, this.selSrc],
      sourceId: this.src,
      geojson: this.fc,
      paintMode: "plugin",
      paintBridge: {
        setOpacity: (o) => {
          this.opacity = o;
          try {
            this.map?.setPaintProperty(this.pts, "circle-opacity", o);
          } catch {
            /* layer gone */
          }
        },
        setVisibility: (v) => {
          try {
            for (const l of [this.pts, this.sel]) this.map?.setLayoutProperty(l, "visibility", v ? "visible" : "none");
          } catch {
            /* layer gone */
          }
        },
      },
    });
    this.registered = true;
  }

  private selectedData(): unknown {
    return {
      type: "FeatureCollection",
      features: this.selected ? [{ type: "Feature", geometry: { type: "Point", coordinates: this.selected }, properties: {} }] : [],
    };
  }

  setSelected(lonLat: [number, number] | null): void {
    this.selected = lonLat;
    try {
      this.map?.getSource(this.selSrc)?.setData?.(this.selectedData());
    } catch {
      /* not mounted yet */
    }
  }

  /** Centre on a point (close zoom), through the map when there is one, else fitBounds. */
  zoomTo(lon: number, lat: number): void {
    const map = this.app.getMap?.();
    if (map) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16), essential: true });
    } else if (this.app.fitBounds) {
      const d = 0.002;
      this.app.fitBounds([lon - d, lat - d, lon + d, lat + d]);
    }
  }

  private move(e: any): void {
    const map = this.map;
    const f = e?.features?.[0];
    if (!map || !f) return;
    map.getCanvas().style.cursor = "pointer";
    const c = map.getContainer();
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "av-tip";
      c.appendChild(this.tip);
    }
    this.tip.replaceChildren(
      ...this.hooks.describe(f.properties ?? {}).map((line, i) => {
        const d = document.createElement("div");
        if (i === 0) d.className = "av-tip-title";
        d.textContent = line;
        return d;
      }),
    );
    // inset-inline-start anchors at the right edge in RTL, so shift by the container width there
    const rtl = getComputedStyle(c).direction === "rtl";
    const x = rtl ? e.point.x - c.clientWidth : e.point.x;
    this.tip.style.transform = `translate(${x + 12}px, ${e.point.y + 12}px)`;
    this.tip.style.display = "block";
  }

  private leave(): void {
    if (this.map) this.map.getCanvas().style.cursor = "";
    if (this.tip) this.tip.style.display = "none";
  }

  private detach(): void {
    const m = this.map;
    if (!m) return;
    try {
      m.off("styledata", this.onStyleData);
      m.off("mousemove", this.pts, this.onMove);
      m.off("mouseleave", this.pts, this.onLeave);
      m.off("click", this.pts, this.onClick);
      for (const l of [this.sel, this.pts]) if (m.getLayer(l)) m.removeLayer(l);
      for (const s of [this.selSrc, this.src]) if (m.getSource(s)) m.removeSource(s);
    } catch {
      /* map already torn down */
    }
    this.tip?.remove();
    this.tip = null;
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.map = null;
    if (this.registered) this.app.unregisterExternalNativeLayer?.(this.id);
    this.registered = false;
  }
}

/** Expression helpers (kept pure so they can be unit-tested). */
export function sizeExpression(prop: string, maxValue: number, minR = 3, maxR = 16): unknown {
  const m = Math.max(1, maxValue);
  return ["interpolate", ["linear"], ["sqrt", ["max", 0, ["to-number", ["get", prop], 0]]], 0, minR, Math.sqrt(m), maxR];
}

export function sequentialColor(prop: string, maxValue: number): unknown {
  const m = Math.max(1, maxValue);
  return ["interpolate", ["linear"], ["to-number", ["get", prop], 0], 0, "#fff7bc", m * 0.5, "#41ab5d", m, "#08306b"];
}

/** Blue = simulated below observed, red = above. Symmetric around 0. */
export function divergingColor(prop: string, maxAbs: number): unknown {
  const m = Math.max(1, maxAbs);
  return ["interpolate", ["linear"], ["to-number", ["get", prop], 0], -m, "#2166ac", 0, "#f7f7f7", m, "#b2182b"];
}

export const UNMATCHED_COLOR = "#7a7a7a";

export function statusColor(): unknown {
  return ["match", ["get", "status"], "pass", "#2e7d32", "warn", "#f9a825", "fail", "#c62828", UNMATCHED_COLOR];
}

/** Grey for features flagged status "unmatched" (simulated detectors with no external id). */
export function withUnmatchedColor(expr: unknown): unknown {
  return ["case", ["==", ["get", "status"], "unmatched"], UNMATCHED_COLOR, expr];
}
