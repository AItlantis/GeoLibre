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
import type { AppLike, MapLike } from "./host.ts";
import { LABEL_LAYOUT_BASE, LABEL_PAINT, labelOffsetExpression, labelSizeExpression, labelTextField, layoutDomLabels, liftPx, resolveLabelFont } from "./trips-map.ts";

const opacityKey = (t: OverlayLayerSpec["type"]): string => (t === "line" ? "line-opacity" : t === "circle" ? "circle-opacity" : t === "symbol" ? "text-opacity" : "fill-extrusion-opacity");
/** A style without a `glyphs` URL cannot draw text layers (MapLibre fails silently), so labels fall back to DOM. */
export function styleHasGlyphs(map: MapLike): boolean {
  try {
    const st = map.getStyle?.();
    if (!st) return true; // unknown: assume the host style is complete
    return typeof st.glyphs === "string" && st.glyphs.length > 0;
  } catch {
    return true;
  }
}

export interface OverlayLayerSpec {
  id: string;
  source: string;
  type: "line" | "circle" | "fill-extrusion" | "symbol";
  /** Extra paint merged over the defaults. */
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  minzoom?: number;
}

export class MapOverlay {
  private map: MapLike | null = null;
  private data = new Map<string, FC<any>>();
  private active = new Set<string>();
  private tip: HTMLElement | null = null;
  private registered = false;
  private opacity = 0.85;
  private pitchBefore: number | null = null;
  private userTilted = false;
  private programmaticPitch = false;
  private pitchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPitch = (): void => { if(this.pitchBefore!==null&&!this.programmaticPitch)this.userTilted=true; };
  private disposed = false;
  /** DOM label fallback state (basemap style without glyphs). */
  private domFallback = false;
  private domEl: HTMLElement | null = null;
  private domHidden = false;
  private readonly onDomMove = (): void => this.renderDomLabels();
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

  setLayers(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.active.size && [...next].every((id) => this.active.has(id))) return;
    if (this.registered) this.app.unregisterExternalNativeLayer?.(this.id);
    this.registered = false;
    this.detach();
    this.active = next;
    this.ensure();
    this.register();
  }

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

  setLayerOpacity(id: string, opacity: number): void {
    const spec = this.specs.find((x) => x.id === id);
    if (!spec || !this.map?.getLayer(this.lid(spec))) return;
    const key = opacityKey(spec.type);
    try { this.map.setPaintProperty(this.lid(spec), key, this.opacityExpression(spec, opacity)); } catch { /* style is changing */ }
  }

  private opacityExpression(spec: OverlayLayerSpec, opacity: number): unknown {
    const value=Math.max(0,Math.min(1,opacity));
    return ["*",value,["coalesce",["get","o"],1]];
  }

  setLayerFlowPhase(id: string, phase: number): void {
    const spec=this.specs.find(x=>x.id===id);
    if(!spec||spec.type!=="fill-extrusion"||!this.map?.getLayer(this.lid(spec)))return;
    const p=Math.max(0,Math.min(1,phase));
    try{this.map.setPaintProperty(this.lid(spec),"fill-extrusion-color",["case",["<",["abs",["-",["get","phase"],p]],0.045],"#ffc857",["get","c"]]);}catch{/* style is changing */}
  }

  setTiltForBars(enabled: boolean): void {
    const map=this.app.getMap?.();
    if(!map?.getPitch||!map.easeTo)return;
    if(enabled&&this.pitchBefore===null){
      this.pitchBefore=map.getPitch();this.userTilted=false;map.on("pitch",this.onPitch);this.programmaticPitch=true;map.easeTo({pitch:55,duration:350});
      this.pitchTimer=setTimeout(()=>{this.programmaticPitch=false;this.pitchTimer=null;},450);
    }else if(!enabled&&this.pitchBefore!==null){
      if(this.pitchTimer)clearTimeout(this.pitchTimer);this.pitchTimer=null;
      if(!this.userTilted){this.programmaticPitch=true;map.easeTo({pitch:this.pitchBefore,duration:350});setTimeout(()=>{this.programmaticPitch=false;},450);}
      map.off("pitch",this.onPitch);this.pitchBefore=null;this.userTilted=false;
    }
  }

  clear(): void {
    for (const k of this.data.keys()) this.data.set(k, { type: "FeatureCollection", features: [] });
    this.ensure();
  }

  private ensure(): void {
    const map = this.app.getMap?.() ?? null;
    if (!map || this.disposed || !this.active.size) return;
    try {
      if (this.map !== map) {
        this.detach();
        this.map = map;
        map.on("styledata", this.onStyleData);
      }
      const active = this.specs.filter((s) => this.active.has(s.id));
      for (const spec of active) {
        const sid = this.sid(spec.source);
        const fc = this.data.get(spec.source) ?? { type: "FeatureCollection", features: [] };
        const existing = map.getSource(sid);
        if (existing?.setData) {
          existing.setData(fc);
          continue;
        }
        map.addSource(sid, { type: "geojson", data: fc });
      }
      for (const spec of active) {
        const lid = this.lid(spec);
        if (map.getLayer(lid)) continue;
        const paint =
          spec.type === "line"
            ? { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["*", this.opacity, ["coalesce", ["get", "o"], 1]], ...spec.paint }
            : spec.type === "circle"
              ? { "circle-color": ["get", "c"], "circle-radius": ["get", "r"], "circle-opacity": ["*", this.opacity, ["coalesce", ["get", "o"], 1]], "circle-stroke-width": 1, "circle-stroke-color": "#ffffff", ...spec.paint }
              : spec.type === "symbol"
                ? { ...LABEL_PAINT, "text-opacity": ["*", this.opacity, ["coalesce", ["get", "o"], 1]], ...spec.paint }
                : { "fill-extrusion-color": ["get", "c"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": ["get", "base"], "fill-extrusion-opacity": this.opacity, ...spec.paint };
        if (spec.type === "symbol") {
          if (!this.addSymbolLayer(map, spec, lid, paint)) continue;
        } else {
          map.addLayer({
            id: lid,
            type: spec.type,
            source: this.sid(spec.source),
            paint,
            layout: spec.type === "line" ? { "line-cap": "round", ...spec.layout } : spec.layout ?? {},
            ...(spec.minzoom !== undefined ? { minzoom: spec.minzoom } : {}),
          });
        }
        const mv = (e: any): void => this.move(e);
        const lv = (): void => this.leave();
        map.on("mousemove", lid, mv);
        map.on("mouseleave", lid, lv);
        this.moves.push([lid, mv, lv]);
      }
      this.syncDomFallback(active.some((s) => s.type === "symbol" && !map.getLayer(this.lid(s))));
    } catch (e) {
      // style still loading: the styledata hook retries
      if (typeof console !== "undefined") console.debug("[aimsun] overlay deferred:", e);
    }
  }

  /** Adds the label layer; false when the basemap cannot draw text (DOM fallback takes over). */
  private addSymbolLayer(map: MapLike, spec: OverlayLayerSpec, lid: string, paint: Record<string, unknown>): boolean {
    if (!styleHasGlyphs(map)) return false;
    let font: string[] = ["Noto Sans Regular"];
    try { font = resolveLabelFont(map.getStyle?.()?.layers); } catch { /* keep the default */ }
    const full = { "text-field": labelTextField(), "text-font": font, "text-size": labelSizeExpression(), "text-offset": labelOffsetExpression(), ...LABEL_LAYOUT_BASE, ...spec.layout };
    const simple = { "text-field": ["get", "name"], "text-font": font, "text-size": 11, "text-offset": [0, -1.2], ...LABEL_LAYOUT_BASE, "symbol-sort-key": ["get", "sk"] };
    for (const layout of [full, simple]) {
      try {
        map.addLayer({ id: lid, type: "symbol", source: this.sid(spec.source), paint, layout, ...(spec.minzoom !== undefined ? { minzoom: spec.minzoom } : {}) });
        return true;
      } catch (e) {
        if (typeof console !== "undefined") console.debug("[aimsun] label layer variant rejected:", e);
      }
    }
    return false;
  }

  /** (De)activates the HTML label layer used when the style has no glyphs. */
  private syncDomFallback(on: boolean): void {
    const map = this.map;
    if (on === this.domFallback) {
      if (on) this.renderDomLabels();
      return;
    }
    this.domFallback = on;
    if (!map) return;
    if (on) {
      map.on("move", this.onDomMove);
      this.renderDomLabels();
    } else {
      try { map.off("move", this.onDomMove); } catch { /* map gone */ }
      this.domEl?.remove();
      this.domEl = null;
    }
  }

  private renderDomLabels(): void {
    const map = this.map;
    const spec = this.specs.find((s) => s.type === "symbol" && this.active.has(s.id));
    if (!map || !spec || !this.domFallback || !map.project || typeof document === "undefined") return;
    const c = map.getContainer();
    if (!this.domEl) {
      this.domEl = document.createElement("div");
      this.domEl.className = "ao-dom-labels";
      c.appendChild(this.domEl);
    }
    this.domEl.style.display = this.domHidden ? "none" : "block";
    this.domEl.style.opacity = String(this.opacity);
    const fc = this.data.get(spec.source) as FC<any> | undefined;
    const zoom = map.getZoom(), pitch = map.getPitch?.() ?? 0;
    const byId = new Map<string, any>();
    const items = (fc?.features ?? []).flatMap((f: any) => {
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];
      const p = map.project!([lon, lat]);
      const id = String(f.properties?.id);
      byId.set(id, f.properties);
      return [{ id, x: p.x, y: p.y, sk: Number(f.properties?.sk ?? 0), minz: Number(f.properties?.minz ?? 0), lift: liftPx(Number(f.properties?.hm ?? 0), zoom, lat, pitch) }];
    });
    const placed = layoutDomLabels(items, zoom, { w: c.clientWidth, h: c.clientHeight });
    this.domEl.replaceChildren(
      ...placed.map((p) => {
        const props = byId.get(p.id) ?? {};
        const d = document.createElement("div");
        d.className = "ao-dom-label";
        d.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
        const n = document.createElement("div");
        n.className = "ao-dom-label-name";
        n.textContent = String(props.name ?? "");
        const o = document.createElement("span");
        o.className = "ao-dom-label-out";
        o.textContent = String(props.out_s ?? "");
        const i = document.createElement("span");
        i.className = "ao-dom-label-in";
        i.textContent = String(props.in_s ?? "");
        const v = document.createElement("div");
        v.append(o, " / ", i);
        d.append(n, v);
        return d;
      }),
    );
  }

  private register(): void {
    const active = this.specs.filter((s) => this.active.has(s.id) && !(s.type === "symbol" && this.map && !this.map.getLayer(this.lid(s))));
    if (!this.app.registerExternalNativeLayer || !this.map || !active.length) return;
    const first = active[0];
    this.app.registerExternalNativeLayer({
      id: this.id,
      name: this.name,
      type: "geojson",
      nativeLayerIds: active.map((s) => this.lid(s)),
      sourceIds: [...new Set(active.map((s) => this.sid(s.source)))],
      sourceId: this.sid(first.source),
      geojson: this.data.get(first.source),
      paintMode: "plugin",
      paintBridge: {
        setOpacity: (o) => {
          this.opacity = o;
          if (this.domEl) this.domEl.style.opacity = String(o);
          for (const s of active) {
            try {
            this.map?.setPaintProperty(this.lid(s), opacityKey(s.type), this.opacityExpression(s,o));
            } catch {
              /* layer gone */
            }
          }
        },
        setVisibility: (v) => {
          this.domHidden = !v;
          if (this.domEl) this.domEl.style.display = v ? "block" : "none";
          for (const s of active) {
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

  /**
   * Intentionally a no-op: the camera is fitted once per run/package load by the plugin (RunFitter),
   * never on filter/selection changes, and never after the user moved the map.
   */
  fit(): void {}

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
      m.off("pitch",this.onPitch);
      m.off("move", this.onDomMove);
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
    this.domEl?.remove();
    this.domEl = null;
    this.domFallback = false;
  }

  dispose(): void {
    this.disposed = true;
    this.setTiltForBars(false);
    this.detach();
    this.map = null;
    if (this.registered) this.app.unregisterExternalNativeLayer?.(this.id);
    this.registered = false;
  }
}
