import type { Map as MapLibreMap } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { createIdentifyPopupElement } from "@geolibre/map";
import type { Layer } from "@deck.gl/core";
import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibrePlugin } from "../types";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import {
  createNetworkKpiDirectorySource,
  createNetworkKpiHttpSource,
  fetchNetworkKpiManifestJson,
  loadNetworkKpiGeometry,
  clearNetworkKpiGeometryCache,
  parseNetworkKpiManifest,
  readLocalNetworkKpiManifestJson,
  type NetworkKpiGeometry,
  type NetworkKpiManifest,
  type NetworkKpiResults,
  type NetworkFeatureCollection,
} from "./network-kpi-data";
import { ParquetResultsDatabase } from "./network-kpi-parquet-data";
import type { SimulationTimeline } from "../shared/simulation-timeline";
import {
  laneWidthMetersExpression,
  metersLineWidthExpression,
  sectionWidthMetersExpression,
  turnWidthMetersExpression,
} from "./maplibre-vehicle-playback";
import {
  listVehicleManifestScenarios,
  supportsLocalPackageFolders,
  type VehicleDirectoryHandle,
  type VehicleManifestScenario,
  type VehiclePackageSource,
} from "./vehicle-playback-data";
import {
  buildKpiValueIndex,
  buildLaneGeometryRows,
  buildSectionGeometryRows,
  type KpiGeometryRow,
} from "./network-kpi-geometry";
import { capabilityAvailable } from "./geolibre-package-loader";
import {
  DEFAULT_MAX_HEIGHT_M,
  elevationByKpi,
  kpiColorRgb,
  LOD_ZOOM_THRESHOLD,
  MAX_HEIGHT_MAX_M,
  MAX_HEIGHT_MIN_M,
  type NetworkKpiMetric,
  type KpiRampOverrides,
} from "./network-kpi-ramps";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";

/**
 * GeoLibre network-kpi plugin.
 *
 * Renders STATIC, AGGREGATE traffic results — flow, density and speed — as a
 * choropleth or an extruded surface over the road network. It is the
 * "results mode" companion to vehicle-playback's "playback mode": the same
 * Testudo package, the same manifest, the same geometry, but read as one value
 * per road rather than as a time series of moving vehicles.
 *
 * Results come out of the package's gzipped SQLite (`results.sqlite.gz`,
 * declared under the manifest's `environment` block), queried client-side with
 * sql.js. See `network-kpi-data.ts` for the loading and the `MISECT`/`MILANE`
 * queries, `network-kpi-geometry.ts` for turning centerlines into the ribbons
 * that get colored and extruded, and `network-kpi-ramps.ts` for Testudo's own
 * color ramps and elevation math.
 *
 * ## Why deck.gl for both 2D and 3D
 *
 * Both the flat choropleth and the extruded view are ONE `PolygonLayer`, with
 * `extruded` toggled and `getElevation` returning 0 in 2D. The alternative —
 * MapLibre `fill` for 2D and something else for 3D — would mean two renderers,
 * two styling paths and two sets of bugs, and MapLibre's `fill-extrusion` cannot
 * take the per-feature continuous ramp without a data-driven expression on
 * every paint property anyway. Going through deck.gl also lets the color ramp be
 * an ordinary JS function ({@link kpiColorRgb}) rather than a hand-built
 * `["interpolate", ...]` expression, which is what makes reproducing Testudo's
 * CONTINUOUS ramp straightforward — GeoLibre's own `graduated` vector mode only
 * emits discrete `step` expressions. vehicle-playback already proves this
 * exact `PolygonLayer` + `extruded` + `getElevation` path on the same map.
 *
 * ## Level of detail
 *
 * Unlike vehicle-playback's network view (a manual two-way button), the LOD here
 * is ZOOM-DRIVEN and automatic, mirroring Testudo's own KPI rendering: below the
 * threshold the section-level rows are drawn, at or above it the lane-level
 * rows. See {@link NetworkKpiEngine.handleZoom}.
 */

export const NETWORK_KPI_PLUGIN_ID = "geolibre-network-kpi";
const NETWORK_KPI_STORE_LAYER_ID = "geolibre-network-kpi-layer";

const NETWORK_KPI_DECK_SOURCE = "network-kpi";

/** Persisted, user-tunable state of the KPI view. */
export interface NetworkKpiSettings {
  /** URL of the package's `manifest.json`, or null when none is loaded. */
  manifestUrl: string | null;
  /** Which result metric is colored and extruded. */
  metric: NetworkKpiMetric;
  /** When true, polygons are extruded by KPI value; when false, flat color. */
  extruded: boolean;
  /** Extrusion ceiling in meters; only meaningful while {@link extruded}. */
  maxHeightM: number;
  /**
   * Zoom at or above which lane-level KPI replaces section-level KPI.
   *
   * Defaults to Testudo's own `LOD_ZOOM_THRESHOLD` but is a setting rather than
   * a constant, because the zoom at which per-lane detail becomes readable
   * depends on how dense the network is.
   */
  /** Opacity applied to every KPI polygon. */
  opacity: number;
  /** Which time interval (`ent`) is shown; 0 is the whole-period aggregate. */
  interval: number;
  intervalPlaying: boolean;
  playbackSpeed: number;
  loop: boolean;
  did: number | null;
  seeThroughBuildings: boolean;
  showNetwork: boolean;
  showSections: boolean;
  showLanes: boolean;
  showTurns: boolean;
  showNodes: boolean;
}

export const NETWORK_KPI_OPACITY_MIN = 0.1;
export const NETWORK_KPI_OPACITY_MAX = 1;
export const NETWORK_KPI_MAX_HEIGHT_MIN = MAX_HEIGHT_MIN_M;
export const NETWORK_KPI_MAX_HEIGHT_MAX = MAX_HEIGHT_MAX_M;

export const DEFAULT_NETWORK_KPI_SETTINGS: NetworkKpiSettings = {
  manifestUrl: null,
  metric: "flow",
  extruded: true,
  maxHeightM: DEFAULT_MAX_HEIGHT_M,
  opacity: 0.85,
  interval: 0,
  intervalPlaying: false,
  playbackSpeed: 1,
  loop: true,
  did: null,
  seeThroughBuildings: true,
  showNetwork: true,
  showSections: true, showLanes: true, showTurns: true, showNodes: true,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isMetric(value: unknown): value is NetworkKpiMetric {
  return value === "flow" || value === "density" || value === "speed";
}

/** Coerce arbitrary persisted/partial input into complete settings. */
export function normalizeNetworkKpiSettings(
  value: unknown,
  base: NetworkKpiSettings = DEFAULT_NETWORK_KPI_SETTINGS,
): NetworkKpiSettings {
  const c = (value ?? {}) as Partial<NetworkKpiSettings>;
  return {
    manifestUrl:
      typeof c.manifestUrl === "string" && c.manifestUrl.length > 0
        ? c.manifestUrl
        : base.manifestUrl,
    metric: isMetric(c.metric) ? c.metric : base.metric,
    extruded: typeof c.extruded === "boolean" ? c.extruded : base.extruded,
    maxHeightM: clampNumber(
      c.maxHeightM,
      NETWORK_KPI_MAX_HEIGHT_MIN,
      NETWORK_KPI_MAX_HEIGHT_MAX,
      base.maxHeightM,
    ),
    opacity: clampNumber(c.opacity, NETWORK_KPI_OPACITY_MIN, NETWORK_KPI_OPACITY_MAX, base.opacity),
    interval:
      typeof c.interval === "number" && Number.isFinite(c.interval)
        ? Math.max(0, Math.trunc(c.interval))
        : base.interval,
    intervalPlaying: typeof c.intervalPlaying === "boolean" ? c.intervalPlaying : base.intervalPlaying,
    playbackSpeed: clampNumber(c.playbackSpeed, 0.25, 8, base.playbackSpeed),
    loop: typeof c.loop === "boolean" ? c.loop : base.loop,
    did: typeof c.did === "number" && Number.isFinite(c.did) ? Math.trunc(c.did) : base.did,
    seeThroughBuildings: typeof c.seeThroughBuildings === "boolean" ? c.seeThroughBuildings : base.seeThroughBuildings,
    showNetwork: typeof c.showNetwork === "boolean" ? c.showNetwork : base.showNetwork,
    showSections: typeof c.showSections === "boolean" ? c.showSections : base.showSections,
    showLanes: typeof c.showLanes === "boolean" ? c.showLanes : base.showLanes,
    showTurns: typeof c.showTurns === "boolean" ? c.showTurns : base.showTurns,
    showNodes: typeof c.showNodes === "boolean" ? c.showNodes : base.showNodes,
  };
}

function settingsEqual(a: NetworkKpiSettings, b: NetworkKpiSettings): boolean {
  return (
    a.manifestUrl === b.manifestUrl &&
    a.metric === b.metric &&
    a.extruded === b.extruded &&
    a.maxHeightM === b.maxHeightM &&
    a.opacity === b.opacity &&
    a.interval === b.interval
    && a.intervalPlaying === b.intervalPlaying
    && a.playbackSpeed === b.playbackSpeed && a.loop === b.loop
    && a.did === b.did
    && a.seeThroughBuildings === b.seeThroughBuildings
    && a.showNetwork === b.showNetwork
    && a.showSections === b.showSections && a.showLanes === b.showLanes && a.showTurns === b.showTurns && a.showNodes === b.showNodes
  );
}

function isDefaultSettings(value: NetworkKpiSettings): boolean {
  return settingsEqual(value, DEFAULT_NETWORK_KPI_SETTINGS);
}

/** Progress/diagnostic state the panel shows but the project never persists. */
export interface NetworkKpiStatus {
  loading: boolean;
  error: string | null;
  /** Polygons drawn in the most recent render. */
  featureCount: number;
  /** Which LOD the current zoom selected. */
  detailed: boolean;
  /** Whether a results database was found and opened. */
  hasResults: boolean;
  hasSections: boolean;
  hasLanes: boolean;
  /** Every interval the database offers; 0 is the whole-period aggregate. */
  intervals: number[];
  /** Every scenario the loaded manifest offers. */
  scenarios: VehicleManifestScenario[];
  scenarioIndex: number;
  replications: { did: number; didname?: string }[];
  did: number | null;
  /** True when the package was opened from a local folder rather than a URL. */
  localFolderName: string | null;
  timeline?: SimulationTimeline | null;
}

const IDLE_STATUS: NetworkKpiStatus = {
  loading: false,
  error: null,
  featureCount: 0,
  detailed: false,
  hasResults: false,
  hasSections: false,
  hasLanes: false,
  intervals: [],
  scenarios: [],
  scenarioIndex: 0,
  replications: [],
  did: null,
  localFolderName: null,
};

// ---------------------------------------------------------------------------
// Map engine: owns the deck layer and the zoom-driven LOD swap.
// ---------------------------------------------------------------------------

/** The geometry + results a loaded package contributes to the engine. */
export interface NetworkKpiPackage {
  geometry: NetworkKpiGeometry;
  results: NetworkKpiResults | null;
  ramps?: KpiRampOverrides;
}

class NetworkKpiEngine {
  private readonly map: MapLibreMap;
  private settings: NetworkKpiSettings;
  private loaded: NetworkKpiPackage | null = null;
  private readonly getDeck: () => GeoLibreDeckGL | null;
  private readonly handleStyleData: () => void;
  private readonly handleZoom: () => void;
  private destroyed = false;
  private deckActive = false;
  /** Which LOD the last render used, so a zoom that does not cross the
   *  threshold costs nothing. */
  private detailed = false;
  /**
   * Cached GEOMETRY-only rows per LOD — the buffered ribbons, with no KPI
   * value baked in. Rebuilt only when the loaded package's geometry actually
   * changes (a new/cleared package), never on a metric change or an interval
   * tick, since neither of those touches geometry.
   */
  private sectionGeometry: KpiGeometryRow[] = [];
  private laneGeometry: KpiGeometryRow[] = [];
  /**
   * Cheap `row key -> current value` lookup for the active metric, rebuilt on
   * every metric change AND every interval tick (a `results` swap) — this is
   * intentionally the ONLY thing an interval tick rebuilds; see
   * {@link setPackage}.
   */
  private valueIndex: Map<string, number | null> = new Map();
  private networkVisible = true;
  private readonly networkClickHandlers = new Map<string, (event: any) => void>();

  constructor(
    map: MapLibreMap,
    settings: NetworkKpiSettings,
    loaded: NetworkKpiPackage | null,
    getDeck: () => GeoLibreDeckGL | null,
  ) {
    this.map = map;
    this.settings = settings;
    this.loaded = loaded;
    this.getDeck = getDeck;

    // A basemap style swap wipes the shared deck overlay's mount; re-render once
    // the new style settles, the same idiom vehicle-playback uses.
    this.handleStyleData = () => {
      if (this.destroyed) return;
      this.unbindNetworkClickHandlers();
      this.syncNetworkLayers();
      this.render();
    };
    /**
     * The LOD mechanism: MapLibre's own `zoom` event, checked against the
     * threshold setting.
     *
     * deck.gl has no declarative "swap layers at zoom N" facility for a layer
     * built from JS arrays (its `visible` prop is not zoom-aware and
     * `minZoom`/`maxZoom` apply to tiled layers), and MapLibre's per-layer
     * `minzoom`/`maxzoom` only govern native style layers, not an overlay's
     * contents. So the swap is driven explicitly here — and cheaply: the handler
     * fires on every zoom frame but returns immediately unless the boolean
     * `zoom >= threshold` actually flipped, so a re-render happens only on the
     * two frames that cross the threshold, not continuously while zooming.
     */
    this.handleZoom = () => {
      if (this.destroyed) return;
      if (this.resolveDetailed() === this.detailed) return;
      this.render();
    };
    this.map.on("styledata", this.handleStyleData);
    this.map.on("zoom", this.handleZoom);
    this.rebuildGeometryRows();
    this.rebuildValueIndex();
    // A reattach (panel reopened, plugin reactivated) constructs a fresh
    // engine around an ALREADY-loaded package — setPackage()'s own
    // syncNetworkLayers() call never runs in that case, so the plain
    // network backdrop must be synced here too, not just the KPI polygons.
    this.syncNetworkLayers();
    this.render();
  }

  getMapInstance(): MapLibreMap {
    return this.map;
  }

  /** Whether the current zoom selects the lane-level (detailed) LOD. */
  private resolveDetailed(): boolean {
    if (!this.loaded?.geometry.lanes) return false;
    let zoom: number;
    try {
      zoom = this.map.getZoom();
    } catch {
      return false;
    }
    return Number.isFinite(zoom) && zoom >= LOD_ZOOM_THRESHOLD;
  }

  /**
   * Adopt a freshly loaded package (or clear it) and redraw.
   *
   * Rebuilds the GEOMETRY rows only when the geometry object itself actually
   * changed (a new/switched/cleared package) — an interval tick swaps
   * `loaded.results` but keeps the same `loaded.geometry` reference (see
   * `requeryInterval`'s spread in maplibre-network-kpi.ts), so that swap alone
   * takes the cheap {@link rebuildValueIndex} path instead of re-buffering
   * every ribbon.
   */
  setPackage(loaded: NetworkKpiPackage | null): void {
    const geometryChanged = loaded?.geometry !== this.loaded?.geometry;
    this.loaded = loaded;
    if (geometryChanged) this.rebuildGeometryRows();
    this.rebuildValueIndex();
    this.syncNetworkLayers();
    if (!loaded) {
      this.clearDeck();
      return;
    }
    this.render();
  }

  applySettings(settings: NetworkKpiSettings): void {
    const previous = this.settings;
    this.settings = settings;
    this.syncNetworkLayers();
    // Only the metric changes which VALUE each row carries; the ribbons
    // themselves depend solely on the geometry, so a metric change rebuilds
    // just the value lookup, never the geometry rows.
    if (settings.metric !== previous.metric) this.rebuildValueIndex();
    this.render();
  }

  /** Recompute the per-LOD GEOMETRY-only rows (the buffered ribbons). */
  private rebuildGeometryRows(): void {
    const loaded = this.loaded;
    if (!loaded) {
      this.sectionGeometry = [];
      this.laneGeometry = [];
      return;
    }
    this.sectionGeometry = buildSectionGeometryRows(loaded.geometry.sections);
    this.laneGeometry = buildLaneGeometryRows(loaded.geometry.lanes);
  }

  /**
   * Recompute the cheap `row key -> value` lookup for the active metric. This
   * is the ONLY rebuild an interval tick or a metric change needs to pay for —
   * no geometry/ribbon buffering — which is what makes swapping the KPI
   * overlay live on every tick cheap.
   */
  private rebuildValueIndex(): void {
    this.valueIndex = buildKpiValueIndex(this.loaded?.results ?? null, this.settings.metric);
  }

  destroy(): void {
    this.clearDeck();
    this.removeNetworkLayers();
    this.map.off("styledata", this.handleStyleData);
    this.map.off("zoom", this.handleZoom);
    this.destroyed = true;
  }

  /**
   * Draw the active LOD as two deck.gl layers through the shared overlay:
   *
   * 1. A BASE layer built straight from the cached geometry-only rows — a
   *    static, neutral-colored network footprint that never needs rebuilding
   *    on an interval tick or metric change.
   * 2. A KPI-OVERLAY layer over the same rings, whose color/elevation
   *    accessors look the current value up live from `this.valueIndex` by
   *    each row's stable `key` — so an interval tick (or metric change) only
   *    has to swap that Map and bump `updateTriggers`, never re-buffer a
   *    single ribbon.
   *
   * Registering both under one `setSharedDeckLayers` call keeps them drawing
   * together, while remaining two independently addressable deck.gl layer
   * instances (so a future export/toggle feature could target either alone).
   */
  render(): void {
    if (this.destroyed) return;
    if (!networkKpiLayerVisible) { this.clearDeck(); return; }
    const deck = this.getDeck();
    if (!this.loaded || !deck) {
      this.clearDeck();
      return;
    }

    const detailed = this.resolveDetailed();
    this.detailed = detailed;
    const rows = detailed ? this.laneGeometry : this.sectionGeometry;
    // Falling back to sections when the detailed LOD has no rows keeps zooming
    // in from showing an empty map on a package with section results but no
    // lane results.
    const effective = rows.length > 0 ? rows : this.sectionGeometry;

    const rowHasValue = (row: KpiGeometryRow): boolean =>
      (this.valueIndex.get(row.key) ?? null) !== null;
    const renderedCount = effective.filter(rowHasValue).length;
    setFrameStats(renderedCount, detailed && rows.length > 0);

    if (effective.length === 0) {
      this.clearDeck();
      return;
    }

    const { metric, extruded, maxHeightM, opacity } = this.settings;
    const alpha = Math.round(255 * opacity);
    const lodSuffix = detailed ? "lanes" : "sections";

    const baseLayer = new deck.layers.PolygonLayer<KpiGeometryRow>({
      id: `${NETWORK_KPI_DECK_SOURCE}-base-${lodSuffix}`,
      data: effective,
      getPolygon: (d: KpiGeometryRow) => d.ring,
      getFillColor: [148, 163, 184, Math.round(60 * opacity)],
      extruded: false,
      filled: true,
      stroked: false,
      pickable: false,
      updateTriggers: { getFillColor: [opacity] },
    }) as unknown as Layer;

    // Rows with no result for the active metric are skipped entirely — an
    // unmeasured road must not read as a measured zero (mirrors the drop
    // behavior the old fused buildSectionRows/buildLaneRows used to apply at
    // build time; here it is applied per-frame from the live value index
    // instead, since the geometry rows themselves are metric-independent).
    const overlayData = effective.filter(rowHasValue);

    const overlayLayer = new deck.layers.PolygonLayer<KpiGeometryRow>({
      id: `${NETWORK_KPI_DECK_SOURCE}-overlay-${lodSuffix}`,
      data: overlayData,
      getPolygon: (d: KpiGeometryRow) => d.ring,
      // The continuous ramp: interpolated per feature in JS, which is what
      // reproduces Testudo's smooth ramp instead of GeoLibre's discrete
      // graduated stepping.
      getFillColor: (d: KpiGeometryRow) => {
        const value = this.valueIndex.get(d.key) ?? null;
        const [r, g, b] = kpiColorRgb(value ?? 0, metric, this.loaded?.ramps);
        return [r, g, b, alpha];
      },
      // In flat mode every polygon is a ground-level choropleth; in 3D the
      // height carries the same value the color does, so the two encodings
      // reinforce each other rather than showing different things.
      getElevation: (d: KpiGeometryRow) =>
        extruded ? elevationByKpi(this.valueIndex.get(d.key) ?? null, metric, maxHeightM) : 0,
      extruded,
      filled: true,
      stroked: false,
      elevationScale: 1,
      pickable: false,
      // deck.gl caches attribute buffers across renders, so every accessor that
      // reads a setting OR the live value index needs a trigger that changes
      // on an interval tick — `this.valueIndex` itself is swapped to a new Map
      // instance on every rebuildValueIndex(), so including it here is what
      // makes a tick actually repaint instead of showing stale colors/heights.
      updateTriggers: {
        getFillColor: [metric, alpha, this.valueIndex],
        getElevation: [metric, extruded, maxHeightM, this.valueIndex],
      },
    }) as unknown as Layer;

    setSharedDeckLayers(NETWORK_KPI_DECK_SOURCE, [baseLayer, overlayLayer]);
    this.deckActive = true;
  }

  private syncNetworkLayers(): void {
    // MapLibre fires `styledata` more often than an actual style swap (sprite
    // and glyph loads, sources settling), and can transiently report the style
    // as not-yet-loaded on one of those firings even mid-session. Bailing out
    // here with no side effect (matching vehicle-playback's own guard) leaves
    // whatever layers/visibility already exist untouched, instead of a
    // spurious mid-session styledata wiping out a perfectly good sync — the
    // bug this comment replaces: the two conditions below used to share one
    // branch that actively hid every layer, so a transient !isStyleLoaded()
    // reset visibility to "none" moments after a correct load had just shown
    // it, and no later event ever set it back to "visible".
    if (!this.map.isStyleLoaded()) return;
    const geometry = this.loaded?.geometry;
    (this.map.getSource("network-kpi-selection") as { setData?: (value: never) => void } | undefined)?.setData?.({ type: "FeatureCollection", features: [] } as never);
    if (!geometry || !this.settings.showNetwork) {
      this.networkVisible = false;
      for (const id of ["network-kpi-sections", "network-kpi-lanes", "network-kpi-turns", "network-kpi-nodes"]) {
        if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", "none");
      }
      return;
    }
    this.networkVisible = true;
    const add = (sourceId: string, layerId: string, data: NetworkFeatureCollection | null, type: "line" | "circle" | "fill") => {
      if (data && !this.map.getSource(sourceId)) this.map.addSource(sourceId, { type: "geojson", data: data as never });
      if (data && !this.map.getLayer(layerId)) this.map.addLayer(type === "line" ? {
        id: layerId, type: "line", source: sourceId, paint: { "line-color": layerId.endsWith("lanes") ? "#94a3b8" : layerId.endsWith("turns") ? "#cbd5e1" : "#64748b", "line-width": metersLineWidthExpression(layerId.endsWith("lanes") ? laneWidthMetersExpression() : layerId.endsWith("turns") ? turnWidthMetersExpression() : sectionWidthMetersExpression()) as never, "line-opacity": 0.75 },
      } : type === "fill" ? {
        id: layerId, type: "fill", source: sourceId, paint: { "fill-color": "#a8b5c7", "fill-opacity": 0.6 },
      } : {
        id: layerId, type: "circle", source: sourceId, paint: { "circle-color": "#a8b5c7", "circle-radius": 3, "circle-opacity": 0.85 },
      } as never);
    };
    add("network-kpi-sections-source", "network-kpi-sections", geometry.sections, "line");
    add("network-kpi-lanes-source", "network-kpi-lanes", geometry.lanes, "line");
    add("network-kpi-turns-source", "network-kpi-turns", geometry.turns, "line");
    add("network-kpi-nodes-source", "network-kpi-nodes", geometry.nodes, "fill");
    for (const [id, visible] of [["network-kpi-sections", this.settings.showSections], ["network-kpi-nodes", this.settings.showNodes], ["network-kpi-lanes", this.settings.showLanes], ["network-kpi-turns", this.settings.showTurns]] as const) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
    const highlightSource = "network-kpi-selection";
    if (!this.map.getSource(highlightSource)) this.map.addSource(highlightSource, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!this.map.getLayer(`${highlightSource}-line`)) this.map.addLayer({ id: `${highlightSource}-line`, type: "line", source: highlightSource, paint: { "line-color": "#facc15", "line-width": 4 } });
    if (!this.map.getLayer(`${highlightSource}-fill`)) this.map.addLayer({ id: `${highlightSource}-fill`, type: "fill", source: highlightSource, paint: { "fill-color": "#facc15", "fill-opacity": 0.75, "fill-outline-color": "#fff" } });
    if (!this.map.getLayer(`${highlightSource}-circle`)) this.map.addLayer({ id: `${highlightSource}-circle`, type: "circle", source: highlightSource, paint: { "circle-color": "#facc15", "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    for (const [id, name] of [["network-kpi-sections", "Sections"], ["network-kpi-lanes", "Lanes"], ["network-kpi-turns", "Turns"], ["network-kpi-nodes", "Nodes"]] as const) {
      if (this.networkClickHandlers.has(id)) continue;
      const handler = (event: any) => { const feature = event.features?.[0]; if (!feature) return; (this.map.getSource(highlightSource) as any)?.setData({ type: "FeatureCollection", features: [feature] }); new maplibregl.Popup({ closeButton: true, closeOnClick: false }).setLngLat(event.lngLat).setDOMContent(createIdentifyPopupElement(name, feature.properties ?? {}, feature.id)).addTo(this.map); };
      this.networkClickHandlers.set(id, handler); this.map.on("click", id, handler);
    }
    const beforeId = this.settings.seeThroughBuildings ? undefined : this.firstExtrusionLayerId();
    for (const id of ["network-kpi-sections", "network-kpi-lanes", "network-kpi-turns", "network-kpi-nodes"]) {
      if (this.map.getLayer(id)) { try { this.map.moveLayer(id, beforeId); } catch { /* style is changing */ } }
    }
  }

  private firstExtrusionLayerId(): string | undefined {
    return this.map.getStyle().layers?.find((layer) => layer.type === "fill-extrusion")?.id;
  }

  private unbindNetworkClickHandlers(): void {
    for (const [id, handler] of this.networkClickHandlers) this.map.off("click", id, handler);
    this.networkClickHandlers.clear();
  }

  private removeNetworkLayers(): void {
    this.unbindNetworkClickHandlers();
    // The highlight layers must go before their source removal below, same as
    // every other layer here — leaving them out left "network-kpi-selection"
    // still referenced, which MapLibre refuses to remove a source under.
    for (const id of ["network-kpi-sections", "network-kpi-lanes", "network-kpi-turns", "network-kpi-nodes", "network-kpi-selection-line", "network-kpi-selection-fill", "network-kpi-selection-circle"]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of ["network-kpi-sections-source", "network-kpi-lanes-source", "network-kpi-turns-source", "network-kpi-nodes-source", "network-kpi-selection"]) if (this.map.getSource(id)) this.map.removeSource(id);
  }

  /** Remove this engine's contribution to the shared deck overlay, if any. */
  private clearDeck(): void {
    if (!this.deckActive) return;
    setSharedDeckLayers(NETWORK_KPI_DECK_SOURCE, []);
    this.deckActive = false;
    setFrameStats(0, false);
  }
}

// ---------------------------------------------------------------------------
// Module store: single source of truth shared by the engine and the React panel.
// ---------------------------------------------------------------------------

let engine: NetworkKpiEngine | null = null;
let panelVisible = false;
let settings: NetworkKpiSettings = { ...DEFAULT_NETWORK_KPI_SETTINGS };
let loadedPackage: NetworkKpiPackage | null = null;
let status: NetworkKpiStatus = { ...IDLE_STATUS };
// Guards against a stale load resolving after the user has moved on to another
// manifest and overwriting the newer package.
let loadToken = 0;
let deckGLBundle: GeoLibreDeckGL | null = null;
let deckGLPending = false;
// The opened results database, kept resident so switching interval re-queries
// without re-downloading and re-inflating the whole file.
let database: ParquetResultsDatabase | null = null;
let readToken = 0;
let networkKpiLayerVisible = true;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

const panelListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

function notifyPanel(): void {
  for (const listener of panelListeners) listener();
}
function notifyState(): void {
  for (const listener of stateListeners) listener();
}
function notifyStatus(): void {
  for (const listener of statusListeners) listener();
}

function patchStatus(next: Partial<NetworkKpiStatus>): void {
  status = { ...status, ...next };
  notifyStatus();
}

/**
 * Record the most recent render's counters, notifying only when a displayed
 * value actually changed so a zoom gesture does not re-render the panel.
 */
function setFrameStats(featureCount: number, detailed: boolean): void {
  if (status.featureCount === featureCount && status.detailed === detailed) return;
  status = { ...status, featureCount, detailed };
  notifyStatus();
}

function ensureDeck(app: GeoLibreAppAPI): void {
  if (deckGLPending || !app.getDeckGL) return;
  if (deckGLBundle) {
    // The shared overlay is renderer-bound even though the deck module is
    // cached. Rebind it after a Cesium/MapLibre switch before redrawing KPI
    // layers; otherwise the plugin keeps a valid bundle but no mounted layer.
    void ensureSharedDeckOverlay(app).then(() => engine?.render());
    return;
  }
  deckGLPending = true;
  void app
    .getDeckGL()
    .then(async (bundle) => {
      deckGLBundle = bundle;
      await ensureSharedDeckOverlay(app);
      engine?.render();
    })
    .catch((error) => {
      console.warn("[GeoLibre] network-kpi: deck.gl unavailable", error);
    })
    .finally(() => {
      deckGLPending = false;
    });
}

function attachEngine(app: GeoLibreAppAPI): boolean {
  const map = app.getMap?.();
  if (!map) return false;
  if (engine && engine.getMapInstance() !== map) detachEngine();
  if (!engine) {
    engine = new NetworkKpiEngine(map, settings, loadedPackage, () => deckGLBundle);
  }
  ensureDeck(app);
  return true;
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
}

/** Open the network-kpi panel and attach the engine. Idempotent. */
export function openNetworkKpiPanel(app: GeoLibreAppAPI): void {
  appRef = app;
  registerNetworkKpiStoreLayer();
  registerDuckDbLayer({
    pluginId: "network-kpi",
    dispose: () => {
      database?.close();
      database = null;
      loadedPackage = null;
      engine?.setPackage(null);
    },
  });
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  attachEngine(app);
}

/**
 * Close the panel, clear the KPI polygons, and release the results database.
 *
 * The panel is the only thing driving this plugin's data, so once it is gone
 * nothing should keep a multi-megabyte SQLite image resident in the WASM heap
 * for a UI the user closed.
 */
export function closeNetworkKpiPanel(_app?: GeoLibreAppAPI): void {
  detachEngine();
  releaseDuckDbLayer("network-kpi");
  appRef?.unregisterExternalNativeLayer?.(NETWORK_KPI_STORE_LAYER_ID);
  loadToken += 1;
  database?.close();
  database = null;
  loadedPackage = null;
  pendingManifest = null;
  status = { ...IDLE_STATUS };
  notifyStatus();
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
    notifyState();
  }
}

export function isNetworkKpiPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeNetworkKpiPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/** Current settings (a copy callers may freely read). */
export function getNetworkKpiSettings(): NetworkKpiSettings {
  return { ...settings };
}

/** Stable settings reference for `useSyncExternalStore`. */
export function getNetworkKpiSnapshot(): NetworkKpiSettings {
  return settings;
}

export function subscribeNetworkKpi(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Stable load/progress snapshot for `useSyncExternalStore`. */
export function getNetworkKpiStatus(): NetworkKpiStatus {
  return status;
}

export function subscribeNetworkKpiStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Apply a partial settings change: normalize, push to the engine, and notify.
 *
 * A change to `interval` additionally re-queries the resident database, since
 * that is the one setting whose value is not derivable from what is already in
 * memory.
 *
 * @returns Whether something actually changed
 */
export function setNetworkKpiSettings(next: Partial<NetworkKpiSettings>): boolean {
  const normalized = normalizeNetworkKpiSettings(
    { ...settings, ...next },
    DEFAULT_NETWORK_KPI_SETTINGS,
  );
  if (settingsEqual(normalized, settings)) return false;
  const intervalChanged = normalized.interval !== settings.interval;
  const intervalPlayingChanged = normalized.intervalPlaying !== settings.intervalPlaying;
  settings = normalized;
  if (intervalChanged) requeryInterval();
  if (intervalPlayingChanged) syncIntervalTimer();
  engine?.applySettings(settings);
  notifyState();
  return true;
}

/** Re-read the resident database for the currently selected interval. */
function requeryInterval(): void {
  if (!database || !loadedPackage) return;
  const token = ++readToken;
  void database.read({ interval: settings.interval, did: settings.did }).then((results) => {
    if (token !== readToken || !database || !loadedPackage) return;
    loadedPackage = { ...loadedPackage, results };
    engine?.setPackage(loadedPackage);
  }).catch((error) => {
    if (token !== readToken) return;
    patchStatus({ error: error instanceof Error ? error.message : String(error) });
  });
}

/**
 * The manifest behind the currently loaded package, retained so switching
 * scenarios needs no second fetch.
 */
let pendingManifest: {
  raw: unknown;
  scenarios: VehicleManifestScenario[];
  url: string | null;
  directory: VehicleDirectoryHandle | null;
} | null = null;

/**
 * Point the plugin at a package and load its results.
 *
 * Passing an empty URL clears the current package. Failures are reported through
 * the status store rather than thrown, since the panel is the only caller.
 *
 * @param url - URL of the package's `manifest.json`
 */
export async function setNetworkKpiManifestUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  const token = (loadToken += 1);

  clearLoaded();
  clearNetworkKpiGeometryCache();
  networkKpiLayerVisible = true;

  if (!trimmed) {
    settings = { ...settings, manifestUrl: null };
    status = { ...IDLE_STATUS };
    notifyState();
    notifyStatus();
    return;
  }

  settings = { ...settings, manifestUrl: trimmed };
  notifyState();
  patchStatus({ loading: true, error: null, featureCount: 0 });

  try {
    const raw = await fetchNetworkKpiManifestJson(trimmed);
    if (token !== loadToken) return;
    const capability = capabilityAvailable(raw, "results");
    if (!capability.available) throw new Error(capability.reason ?? "Results are unavailable.");
    pendingManifest = {
      raw,
      scenarios: listVehicleManifestScenarios(raw),
      url: trimmed,
      directory: null,
    };
    await adoptScenario(0, token);
  } catch (error) {
    if (token !== loadToken) return;
    patchStatus({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
      scenarios: [],
    });
  }
}

/** Drop the current package, database and engine data. */
function clearLoaded(): void {
  database?.close();
  database = null;
  loadedPackage = null;
  engine?.setPackage(null);
}

function syncIntervalTimer(): void {
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  if (settings.intervalPlaying) intervalTimer = setInterval(() => stepNetworkKpiInterval(1), Math.max(100, 1000 / settings.playbackSpeed));
}

export function toggleNetworkKpiIntervalPlaying(): void {
  settings = { ...settings, intervalPlaying: !settings.intervalPlaying };
  syncIntervalTimer();
  notifyState();
}

/**
 * Playback/step only ever cycles the real time slices (`ent` 1..n) — `0` is
 * the whole-period aggregate, a separate static view rather than another
 * frame of the sequence, so it must never appear mid-cycle.
 */
export function stepNetworkKpiInterval(direction: 1 | -1): void {
  const values = status.intervals.filter((value) => value !== 0);
  if (values.length < 2) return;
  const currentIndex = values.indexOf(settings.interval);
  // On the aggregate (or any value outside the real slices), start the
  // sequence at its first frame rather than stepping relative to nothing.
  const nextIndex = currentIndex === -1
    ? (direction === 1 ? 0 : values.length - 1)
    : currentIndex + direction;
  if (!settings.loop && (nextIndex < 0 || nextIndex >= values.length)) {
    settings = { ...settings, intervalPlaying: false };
    syncIntervalTimer();
    notifyState();
    return;
  }
  const next = currentIndex === -1
    ? values[direction === 1 ? 0 : values.length - 1]
    : values[(nextIndex + values.length) % values.length];
  setNetworkKpiSettings({ interval: next });
}

/**
 * Build the geometry + results for one scenario of the retained manifest.
 *
 * The geometry and the results database are loaded in parallel and the results
 * are treated as REQUIRED (unlike vehicle-playback, where geometry is only a
 * backdrop): a KPI view with no KPI values has nothing to show, so a missing or
 * unreadable results database is surfaced as an error rather than swallowed.
 *
 * @param scenarioIndex - Which scenario to read
 * @param token - The load token this work belongs to; a newer load abandons it
 */
async function adoptScenario(scenarioIndex: number, token: number): Promise<void> {
  const pending = pendingManifest;
  if (!pending) return;

  clearLoaded();

  const manifest: NetworkKpiManifest = parseNetworkKpiManifest(
    pending.raw,
    pending.url,
    scenarioIndex,
  );
  const source: VehiclePackageSource = pending.directory
    ? createNetworkKpiDirectorySource(pending.directory)
    : createNetworkKpiHttpSource(pending.url ?? "");

  const geometry = await loadNetworkKpiGeometry(source, manifest.geometry);
  if (token !== loadToken) return;

  let results: NetworkKpiResults | null = null;
  let openError: string | null = null;
  if (manifest.resultsCatalogRelative) {
    try {
      const db = await ParquetResultsDatabase.open(source, manifest.resultsCatalogRelative, pending.raw);
      if (token !== loadToken) {
        db.close();
        return;
      }
      database = db;
      results = await db.read({ interval: settings.interval, did: settings.did });
      let timeline: SimulationTimeline | null = null; try { timeline = await db.readSimulationTimeline(results.did); } catch (error) { console.warn("[GeoLibre] network-kpi: SIM_INFO timing unavailable", error); }
      if (timeline) status = { ...status, timeline };
    } catch (error) {
      openError = error instanceof Error ? error.message : String(error);
    }
  } else {
    openError = "This package's manifest declares no Parquet results catalog.";
  }

  if (token !== loadToken) return;

  // `read()` may have resolved a different interval/did than requested (e.g.
  // the stale default `0` on a package with no whole-period aggregate row) —
  // reconcile settings to what the database actually returned so the
  // scrubber/aggregate-toggle reflect the real starting slice instead of a
  // value this package never had.
  if (results) {
    settings = { ...settings, interval: results.interval, did: results.did };
  }

  loadedPackage = { geometry, results, ramps: manifest.ramps };
  patchStatus({
    loading: false,
    error: openError,
    hasResults: results !== null,
    hasSections: Boolean(geometry.sections),
    hasLanes: Boolean(geometry.lanes),
    intervals: results?.intervals ?? [],
    scenarios: pending.scenarios,
    scenarioIndex,
    replications: manifest.package?.scenarios[scenarioIndex]?.replications ?? [],
    did: results?.did ?? null,
    localFolderName: pending.directory?.name ?? null,
  });
  notifyState();
  engine?.setPackage(loadedPackage);

  if (manifest.bounds) fitNetworkKpiBounds(manifest.bounds);
}

/**
 * Switch the loaded package to another of its manifest's scenarios.
 *
 * No-ops for a single-scenario package or an out-of-range index, so the panel
 * can call it unconditionally.
 */
export async function setNetworkKpiScenario(scenarioIndex: number): Promise<void> {
  const pending = pendingManifest;
  if (!pending || scenarioIndex === status.scenarioIndex) return;
  if (scenarioIndex < 0 || scenarioIndex >= pending.scenarios.length) return;

  const token = (loadToken += 1);
  // A scenario change points at a different replication catalog, so the
  // previous scenario's `did` (and the interval it was read at, since a
  // different scenario is not guaranteed to have the same interval set)
  // must not leak into the new scenario's lookup — otherwise adoptScenario()
  // reads the new database with a stale `did`/`interval` that either points
  // at nothing (empty result) or silently reuses another scenario's row.
  // `setNetworkKpiReplication` is the only place a replication choice should
  // persist across settings changes, so this reset is scoped to the scenario
  // switch here and does not touch that path.
  settings = { ...settings, did: null, interval: 0 };
  patchStatus({ loading: true, error: null, featureCount: 0 });
  try {
    await adoptScenario(scenarioIndex, token);
  } catch (error) {
    if (token !== loadToken) return;
    patchStatus({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Select a replication (did) within the active scenario. */
export function setNetworkKpiReplication(did: number | null): void {
  settings = { ...settings, did };
  if (!database || !loadedPackage) return;
  const token = ++readToken;
  void database.read({ interval: settings.interval, did }).then((results) => {
    if (token !== readToken || !database || !loadedPackage) return;
    loadedPackage = { ...loadedPackage, results };
    patchStatus({ did: results.did });
    engine?.setPackage(loadedPackage);
    notifyState();
  }).catch((error) => { if (token === readToken) patchStatus({ error: error instanceof Error ? error.message : String(error) }); });
}

/** Whether this browser can open a local package folder (Chromium only). */
export function canLoadLocalNetworkKpiPackage(): boolean {
  return supportsLocalPackageFolders();
}

/**
 * Prompt for a package folder and load its results from disk.
 *
 * Reads `manifest.json`, then the geometry and `results.sqlite.gz` through the
 * directory handle instead of the network, so a package never has to be served
 * over HTTP to be inspected. A cancelled picker resolves quietly.
 */
export async function loadLocalNetworkKpiFolder(): Promise<void> {
  if (!supportsLocalPackageFolders()) {
    patchStatus({
      loading: false,
      error: "This browser cannot open local folders. Use Chrome or Edge, or load a URL.",
    });
    return;
  }

  let directory: VehicleDirectoryHandle;
  try {
    directory = await (
      window as unknown as { showDirectoryPicker: () => Promise<VehicleDirectoryHandle> }
    ).showDirectoryPicker();
  } catch (error) {
    // AbortError is the user dismissing the picker: not a failure.
    if (error instanceof Error && error.name === "AbortError") return;
    patchStatus({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const token = (loadToken += 1);
  clearLoaded();
  clearNetworkKpiGeometryCache();
  networkKpiLayerVisible = true;
  // A local package has no URL; clear the persisted one so a project reload does
  // not try to re-fetch a manifest that never came from the network.
  settings = { ...settings, manifestUrl: null };
  notifyState();
  patchStatus({ loading: true, error: null, featureCount: 0 });

  try {
    const raw = await readLocalNetworkKpiManifestJson(directory);
    if (token !== loadToken) return;
    // Validate the handle up front so a wrong folder fails here, clearly.
    createNetworkKpiDirectorySource(directory);
    pendingManifest = {
      raw,
      scenarios: listVehicleManifestScenarios(raw),
      url: null,
      directory,
    };
    await adoptScenario(0, token);
  } catch (error) {
    if (token !== loadToken) return;
    patchStatus({
      loading: false,
      error:
        error instanceof Error
          ? `Could not read the package folder: ${error.message}`
          : String(error),
      scenarios: [],
    });
  }
}

// The app API is captured on attach so a load triggered from the panel (which
// has no app handle of its own) can still frame the package.
let appRef: GeoLibreAppAPI | null = null;

function fitNetworkKpiBounds(bounds: [number, number, number, number]): void {
  appRef?.fitBounds?.(bounds);
}

function registerNetworkKpiStoreLayer(): void {
  appRef?.registerExternalNativeLayer?.({
    id: NETWORK_KPI_STORE_LAYER_ID,
    name: "Network KPI",
    type: "geojson",
    nativeLayerIds: [],
    paintMode: "plugin",
    metadata: { customLayerType: "deck.gl" },
    paintBridge: { setVisibility: (visible) => { networkKpiLayerVisible = visible; engine?.render(); } },
  });
}

/**
 * Apply a saved project's network-kpi state: adopt its settings, reload the
 * package from the persisted manifest URL, and open or close the panel to match
 * the persisted `open` flag. Mirrors vehicle-playback's restore path.
 *
 * @returns Whether anything changed
 */
export function restoreNetworkKpi(app: GeoLibreAppAPI, state?: unknown): boolean {
  appRef = app;
  const next = normalizeNetworkKpiSettings(state, { ...DEFAULT_NETWORK_KPI_SETTINGS });

  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  // A delayed project/renderer restore can arrive after a user starts loading a
  // package, even before its manifest resolves. Keep the live URL, settings,
  // database and load token for a compatible restore so the load can finish
  // without losing the panel tabs or restarting playback. An explicit close or
  // a different manifest still takes the normal restore path below.
  if (
    shouldOpen && panelVisible && (loadedPackage || status.loading) &&
    (!next.manifestUrl || next.manifestUrl === settings.manifestUrl)
  ) {
    attachEngine(app);
    return false;
  }

  // Drop the previous project's package so nothing draws stale results while the
  // new one loads. Since this always clears, the re-fetch below must not be
  // gated on whether the URL text changed.
  clearLoaded();
  status = { ...IDLE_STATUS };
  notifyStatus();

  let changed = false;
  if (!settingsEqual(next, settings)) {
    settings = next;
    notifyState();
    changed = true;
  }
  engine?.applySettings(settings);

  const wasVisible = panelVisible;
  if (shouldOpen) openNetworkKpiPanel(app);
  else closeNetworkKpiPanel(app);

  // Re-fetch after the panel state settles, so the engine exists to receive it.
  if (next.manifestUrl) {
    void setNetworkKpiManifestUrl(next.manifestUrl);
  }
  return changed || panelVisible !== wasVisible;
}

/**
 * Re-bind the engine to the current map without touching open/closed state.
 * Called after a map re-init or basemap change; must never reset the panel.
 */
export function reattachNetworkKpi(app: GeoLibreAppAPI): void {
  appRef = app;
  if (panelVisible) attachEngine(app);
  else detachEngine();
}

export const maplibreNetworkKpiPlugin: GeoLibrePlugin = {
  id: NETWORK_KPI_PLUGIN_ID,
  name: "Network KPI",
  version: "1.0.0",
  activeByDefault: false,
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    openNetworkKpiPanel(app);
  },
  deactivate: (app: GeoLibreAppAPI) => closeNetworkKpiPanel(app),
  // Persist the panel-open flag plus settings (including the manifest URL, so a
  // saved project reopens on the same package) but never the results themselves.
  getProjectState: () => {
    if (!panelVisible && isDefaultSettings(settings)) return undefined;
    return { open: panelVisible, ...settings };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => restoreNetworkKpi(app, state),
};
