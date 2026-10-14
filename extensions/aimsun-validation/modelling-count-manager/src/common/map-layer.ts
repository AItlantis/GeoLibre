/**
 * Detector layers on the map. Everything is added natively (data-driven size/colour, which
 * addGeoJsonLayer's single-style layers cannot express) and mirrored into the Layers panel with
 * registerExternalNativeLayer. Hover shows a DOM tooltip, click selects the detector (eid).
 *
 * Old Point-only packages: one circle layer (dots) exactly as before. Packages with detector
 * coverage (contract C6) additionally get, from one extra GeoJSON source and zoom expressions:
 * dots that fade out around z16-17.5 while the coverage fill + outline (real metres) and the
 * direction glyphs (SDF arrow rotated by bearing_deg, neutral diamond for bidirectional /
 * mixed / unknown / no bearing) fade in. Metrics, colours and size ramps are shared.
 */
import type { CoverageCollection, DetFeatureCollection } from "./geo.ts";
import { GLYPH_PIXEL_RATIO, makeArrowImage, makeNeutralImage } from "./glyphs.ts";
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
const NONE = "\u0000none";
const EMPTY_COVERAGE: CoverageCollection = { type: "FeatureCollection", features: [] };

/** Zoom stops: dots stay until ~z16, polygons and arrows take over by z17.5. */
export const ZOOM = { covMin: 15, arrowMin: 16, dotFadeStart: 16, dotFadeEnd: 17.5, fillStart: 15.5, fillEnd: 17, arrowStart: 16.5, arrowEnd: 17.5 } as const;

// ---------- pure paint/layout builders (unit-tested) ----------

const zoomInterp = (...stops: unknown[]): unknown => ["interpolate", ["linear"], ["zoom"], ...stops];
/** Detector radius ramp (3-16 px) turned into a unit-less scale for glyph and outline sizes. */
const scaleOf = (radius: unknown): unknown => ["max", 0.5, ["/", radius, 8]];

export function dotOpacity(opacity: number, withCoverage: boolean): unknown {
  return withCoverage ? zoomInterp(ZOOM.dotFadeStart, opacity, ZOOM.dotFadeEnd, ["case", ["==", ["get", "cov"], true], 0, opacity]) : opacity;
}
export function dotStrokeOpacity(withCoverage: boolean): unknown {
  return withCoverage ? zoomInterp(ZOOM.dotFadeStart, 1, ZOOM.dotFadeEnd, ["case", ["==", ["get", "cov"], true], 0, 1]) : 1;
}
export function coverageFillOpacity(opacity: number): unknown {
  return zoomInterp(ZOOM.fillStart, 0, ZOOM.fillEnd, 0.45 * opacity);
}
export function coverageLineOpacity(opacity: number): unknown {
  return zoomInterp(ZOOM.fillStart, 0, ZOOM.fillEnd, opacity);
}
/** Outline weight follows the flow ramp (radius) and the zoom. */
export function coverageLineWidth(radius: unknown): unknown {
  const s = scaleOf(radius);
  return zoomInterp(16, ["*", 0.6, s], 19, ["*", 1.4, s], 21, ["*", 2.4, s]);
}
export function arrowSize(radius: unknown): unknown {
  const s = scaleOf(radius);
  return zoomInterp(16, ["*", 0.2, s], 19, ["*", 0.4, s], 21, ["*", 0.7, s]);
}
export function arrowOpacity(opacity: number): unknown {
  return zoomInterp(ZOOM.arrowStart, 0, ZOOM.arrowEnd, opacity);
}
/** Selected-detector outline filter (area features of one eid). */
export function selectedAreaFilter(eid: string | null): unknown {
  return ["all", ["==", ["get", "kind"], "area"], ["==", ["get", "eid"], eid ?? NONE]];
}

export class DetectorMapLayer {
  private readonly app: AppLike;
  private readonly id: string;
  private readonly name: string;
  private readonly hooks: MapLayerHooks;
  private map: MapLike | null = null;
  private fc: DetFeatureCollection = { type: "FeatureCollection", features: [] };
  private coverage: CoverageCollection = EMPTY_COVERAGE;
  private style: CircleStyle;
  private selected: [number, number] | null = null;
  private selectedEid: string | null = null;
  private tip: HTMLElement | null = null;
  private readonly src: string;
  private readonly pts: string;
  private readonly selSrc: string;
  private readonly sel: string;
  private readonly covSrc: string;
  private readonly covFill: string;
  private readonly covLine: string;
  private readonly covSel: string;
  private readonly arrows: string;
  private readonly arrowImg: string;
  private readonly neutralImg: string;
  private registered = false;
  private opacity = 0.85;
  private disposed = false;
  private fcSig = "";
  private covSig = "";
  private paintSig: string | null = null;
  private readonly listening = new Set<string>();
  private handlers: Array<[string, string, (e: any) => void]> = [];
  private readonly onMove = (e: any): void => this.move(e);
  private readonly onLeave = (): void => this.leave();
  private readonly onClick = (e: any): void => {
    const eid = e?.features?.[0]?.properties?.eid;
    if (eid !== undefined && eid !== null && eid !== "") this.hooks.onSelect(String(eid));
  };
  private readonly onStyleData = (): void => {
    if (this.disposed || !this.map) return;
    const baseOk = !!this.map.getSource(this.src);
    const covOk = !this.hasCoverage || !!this.map.getSource(this.covSrc);
    if (baseOk && covOk) return;
    this.ensure();
  };

  constructor(
    app: AppLike,
    id: string,
    name: string,
    hooks: MapLayerHooks,
    initialStyle: CircleStyle,
  ) {
    this.app = app;
    this.id = id;
    this.name = name;
    this.hooks = hooks;
    this.src = `${id}-src`;
    this.pts = `${id}-pts`;
    this.selSrc = `${id}-sel-src`;
    this.sel = `${id}-sel`;
    this.covSrc = `${id}-cov-src`;
    this.covFill = `${id}-cov-fill`;
    this.covLine = `${id}-cov-line`;
    this.covSel = `${id}-cov-sel`;
    this.arrows = `${id}-arrows`;
    this.arrowImg = `${id}-arrow`;
    this.neutralImg = `${id}-neutral`;
    this.style = initialStyle;
  }

  /** True when a map is available (otherwise the plugin stays in table/chart-only mode). */
  get available(): boolean {
    return !!this.app.getMap?.();
  }

  private get hasCoverage(): boolean {
    return this.coverage.features.length > 0;
  }

  update(fc: DetFeatureCollection, style: CircleStyle, coverage?: CoverageCollection): void {
    this.fc = fc;
    this.style = style;
    this.coverage = coverage ?? EMPTY_COVERAGE;
    this.ensure();
    this.register();
  }

  /** Empty the layer if it exists; never creates one (degraded mode draws nothing). */
  clear(): void {
    this.selected = null;
    this.selectedEid = null;
    if (!this.map?.getSource(this.src)) return;
    this.update({ type: "FeatureCollection", features: [] }, this.style);
    this.setSelected(null);
  }

  private paintSignature(): string {
    return JSON.stringify([this.style, this.opacity, this.hasCoverage]);
  }

  private dotPaint(): Record<string, unknown> {
    const cov = this.hasCoverage;
    return {
      "circle-radius": this.style.radius,
      "circle-color": this.style.color,
      "circle-opacity": dotOpacity(this.opacity, cov),
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
      ...(cov ? { "circle-stroke-opacity": dotStrokeOpacity(true) } : {}),
    };
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
      const baseNew = this.syncBase(map);
      const covNew = this.syncCoverage(map);
      const fresh = baseNew && (covNew || !this.hasCoverage); // every layer that exists was just created
      const sig = this.paintSignature();
      if (fresh) this.paintSig = sig; // new layers were created with the current paint
      else if (sig !== this.paintSig) this.applyPaint(map, sig);
    } catch (e) {
      // style still loading: the styledata hook retries
      if (typeof console !== "undefined") console.debug("[aimsun] map layer deferred:", e);
    }
  }

  /** Dots + selection halo. Returns true when the layers were (re)created. */
  private syncBase(map: MapLike): boolean {
    const sig = JSON.stringify(this.fc);
    const existing = map.getSource(this.src);
    if (existing?.setData) {
      if (sig !== this.fcSig) {
        existing.setData(this.fc);
        this.fcSig = sig;
      }
      return false;
    }
    // first time, or the style was reloaded (everything is gone): add all, re-add images too
    // (layer-bound listeners survive setStyle, so `listening` is kept)
    this.covSig = "";
    map.addSource(this.src, { type: "geojson", data: this.fc });
    this.fcSig = sig;
    map.addLayer({ id: this.pts, type: "circle", source: this.src, paint: this.dotPaint() });
    map.addSource(this.selSrc, { type: "geojson", data: this.selectedData() });
    map.addLayer({
      id: this.sel,
      type: "circle",
      source: this.selSrc,
      paint: { "circle-radius": 14, "circle-color": SELECT_COLOR, "circle-opacity": 0.15, "circle-stroke-width": 2.5, "circle-stroke-color": SELECT_COLOR },
    });
    this.listen(map, this.pts);
    return true;
  }

  /** Coverage fill/outline + direction glyphs, only for packages that have coverage. */
  private syncCoverage(map: MapLike): boolean {
    const want = this.hasCoverage;
    const have = !!map.getSource(this.covSrc);
    if (!want && !have) return false;
    const sig = JSON.stringify(this.coverage);
    if (have) {
      if (sig !== this.covSig) {
        map.getSource(this.covSrc)?.setData?.(this.coverage);
        this.covSig = sig;
      }
      this.ensureImages(map);
      return false;
    }
    this.ensureImages(map);
    map.addSource(this.covSrc, { type: "geojson", data: this.coverage });
    this.covSig = sig;
    const color = this.style.color;
    const radius = this.style.radius;
    map.addLayer({
      id: this.covFill,
      type: "fill",
      source: this.covSrc,
      minzoom: ZOOM.covMin,
      filter: ["==", ["get", "kind"], "area"],
      paint: { "fill-color": color, "fill-opacity": coverageFillOpacity(this.opacity) },
    });
    map.addLayer({
      id: this.covLine,
      type: "line",
      source: this.covSrc,
      minzoom: ZOOM.covMin,
      filter: ["==", ["get", "kind"], "area"],
      paint: { "line-color": "#ffffff", "line-width": coverageLineWidth(radius), "line-opacity": coverageLineOpacity(this.opacity) },
    });
    map.addLayer({
      id: this.covSel,
      type: "line",
      source: this.covSrc,
      filter: selectedAreaFilter(this.selectedEid),
      paint: { "line-color": SELECT_COLOR, "line-width": 3 },
    });
    this.listen(map, this.covFill);
    if (map.addImage) {
      map.addLayer({
        id: this.arrows,
        type: "symbol",
        source: this.covSrc,
        minzoom: ZOOM.arrowMin,
        filter: ["==", ["get", "kind"], "arrow"],
        layout: {
          "icon-image": ["match", ["get", "glyph"], "arrow", this.arrowImg, this.neutralImg],
          "icon-rotate": ["to-number", ["get", "bearing_deg"], 0],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": arrowSize(radius),
        },
        paint: { "icon-color": color, "icon-opacity": arrowOpacity(this.opacity), "icon-halo-color": "#ffffff", "icon-halo-width": 1 },
      });
      this.listen(map, this.arrows);
    }
    return true;
  }

  private ensureImages(map: MapLike): void {
    if (!map.addImage) return;
    const add = (name: string, make: () => ReturnType<typeof makeArrowImage>): void => {
      if (map.hasImage?.(name)) return;
      map.addImage?.(name, make(), { sdf: true, pixelRatio: GLYPH_PIXEL_RATIO });
    };
    add(this.arrowImg, makeArrowImage);
    add(this.neutralImg, makeNeutralImage);
  }

  private applyPaint(map: MapLike, sig: string): void {
    const set = (layer: string, prop: string, value: unknown): void => {
      if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
    };
    const cov = this.hasCoverage;
    set(this.pts, "circle-radius", this.style.radius);
    set(this.pts, "circle-color", this.style.color);
    set(this.pts, "circle-opacity", dotOpacity(this.opacity, cov));
    set(this.pts, "circle-stroke-opacity", dotStrokeOpacity(cov));
    set(this.covFill, "fill-color", this.style.color);
    set(this.covFill, "fill-opacity", coverageFillOpacity(this.opacity));
    set(this.covLine, "line-width", coverageLineWidth(this.style.radius));
    set(this.covLine, "line-opacity", coverageLineOpacity(this.opacity));
    set(this.arrows, "icon-color", this.style.color);
    set(this.arrows, "icon-opacity", arrowOpacity(this.opacity));
    if (map.getLayer(this.arrows)) map.setLayoutProperty(this.arrows, "icon-size", arrowSize(this.style.radius));
    this.paintSig = sig;
  }

  /** (Un)subscribe hover/click for one interactive layer; once per layer per map style. */
  private listen(map: MapLike, layer: string): void {
    if (this.listening.has(layer)) return; // layer-bound listeners survive a style reload
    this.listening.add(layer);
    for (const [type, fn] of [["mousemove", this.onMove], ["mouseleave", this.onLeave], ["click", this.onClick]] as const) {
      map.on(type, layer, fn);
      this.handlers.push([type, layer, fn]);
    }
  }

  private register(): void {
    const map = this.map;
    if (!this.app.registerExternalNativeLayer || !map) return;
    const all = [this.pts, this.sel, this.covFill, this.covLine, this.covSel, this.arrows];
    const allSrc = [this.src, this.selSrc, this.covSrc];
    const layers = (): string[] => all.filter((l) => !!map.getLayer(l));
    this.app.registerExternalNativeLayer({
      id: this.id,
      name: this.name,
      type: "geojson",
      nativeLayerIds: layers(),
      sourceIds: allSrc.filter((s) => !!map.getSource(s)),
      sourceId: this.src,
      geojson: this.fc,
      paintMode: "plugin",
      paintBridge: {
        setOpacity: (o) => {
          this.opacity = o;
          try {
            if (this.map) this.applyPaint(this.map, this.paintSignature());
          } catch {
            /* layer gone */
          }
        },
        setVisibility: (v) => {
          try {
            for (const l of layers()) this.map?.setLayoutProperty(l, "visibility", v ? "visible" : "none");
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

  /** Highlight a detector: the halo at its anchor and, when drawn, its coverage outline (by eid). */
  setSelected(lonLat: [number, number] | null, eid?: string | null): void {
    this.selected = lonLat;
    this.selectedEid = lonLat && eid ? eid : null;
    try {
      this.map?.getSource(this.selSrc)?.setData?.(this.selectedData());
      if (this.map?.getLayer(this.covSel)) this.map.setFilter?.(this.covSel, selectedAreaFilter(this.selectedEid));
    } catch {
      /* not mounted yet */
    }
  }

  /** Centre on a point (close zoom: the coverage appears from ~z17), through the map when there is one, else fitBounds. */
  zoomTo(lon: number, lat: number): void {
    const map = this.app.getMap?.();
    if (map) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), this.hasCoverage ? 18 : 16), essential: true });
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
      for (const [type, layer, fn] of this.handlers) m.off(type, layer, fn);
      this.handlers = [];
      this.listening.clear();
      for (const l of [this.arrows, this.covSel, this.covLine, this.covFill, this.sel, this.pts]) if (m.getLayer(l)) m.removeLayer(l);
      for (const s of [this.covSrc, this.selSrc, this.src]) if (m.getSource(s)) m.removeSource(s);
      for (const i of [this.arrowImg, this.neutralImg]) if (m.hasImage?.(i)) m.removeImage?.(i);
    } catch {
      /* map already torn down */
    }
    this.tip?.remove();
    this.tip = null;
    this.fcSig = "";
    this.covSig = "";
    this.paintSig = null;
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

export function statusColor(pass = 5, fail = 10): unknown {
  return ["case", ["==", ["get", "status"], "unmatched"], UNMATCHED_COLOR,
    ["case", ["<", ["to-number", ["get", "geh"], 0], pass], "#2e7d32",
      ["case", ["<=", ["to-number", ["get", "geh"], 0], fail], "#f9a825", "#c62828"]]];
}

/** Grey for features flagged status "unmatched" (simulated detectors with no external id). */
export function withUnmatchedColor(expr: unknown): unknown {
  return ["case", ["==", ["get", "status"], "unmatched"], UNMATCHED_COLOR, expr];
}
