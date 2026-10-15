/**
 * Detector layers on the map. Everything is added natively (data-driven size/colour, which
 * addGeoJsonLayer's single-style layers cannot express) and mirrored into the Layers panel with
 * registerExternalNativeLayer. Hover shows a DOM tooltip, click selects the detector (eid).
 *
 * Old Point-only packages: one circle layer (dots) exactly as before. Packages with detector
 * coverage (contract C6/C14) additionally get, from one extra GeoJSON source: direction glyphs
 * at ALL zooms (SDF arrow rotated by bearing_deg, neutral diamond for bidirectional / mixed /
 * unknown / no bearing), sized in screen pixels (metric ramp, larger at low zoom), never hidden by
 * collision (biggest flow drawn on top, small perpendicular offset so opposite directions at one
 * position stay readable, white casing), flat on the ground so a pitched map keeps them aligned, plus the coverage fill + outline (real metres) from z15.5.
 * Dots are then drawn only for detectors that have no coverage (no double drawing).
 * Hover/click use one bbox query around the pointer so tiny or overlapped symbols are hit.
 */
import type { CoverageCollection, DetFeatureCollection } from "./geo.ts";
import { GLYPH_PIXEL_RATIO, makeArrowImage, makeNeutralImage } from "./glyphs.ts";
import type { AppLike, MapLike } from "./host.ts";

export interface CircleStyle {
  radius: unknown;
  color: unknown;
  /** Optional symbol-sort-key (lower wins a collision); default: the size ramp, largest first. */
  sortKey?: unknown;
}

export interface MapLayerHooks {
  /** Lines shown in the hover tooltip (already translated/formatted). */
  describe: (props: Record<string, unknown>) => string[];
  onSelect: (eid: string) => void;
}

const SELECT_COLOR = "#0b57d0";
const NONE = "\u0000none";
const EMPTY_COVERAGE: CoverageCollection = { type: "FeatureCollection", features: [] };

/**
 * Zoom stops. Glyphs have no minzoom and no collision hiding (every glyph is drawn at every zoom). Coverage polygons appear from `covMin`.
 */
export const ZOOM = { covMin: 15, overlapMin: 15, fillStart: 15.5, fillEnd: 17, focus: 17.5 } as const;
/** Pointer tolerance (CSS px) of the hit-test box around the cursor. */
export const HIT_PX = 8;

// ---------- pure paint/layout builders (unit-tested) ----------

const zoomInterp = (...stops: unknown[]): unknown => ["interpolate", ["linear"], ["zoom"], ...stops];
/** Detector radius ramp (3-16 px) turned into a unit-less scale for outline widths. */
const scaleOf = (radius: unknown): unknown => ["max", 0.5, ["/", radius, 8]];
/** Same ramp, clamped for glyphs so a 16 px detector is not a 30 px arrow on a crowded map. */
const glyphScaleOf = (radius: unknown): unknown => ["max", 0.6, ["min", 1.6, ["/", radius, 8]]];

/** Dots are plain constant-opacity circles: only detectors without coverage glyphs use them. */
export function dotOpacity(opacity: number): unknown {
  return opacity;
}
/** Dots of detectors that have a coverage glyph are hidden (no double drawing); old packages: no filter. */
export function dotFilter(withCoverage: boolean): unknown {
  return withCoverage ? ["!=", ["get", "cov"], true] : null;
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
/** Glyph size multipliers per zoom (x the 24 CSS px glyph box x the clamped metric scale). */
export const ARROW_SIZE_STOPS: ReadonlyArray<readonly [number, number]> = [[8, 0.95], [10, 1.0], [12, 1.0], [14, 0.95], [15, 0.8], [18, 0.75], [21, 0.9]];
/**
 * Glyph size in SCREEN pixels (icon-size multiplies the 24 CSS px glyph box, never metres): at z<=14
 * the arrow is at least ~14 px tall (about 24 px in the middle of the ramp), easing to a smaller
 * glyph from z15 where the coverage polygon takes over, then growing mildly. `boost` enlarges the
 * selected-detector underlay.
 */
export function arrowSize(radius: unknown, boost = 1): unknown {
  const s = glyphScaleOf(radius);
  const k = (v: number): unknown => ["*", v * boost, s];
  return zoomInterp(...ARROW_SIZE_STOPS.flatMap(([z, v]) => [z, k(v)]));
}
/** Constant opacity (no zoom fade): glyphs are visible at every zoom. */
export function arrowOpacity(opacity: number): unknown {
  return opacity;
}
/** Every arrow is drawn at every zoom: no collision hiding. */
export function arrowAllowOverlap(): unknown {
  return true;
}
export function arrowIgnorePlacement(): unknown {
  return true;
}
export function arrowPadding(): unknown {
  return 0;
}
/** White casing (SDF halo) width: thick at low zoom where arrows overlap, thin once the polygon is drawn. */
export function arrowHaloWidth(): unknown {
  return zoomInterp(8, 2.4, 14, 2, 16, 1.2, 18, 1);
}
/**
 * Offset (icon-size units, so it scales with the glyph) to the RIGHT of the travel direction: the
 * icon offset is rotated with the icon, so two arrows at one position pointing in opposite
 * directions land on opposite sides of the road instead of cancelling. Fades out at the focus zoom.
 */
export function arrowOffset(): unknown {
  return zoomInterp(8, ["literal", [5, 0]], 14, ["literal", [5, 0]], 16, ["literal", [3, 0]], ZOOM.focus, ["literal", [0, 0]]);
}
/** Arrows lie on the ground and turn with the map: they stay aligned with the road when the map is pitched or rotated. */
export const ARROW_ALIGNMENT = Object.freeze({ rotation: "map", pitch: "map" } as const);
/**
 * Draw order: with overlap allowed, a LOWER key is drawn first (below), so the biggest flow (the
 * size ramp, else the simulated flow) must have the HIGHEST key to end up on top.
 */
export function arrowSortKey(radius: unknown): unknown {
  return typeof radius === "number" ? ["to-number", ["get", "sim"], 0] : radius;
}
/** Selected-detector outline filter (area features of one eid). */
export function selectedAreaFilter(eid: string | null): unknown {
  return ["all", ["==", ["get", "kind"], "area"], ["==", ["get", "eid"], eid ?? NONE]];
}
/** Selected-detector glyph filter (arrow features of one eid). */
export function selectedArrowFilter(eid: string | null): unknown {
  return ["all", ["==", ["get", "kind"], "arrow"], ["==", ["get", "eid"], eid ?? NONE]];
}

/** Bounding box (screen px) around a pointer position for queryRenderedFeatures. */
export function hitBox(p: { x: number; y: number }, r = HIT_PX): [[number, number], [number, number]] {
  return [[p.x - r, p.y - r], [p.x + r, p.y + r]];
}

export interface HitFeature {
  layer?: { id?: string };
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown> | null;
}

/**
 * Pick the one feature a click/hover means among everything under the hit box: features with a
 * real eid win over unmatched ones (which cannot be selected), then the layer order (glyphs, dots,
 * coverage polygons), then the nearest anchor to the pointer on screen.
 */
export function pickFeature<T extends HitFeature>(
  features: readonly T[],
  pointer: { x: number; y: number },
  layerOrder: readonly string[],
  project?: (lngLat: [number, number]) => { x: number; y: number },
): T | null {
  const withEid = features.filter((f) => {
    const e = f.properties?.eid;
    return e !== undefined && e !== null && e !== "";
  });
  const pool = withEid.length ? withEid : features;
  let best: T | null = null;
  let bestKey: [number, number] = [Infinity, Infinity];
  for (const f of pool) {
    const rank = layerOrder.indexOf(f.layer?.id ?? "");
    let dist = Infinity;
    if (project && f.geometry?.type === "Point") {
      const q = project(f.geometry.coordinates as [number, number]);
      dist = Math.hypot(q.x - pointer.x, q.y - pointer.y);
    }
    const key: [number, number] = [rank < 0 ? layerOrder.length : rank, dist];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = f;
      bestKey = key;
    }
  }
  return best;
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
  private readonly arrowsSel: string;
  private readonly arrowImg: string;
  private readonly neutralImg: string;
  private registered = false;
  private opacity = 0.85;
  private disposed = false;
  private fcSig = "";
  private covSig = "";
  private paintSig: string | null = null;
  private handlers: Array<[string, (e: any) => void]> = [];
  private readonly onMove = (e: any): void => this.move(e);
  private readonly onLeave = (): void => this.leave();
  private readonly onClick = (e: any): void => {
    const eid = this.hit(e)?.properties?.eid;
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
    this.arrowsSel = `${id}-arrows-sel`;
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
    return {
      "circle-radius": this.style.radius,
      "circle-color": this.style.color,
      "circle-opacity": dotOpacity(this.opacity),
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
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
        this.attachPointer(map);
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
    // (the map-level pointer handlers survive setStyle and are attached once per map)
    this.covSig = "";
    map.addSource(this.src, { type: "geojson", data: this.fc });
    this.fcSig = sig;
    const dotF = dotFilter(this.hasCoverage);
    map.addLayer({ id: this.pts, type: "circle", source: this.src, paint: this.dotPaint(), ...(dotF ? { filter: dotF } : {}) });
    map.addSource(this.selSrc, { type: "geojson", data: this.selectedData() });
    map.addLayer({
      id: this.sel,
      type: "circle",
      source: this.selSrc,
      paint: { "circle-radius": 14, "circle-color": SELECT_COLOR, "circle-opacity": 0.15, "circle-stroke-width": 2.5, "circle-stroke-color": SELECT_COLOR },
    });
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
    if (map.addImage) {
      // selected-detector underlay first (drawn below the metric-coloured glyph, so it reads as an outline)
      map.addLayer({
        id: this.arrowsSel,
        type: "symbol",
        source: this.covSrc,
        filter: selectedArrowFilter(this.selectedEid),
        layout: { ...this.arrowLayout(), "icon-size": arrowSize(radius, 1.7), "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-padding": 0 },
        paint: { "icon-color": SELECT_COLOR, "icon-opacity": 1, "icon-halo-color": SELECT_COLOR, "icon-halo-width": 0.5 },
      });
      map.addLayer({
        id: this.arrows,
        type: "symbol",
        source: this.covSrc,
        filter: ["==", ["get", "kind"], "arrow"],
        layout: {
          ...this.arrowLayout(),
          "icon-allow-overlap": arrowAllowOverlap(),
          "icon-ignore-placement": arrowIgnorePlacement(),
          "icon-padding": arrowPadding(),
          "icon-size": arrowSize(radius),
          "symbol-sort-key": this.sortKey(),
        },
        paint: { "icon-color": color, "icon-opacity": arrowOpacity(this.opacity), "icon-halo-color": "#ffffff", "icon-halo-width": arrowHaloWidth() },
      });
    }
    return true;
  }

  private arrowLayout(): Record<string, unknown> {
    return {
      "icon-image": ["match", ["get", "glyph"], "arrow", this.arrowImg, this.neutralImg],
      "icon-rotate": ["to-number", ["get", "bearing_deg"], 0],
      "icon-rotation-alignment": ARROW_ALIGNMENT.rotation,
      "icon-pitch-alignment": ARROW_ALIGNMENT.pitch,
      "icon-offset": arrowOffset(),
    };
  }

  private sortKey(): unknown {
    return this.style.sortKey ?? arrowSortKey(this.style.radius);
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
    set(this.pts, "circle-opacity", dotOpacity(this.opacity));
    if (map.getLayer(this.pts)) map.setFilter?.(this.pts, dotFilter(cov));
    set(this.covFill, "fill-color", this.style.color);
    set(this.covFill, "fill-opacity", coverageFillOpacity(this.opacity));
    set(this.covLine, "line-width", coverageLineWidth(this.style.radius));
    set(this.covLine, "line-opacity", coverageLineOpacity(this.opacity));
    set(this.arrows, "icon-color", this.style.color);
    set(this.arrows, "icon-opacity", arrowOpacity(this.opacity));
    if (map.getLayer(this.arrows)) {
      map.setLayoutProperty(this.arrows, "icon-size", arrowSize(this.style.radius));
      map.setLayoutProperty(this.arrows, "symbol-sort-key", this.sortKey());
    }
    if (map.getLayer(this.arrowsSel)) map.setLayoutProperty(this.arrowsSel, "icon-size", arrowSize(this.style.radius, 1.7));
    this.paintSig = sig;
  }

  /** Map-level pointer handlers (they survive setStyle): one bbox query resolves hover and click for every layer. */
  private attachPointer(map: MapLike): void {
    for (const [type, fn] of [["mousemove", this.onMove], ["mouseout", this.onLeave], ["click", this.onClick]] as const) {
      map.on(type, fn);
      this.handlers.push([type, fn]);
    }
  }

  private get hitLayers(): string[] {
    return [this.arrows, this.pts, this.covFill].filter((l) => !!this.map?.getLayer(l));
  }

  /** The feature under (or nearest to) the pointer, tolerant to tiny/overlapped symbols. */
  private hit(e: any): { properties?: Record<string, unknown> | null } | null {
    const map = this.map;
    if (!map || !e?.point) return null;
    const layers = this.hitLayers;
    if (!layers.length || !map.queryRenderedFeatures) return null;
    const found = map.queryRenderedFeatures(hitBox(e.point), { layers });
    if (!found?.length) return null;
    return pickFeature(found, e.point, [this.arrows, this.pts, this.covFill], map.project?.bind(map));
  }

  private register(): void {
    const map = this.map;
    if (!this.app.registerExternalNativeLayer || !map) return;
    const all = [this.pts, this.sel, this.covFill, this.covLine, this.covSel, this.arrowsSel, this.arrows];
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
      if (this.map?.getLayer(this.arrowsSel)) this.map.setFilter?.(this.arrowsSel, selectedArrowFilter(this.selectedEid));
    } catch {
      /* not mounted yet */
    }
  }

  /** Centre on a point (coverage packages: z17.5, where polygon and arrow are both drawn), through the map when there is one, else fitBounds. */
  zoomTo(lon: number, lat: number): void {
    const map = this.app.getMap?.();
    if (map) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), this.hasCoverage ? ZOOM.focus : 16), essential: true });
    } else if (this.app.fitBounds) {
      const d = 0.002;
      this.app.fitBounds([lon - d, lat - d, lon + d, lat + d]);
    }
  }

  private move(e: any): void {
    const map = this.map;
    const f = this.hit(e);
    if (!map) return;
    if (!f) {
      this.leave();
      return;
    }
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
      for (const [type, fn] of this.handlers) m.off(type, fn);
      this.handlers = [];
      for (const l of [this.arrows, this.arrowsSel, this.covSel, this.covLine, this.covFill, this.sel, this.pts]) if (m.getLayer(l)) m.removeLayer(l);
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
export const SIZE_MIN_R = 3;
export const SIZE_MAX_R = 16;
export const SEQUENTIAL_STOPS = ["#fff7bc", "#41ab5d", "#08306b"] as const;
export const DIVERGING_STOPS = ["#2166ac", "#f7f7f7", "#b2182b"] as const;
/** Height (CSS px) of the arrow glyph at size 1: 48 of the 64 glyph px at pixelRatio 2. */
export const GLYPH_BOX_PX = 24;
/** Rendered glyph height for a radius-ramp value at a zoom (default z12), mirroring arrowSize(). */
export function glyphHeightPx(radius: number, zoom = 12): number {
  const stops = ARROW_SIZE_STOPS;
  let k = stops[0][1];
  for (let i = 0; i < stops.length; i++) {
    if (zoom >= stops[i][0]) k = stops[i][1];
    if (i + 1 < stops.length && zoom > stops[i][0] && zoom < stops[i + 1][0]) k = stops[i][1] + ((zoom - stops[i][0]) / (stops[i + 1][0] - stops[i][0])) * (stops[i + 1][1] - stops[i][1]);
  }
  return GLYPH_BOX_PX * k * Math.max(0.6, Math.min(1.6, radius / 8));
}

export function sizeExpression(prop: string, maxValue: number, minR = SIZE_MIN_R, maxR = SIZE_MAX_R): unknown {
  const m = Math.max(1, maxValue);
  return ["interpolate", ["linear"], ["sqrt", ["max", 0, ["to-number", ["get", prop], 0]]], 0, minR, Math.sqrt(m), maxR];
}

export function sequentialColor(prop: string, maxValue: number): unknown {
  const m = Math.max(1, maxValue);
  return ["interpolate", ["linear"], ["to-number", ["get", prop], 0], 0, SEQUENTIAL_STOPS[0], m * 0.5, SEQUENTIAL_STOPS[1], m, SEQUENTIAL_STOPS[2]];
}

/** Blue = simulated below observed, red = above. Symmetric around 0. */
export function divergingColor(prop: string, maxAbs: number): unknown {
  const m = Math.max(1, maxAbs);
  return ["interpolate", ["linear"], ["to-number", ["get", prop], 0], -m, DIVERGING_STOPS[0], 0, DIVERGING_STOPS[1], m, DIVERGING_STOPS[2]];
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
