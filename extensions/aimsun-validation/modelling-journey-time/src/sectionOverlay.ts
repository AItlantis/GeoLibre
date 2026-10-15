/**
 * C12 map layer: the SELECTED route drawn as per-section coloured lines. A plugin-owned MapLibre source
 * 'aimsun-jt-sections' with a casing layer and a line layer (colour = feature `stroke`), separate from the route overlay
 * ('aimsun-jt-overlay'). Re-added on style reload, removed (layers, source, listeners, tooltip) on remove()/dispose.
 * A hover tooltip (section id, travel time, delay, speed) is a plain DOM node in the map container.
 */
import type { GeoJSONFC, HostApp, HostMapLike } from "./host";
import { zoomCasingWidth, zoomLineWidth } from "./linePaint";
import { SECTION_LINE_WIDTH } from "./sections";

export const SECTIONS_SRC = "aimsun-jt-sections";
export const SECTIONS_CASING = "aimsun-jt-sections-casing";
export const SECTIONS_LINE = "aimsun-jt-sections-line";

/** Paint of the casing / line layers: constant base width (section length is visible on the map), zoom-aligned for tilted maps. */
export const sectionCasingPaint = (): Record<string, unknown> => ({ "line-color": "#ffffff", "line-width": zoomCasingWidth(SECTION_LINE_WIDTH), "line-opacity": 0.85 });
export const sectionLinePaint = (): Record<string, unknown> => ({ "line-color": ["get", "stroke"], "line-width": zoomLineWidth(SECTION_LINE_WIDTH), "line-opacity": 1 });

export class SectionOverlay {
  private map: HostMapLike | null = null;
  private data: GeoJSONFC | null = null;
  private tip: HTMLElement | null = null;
  private listening = false;
  private readonly onStyle = (): void => {
    if (this.map && this.data && !this.map.getSource(SECTIONS_SRC)) this.apply(this.map, this.data);
  };
  private readonly onMove = (e?: any): void => this.move(e);
  private readonly onLeave = (): void => this.leave();

  constructor(private readonly getApp: () => HostApp | null) {}

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
      const src = map.getSource(SECTIONS_SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(fc);
      else map.addSource(SECTIONS_SRC, { type: "geojson", data: fc });
      if (!map.getLayer(SECTIONS_CASING)) {
        map.addLayer({
          id: SECTIONS_CASING, type: "line", source: SECTIONS_SRC,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: sectionCasingPaint(),
        });
      }
      if (!map.getLayer(SECTIONS_LINE)) {
        map.addLayer({
          id: SECTIONS_LINE, type: "line", source: SECTIONS_SRC,
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: sectionLinePaint(),
        });
      }
      if (!this.listening) {
        map.on?.("mousemove", SECTIONS_LINE, this.onMove);
        map.on?.("mouseleave", SECTIONS_LINE, this.onLeave);
        this.listening = true;
      }
    } catch {
      /* the style is not ready: the styledata listener retries */
    }
  }

  private move(e?: any): void {
    const map = this.map;
    const f = e?.features?.[0];
    if (!map || !f || !map.getContainer) return;
    const c = map.getContainer();
    if (map.getCanvas) map.getCanvas().style.cursor = "pointer";
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "av-tip";
      this.tip.style.cssText = "position:absolute;inset-block-start:0;inset-inline-start:0;pointer-events:none;z-index:5;padding:4px 6px;border-radius:4px;background:rgba(0,0,0,.78);color:#fff;font-size:11px;white-space:nowrap";
      c.appendChild(this.tip);
    }
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const fmt = (v: unknown, d: number): string => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "-" : Number(v).toFixed(d));
    const lines = [
      `${String(p.route ?? "")} - section ${String(p.section_id ?? "")} (#${String(p.seq ?? "")})`,
      `travel time ${fmt(p.ttime_s, 1)} s`,
      `delay ${fmt(p.dtime_s, 1)} s`,
      `speed ${fmt(p.speed_kmh, 1)} km/h`,
    ];
    this.tip.replaceChildren(...lines.map((l) => { const d = document.createElement("div"); d.textContent = l; return d; }));
    const rtl = getComputedStyle(c).direction === "rtl";
    const x = rtl ? e.point.x - c.clientWidth : e.point.x;
    this.tip.style.transform = `translate(${x + 12}px, ${e.point.y + 12}px)`;
    this.tip.style.display = "block";
  }

  private leave(): void {
    if (this.map?.getCanvas) this.map.getCanvas().style.cursor = "";
    if (this.tip) this.tip.style.display = "none";
  }

  private detach(): void {
    const map = this.map;
    if (map) {
      map.off?.("styledata", this.onStyle);
      if (this.listening) {
        map.off?.("mousemove", SECTIONS_LINE, this.onMove);
        map.off?.("mouseleave", SECTIONS_LINE, this.onLeave);
      }
    }
    this.listening = false;
    this.tip?.remove();
    this.tip = null;
    this.map = null;
  }

  remove(): void {
    const map = this.map;
    this.data = null;
    if (map) {
      try {
        if (map.getLayer(SECTIONS_LINE)) map.removeLayer(SECTIONS_LINE);
        if (map.getLayer(SECTIONS_CASING)) map.removeLayer(SECTIONS_CASING);
        if (map.getSource(SECTIONS_SRC)) map.removeSource(SECTIONS_SRC);
      } catch {
        /* map already torn down */
      }
    }
    this.detach();
  }
}
