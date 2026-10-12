/**
 * Map overlay shared by the OD plugins: a few GeoJSON sources drawn with data-driven MapLibre layers
 * (line width / circle radius / colour come from per-feature properties `w`, `r`, `c`, which
 * addGeoJsonLayer's single-style layers cannot express), mirrored into the Layers panel with
 * registerExternalNativeLayer (opacity + visibility bridge). Hover shows a DOM tooltip with the
 * feature's `tip` property. All positions are EPSG:4326.
 *
 * Why not addGeoJsonLayer: it stores one uniform style per layer in the project and re-reads the
 * data from the store; desire lines need per-feature widths and diverging colours and are recomputed
 * on every selection change, so they stay plugin-owned native layers (the detector plugins do the same).
 */
import type { FC } from "./calc.ts";
import { boundsOf } from "./calc.ts";
import type { AppLike, MapLike } from "./host.ts";

export interface OverlayLayerSpec {
  id: string;
  source: string;
  type: "line" | "circle";
  /** Extra paint merged over the defaults. */
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  minzoom?: number;
}

export class MapOverlay {
  private map: MapLike | null = null;
  private data = new Map<string, FC<any>>();
  private tip: HTMLElement | null = null;
  private registered = false;
  private opacity = 0.85;
  private disposed = false;
  private readonly moves: Array<[string, (e: any) => void, () => void]> = [];
  private readonly onStyleData = (): void => {
    if (this.disposed || !this.map || !this.specs.length || this.map.getSource(this.sid(this.specs[0].source))) return;
    this.ensure();
  };

  constructor(
    private readonly app: AppLike,
    private readonly id: string,
    private readonly name: string,
    private readonly specs: readonly OverlayLayerSpec[],
  ) {}

  private sid(source: string): string {
    return `${this.id}-${source}`;
  }
  private lid(spec: OverlayLayerSpec): string {
    return `${this.id}-${spec.id}`;
  }

  get available(): boolean {
    return !!this.app.getMap?.();
  }

  /** Replace one source's data (creates the layers on first use). */
  set(source: string, fc: FC<any>): void {
    this.data.set(source, fc);
    this.ensure();
    this.register();
  }

  clear(): void {
    for (const k of this.data.keys()) this.data.set(k, { type: "FeatureCollection", features: [] });
    this.ensure();
  }

  private ensure(): void {
    const map = this.app.getMap?.() ?? null;
    if (!map || this.disposed || !this.specs.length) return;
    try {
      if (this.map !== map) {
        this.detach();
        this.map = map;
        map.on("styledata", this.onStyleData);
      }
      for (const spec of this.specs) {
        const sid = this.sid(spec.source);
        const fc = this.data.get(spec.source) ?? { type: "FeatureCollection", features: [] };
        const existing = map.getSource(sid);
        if (existing?.setData) {
          existing.setData(fc);
          continue;
        }
        map.addSource(sid, { type: "geojson", data: fc });
      }
      for (const spec of this.specs) {
        const lid = this.lid(spec);
        if (map.getLayer(lid)) continue;
        const paint =
          spec.type === "line"
            ? { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": this.opacity, ...spec.paint }
            : { "circle-color": ["get", "c"], "circle-radius": ["get", "r"], "circle-opacity": this.opacity, "circle-stroke-width": 1, "circle-stroke-color": "#ffffff", ...spec.paint };
        map.addLayer({
          id: lid,
          type: spec.type,
          source: this.sid(spec.source),
          paint,
          layout: spec.type === "line" ? { "line-cap": "round", ...spec.layout } : spec.layout ?? {},
          ...(spec.minzoom !== undefined ? { minzoom: spec.minzoom } : {}),
        });
        const mv = (e: any): void => this.move(e);
        const lv = (): void => this.leave();
        map.on("mousemove", lid, mv);
        map.on("mouseleave", lid, lv);
        this.moves.push([lid, mv, lv]);
      }
    } catch (e) {
      // style still loading: the styledata hook retries
      if (typeof console !== "undefined") console.debug("[aimsun] overlay deferred:", e);
    }
  }

  private register(): void {
    if (!this.app.registerExternalNativeLayer || !this.map || !this.specs.length) return;
    const first = this.specs[0];
    this.app.registerExternalNativeLayer({
      id: this.id,
      name: this.name,
      type: "geojson",
      nativeLayerIds: this.specs.map((s) => this.lid(s)),
      sourceIds: [...new Set(this.specs.map((s) => this.sid(s.source)))],
      sourceId: this.sid(first.source),
      geojson: this.data.get(first.source),
      paintMode: "plugin",
      paintBridge: {
        setOpacity: (o) => {
          this.opacity = o;
          for (const s of this.specs) {
            try {
              this.map?.setPaintProperty(this.lid(s), s.type === "line" ? "line-opacity" : "circle-opacity", o);
            } catch {
              /* layer gone */
            }
          }
        },
        setVisibility: (v) => {
          for (const s of this.specs) {
            try {
              this.map?.setLayoutProperty(this.lid(s), "visibility", v ? "visible" : "none");
            } catch {
              /* layer gone */
            }
          }
        },
      },
    });
    this.registered = true;
  }

  /** Zoom the map to the union of all current features. */
  fit(): void {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const fc of this.data.values()) {
      const b = boundsOf(fc);
      if (b) {
        w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]);
      }
    }
    if (w <= e && this.app.fitBounds) this.app.fitBounds([w, s, e, n]);
  }

  zoomTo(lon: number, lat: number, zoom = 12): void {
    const map = this.app.getMap?.();
    if (map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), essential: true });
  }

  private move(ev: any): void {
    const map = this.map;
    const f = ev?.features?.[0];
    const text = f?.properties?.tip;
    if (!map || typeof text !== "string") return;
    map.getCanvas().style.cursor = "pointer";
    const c = map.getContainer();
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "ao-tip";
      c.appendChild(this.tip);
    }
    this.tip.replaceChildren(
      ...text.split("\n").map((line, i) => {
        const d = document.createElement("div");
        if (i === 0) d.className = "ao-tip-title";
        d.textContent = line;
        return d;
      }),
    );
    // inset-inline-start anchors at the right edge in RTL, so shift by the container width there
    const rtl = getComputedStyle(c).direction === "rtl";
    const x = rtl ? ev.point.x - c.clientWidth : ev.point.x;
    this.tip.style.transform = `translate(${x + 12}px, ${ev.point.y + 12}px)`;
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
      for (const [lid, mv, lv] of this.moves) {
        m.off("mousemove", lid, mv);
        m.off("mouseleave", lid, lv);
      }
      this.moves.length = 0;
      for (const s of [...this.specs].reverse()) if (m.getLayer(this.lid(s))) m.removeLayer(this.lid(s));
      for (const s of new Set(this.specs.map((x) => this.sid(x.source)))) if (m.getSource(s)) m.removeSource(s);
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
