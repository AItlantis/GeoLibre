import type { Map as MapLibreMap } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { createIdentifyPopupElement } from "@geolibre/map";
import type { Layer } from "@deck.gl/core";
import { mercatorMetersPerPixelAtZoom0 } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibrePlugin } from "../types";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import {
  articulatedVehicleFootprints,
  createDirectoryPackageSource,
  createHttpPackageSource,
  deriveNodePolygonsFromTurns,
  fetchVehicleManifestJson,
  isArticulatedSample,
  listVehicleManifestScenarios,
  loadScenarioAnimationManifest,
  loadVehicleGeometry,
  openLocalVehiclePackage,
  parseVehicleManifest,
  readLocalVehicleManifestJson,
  supportsLocalPackageFolders,
  VehiclePlaybackData,
  type VehiclePackageSource,
  vehicleFootprint,
  type VehicleDirectoryHandle,
  type VehicleGeometryLayers,
  type VehicleManifestScenario,
  type VehicleSample,
} from "./vehicle-playback-data";
import { vehicleColorRgb } from "./vehicle-shape-catalog";
import { capabilityAvailable } from "./geolibre-package-loader";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";

/**
 * GeoLibre vehicle-playback plugin.
 *
 * Plays back a microsimulation traffic package — hundreds of vehicles moving
 * simultaneously — as continuous animation rather than a tick-by-tick slideshow.
 * A floating panel (rendered by the desktop shell) takes the URL of a Testudo
 * VWE package's `manifest.json` and drives play / pause / speed / loop plus a
 * scrub timeline.
 *
 * The heavy lifting lives in `vehicle-playback-data.ts`: gzipped event chunks
 * stream in around the playhead, a checkpointed replay reconstructs the exact
 * vehicle table at any whole tick, and a sub-tick interpolator blends the two
 * frames bracketing the (fractional) playhead. This engine owns only the
 * playback clock and the rendering.
 *
 * Vehicles are drawn as oriented footprint rectangles through the shared deck.gl
 * overlay, as a **single** `PolygonLayer` rebuilt per frame from every current
 * vehicle. Per-vehicle MapLibre GeoJSON features (the route-animation approach)
 * do not hold up at this feature count and update rate.
 *
 * Only lightweight settings persist with the project — the manifest URL, not the
 * chunk data, which is re-fetched at runtime like Testudo's own loader does.
 */

export const VEHICLE_PLAYBACK_PLUGIN_ID = "geolibre-vehicle-playback";

const VEHICLE_PLAYBACK_DECK_SOURCE = "vehicle-playback";
const VEHICLE_PLAYBACK_STORE_LAYER_ID = "geolibre-vehicle-playback-layer";

/** Persisted, user-tunable state of the vehicle playback. */
export interface VehiclePlaybackSettings {
  /** URL of the package's `manifest.json`, or null when none is loaded. */
  manifestUrl: string | null;
  /** Whether the playhead is advancing. */
  playing: boolean;
  /** Playback rate: 1 = real time, 2 = twice as fast. */
  speed: number;
  /** When true, playback wraps to tick 0 instead of stopping at the end. */
  loop: boolean;
  /** Playhead position in ticks (fractional; interpolated between events). */
  tick: number;
  /** Opacity applied to every vehicle footprint, on top of its own fade. */
  opacity: number;
  /**
   * When true, vehicles AND the network geometry draw over 3D buildings and
   * terrain instead of being occluded by them. See
   * {@link VehiclePlaybackEngine.render} for how this maps onto deck.gl's depth
   * parameters for the vehicles, and
   * {@link VehiclePlaybackEngine.syncNetworkDepthOrder} for the layer-ordering
   * equivalent the MapLibre network layers need.
   */
  seeThroughBuildings: boolean;
  /** Whether the network geometry layers are drawn at all. */
  showNetwork: boolean;
  showSections: boolean;
  showLanes: boolean;
  showTurns: boolean;
  showNodes: boolean;
}

/** Legacy type retained for project-state consumers; visibility is now per layer. */
export type VehicleNetworkView = "sections" | "lanes";

/**
 * The two network views the panel toggles between.
 *
 * `sections` is the COARSE view: section centerlines plus junction/node points.
 * `lanes` is the DETAILED view: per-lane geometry plus turn movements. The
 * pairing matters — nodes are a coarse summary of a junction, whereas turns are
 * the individual lane-to-lane movements through it, so turns belong with lanes
 * and nodes with sections. (This was previously wired the other way around.)
 *
 * The VWE format carries no nodes/junctions file (see `VehicleGeometrySources`),
 * so the coarse view falls back to drawing the turns geometry in a distinct
 * node-like point style rather than inventing one.
 */

export const VEHICLE_PLAYBACK_SPEED_MIN = 0.25;
export const VEHICLE_PLAYBACK_SPEED_MAX = 20;
export const VEHICLE_PLAYBACK_OPACITY_MIN = 0.1;
export const VEHICLE_PLAYBACK_OPACITY_MAX = 1;

export const DEFAULT_VEHICLE_PLAYBACK_SETTINGS: VehiclePlaybackSettings = {
  manifestUrl: null,
  playing: false,
  speed: 1,
  loop: true,
  tick: 0,
  opacity: 0.95,
  // Preserves the behavior this plugin shipped with: the footprints were drawn
  // with an unconditional `depthCompare: "always"`, i.e. always on top.
  seeThroughBuildings: true,
  showNetwork: true,
  showSections: true,
  showLanes: true,
  showTurns: true,
  showNodes: true,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into complete settings. */
export function normalizeVehiclePlaybackSettings(
  value: unknown,
  base: VehiclePlaybackSettings = DEFAULT_VEHICLE_PLAYBACK_SETTINGS,
): VehiclePlaybackSettings {
  const c = (value ?? {}) as Partial<VehiclePlaybackSettings>;
  return {
    manifestUrl:
      typeof c.manifestUrl === "string" && c.manifestUrl.length > 0
        ? c.manifestUrl
        : base.manifestUrl,
    playing: typeof c.playing === "boolean" ? c.playing : base.playing,
    speed: clampNumber(c.speed, VEHICLE_PLAYBACK_SPEED_MIN, VEHICLE_PLAYBACK_SPEED_MAX, base.speed),
    loop: typeof c.loop === "boolean" ? c.loop : base.loop,
    tick: typeof c.tick === "number" && Number.isFinite(c.tick) ? Math.max(0, c.tick) : base.tick,
    opacity: clampNumber(
      c.opacity,
      VEHICLE_PLAYBACK_OPACITY_MIN,
      VEHICLE_PLAYBACK_OPACITY_MAX,
      base.opacity,
    ),
    seeThroughBuildings:
      typeof c.seeThroughBuildings === "boolean"
        ? c.seeThroughBuildings
        : base.seeThroughBuildings,
    showNetwork: typeof c.showNetwork === "boolean" ? c.showNetwork : base.showNetwork,
    showSections: typeof c.showSections === "boolean" ? c.showSections : base.showSections,
    showLanes: typeof c.showLanes === "boolean" ? c.showLanes : base.showLanes,
    showTurns: typeof c.showTurns === "boolean" ? c.showTurns : base.showTurns,
    showNodes: typeof c.showNodes === "boolean" ? c.showNodes : base.showNodes,
  };
}

function settingsEqual(a: VehiclePlaybackSettings, b: VehiclePlaybackSettings): boolean {
  return (
    a.manifestUrl === b.manifestUrl &&
    a.playing === b.playing &&
    a.speed === b.speed &&
    a.loop === b.loop &&
    a.tick === b.tick &&
    a.opacity === b.opacity &&
    a.seeThroughBuildings === b.seeThroughBuildings &&
    a.showNetwork === b.showNetwork &&
    a.showSections === b.showSections && a.showLanes === b.showLanes &&
    a.showTurns === b.showTurns && a.showNodes === b.showNodes
  );
}

function isDefaultSettings(value: VehiclePlaybackSettings): boolean {
  return settingsEqual(value, DEFAULT_VEHICLE_PLAYBACK_SETTINGS);
}

/** Progress/diagnostic state the panel shows but the project never persists. */
export interface VehiclePlaybackStatus {
  /** True while the manifest is being fetched. */
  loading: boolean;
  /** Last load failure, or null. */
  error: string | null;
  /** Highest addressable tick of the loaded package (0 when none). */
  maxTick: number;
  /** Simulation seconds per tick (1 when no package is loaded). */
  dt: number;
  /** Vehicles drawn in the most recent frame. */
  vehicleCount: number;
  /** Fraction of the chunk catalog currently resident, in `[0, 1]`. */
  loadedFraction: number;
  /**
   * Every scenario the loaded manifest offers. Length 1 for an ordinary
   * single-scenario package, so the panel can hide the picker entirely.
   */
  scenarios: VehicleManifestScenario[];
  /** Index of the scenario currently streaming. */
  scenarioIndex: number;
  /** Which network geometry files the loaded package actually carries. */
  hasSections: boolean;
  hasLanes: boolean;
  hasTurns: boolean;
  /** True when the package was opened from a local folder rather than a URL. */
  localFolderName: string | null;
}

const IDLE_STATUS: VehiclePlaybackStatus = {
  loading: false,
  error: null,
  maxTick: 0,
  dt: 1,
  vehicleCount: 0,
  loadedFraction: 0,
  scenarios: [],
  scenarioIndex: 0,
  hasSections: false,
  hasLanes: false,
  hasTurns: false,
  localFolderName: null,
};

// ---------------------------------------------------------------------------
// Map engine: owns the playback clock and the per-frame deck.gl layer.
// ---------------------------------------------------------------------------

/** Ticks between coverage checks, so streaming is not re-evaluated per frame. */
const COVERAGE_CHECK_INTERVAL_TICKS = 15;

/**
 * One polygon row of the per-frame layer.
 *
 * An ordinary vehicle produces exactly one row, as before. An articulated one
 * (currently trams) produces one row per body segment, all sharing the same
 * `sample` so color, opacity and height accessors are unchanged — only the ring
 * differs between a vehicle's segments.
 */
interface VehicleRow {
  sample: VehicleSample;
  ring: [number, number][];
}

/**
 * Flatten a frame's samples into the layer's polygon rows, expanding
 * articulated vehicles into their segments.
 */
function buildVehicleRows(samples: VehicleSample[], data: VehiclePlaybackData): VehicleRow[] {
  const rows: VehicleRow[] = [];
  for (const sample of samples) {
    if (isArticulatedSample(sample)) {
      for (const ring of articulatedVehicleFootprints(
        sample,
        data.getArticulationHistory(sample.id),
      )) {
        rows.push({ sample, ring });
      }
    } else {
      rows.push({ sample, ring: vehicleFootprint(sample) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Network geometry (sections / lanes / turns), drawn as plain MapLibre GeoJSON
// layers underneath the deck.gl vehicles.
// ---------------------------------------------------------------------------

const NETWORK_SOURCE_PREFIX = "vehicle-playback-network";
const SECTIONS_SOURCE_ID = `${NETWORK_SOURCE_PREFIX}-sections`;
const LANES_SOURCE_ID = `${NETWORK_SOURCE_PREFIX}-lanes`;
const TURNS_SOURCE_ID = `${NETWORK_SOURCE_PREFIX}-turns`;
const NODES_SOURCE_ID = `${NETWORK_SOURCE_PREFIX}-nodes`;

const SECTIONS_LAYER_ID = `${SECTIONS_SOURCE_ID}-line`;
const LANES_LAYER_ID = `${LANES_SOURCE_ID}-line`;
const TURNS_LAYER_ID = `${TURNS_SOURCE_ID}-line`;
const NODES_LAYER_ID = `${NODES_SOURCE_ID}-circle`;

/** Source ids in the order they must be torn down (layers first, then these). */
const NETWORK_SOURCE_IDS = [
  SECTIONS_SOURCE_ID,
  LANES_SOURCE_ID,
  TURNS_SOURCE_ID,
  NODES_SOURCE_ID,
] as const;
const NETWORK_LAYER_IDS = [
  NODES_LAYER_ID,
  TURNS_LAYER_ID,
  LANES_LAYER_ID,
  SECTIONS_LAYER_ID,
] as const;

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] } as const;

/**
 * Assumed width of one traffic lane, in meters, when a feature carries no real
 * width data.
 *
 * Testudo's own exporter uses a road-class-dependent fallback when it computes
 * `total_width`; this plugin only ever sees the result, so where that property
 * is absent entirely (older exports carry `num_lanes` but no `total_width`) the
 * flat 3 m per lane below is the best reconstruction available here.
 */
const FALLBACK_LANE_WIDTH_M = 3;

/** Last-resort width for a feature with neither width nor lane-count data. */
const FALLBACK_SECTION_WIDTH_M = FALLBACK_LANE_WIDTH_M;

// Largest zoom MapLibre renders; the upper stop of the width interpolation.
const MAX_MERCATOR_ZOOM = 24;

/**
 * Wrap a ground-meters width expression as a zoom-driven `line-width`, so the
 * line keeps a constant REAL-WORLD width instead of a constant pixel width.
 *
 * This is the same construction as `metersWidthExpression` in
 * `@geolibre/core`'s `vector-color`, which the vector style pipeline uses for
 * QGIS-style "map units" strokes — `["interpolate", ["exponential", 2],
 * ["zoom"], 0, w0, 24, w0 * 2^24]`. It is reimplemented here rather than called
 * because that helper takes a scalar number, while these network layers need
 * the meters value to come from each feature's own properties; the per-feature
 * `["get", ...]` expression is therefore divided by the zoom-0 ground
 * resolution inside the stops.
 *
 * MapLibre rejects `["zoom"]` anywhere below the top level of a paint
 * expression, which is exactly why the data-driven part has to sit inside the
 * stop VALUES like this rather than wrapping an interpolate of its own.
 *
 * Referenced to the equator, like the core helper: Mercator stretches distances
 * toward the poles, so the on-screen width grows with latitude in step with the
 * basemap underneath it.
 *
 * @param metersExpression - A MapLibre expression evaluating to ground meters
 * @returns A MapLibre `interpolate` expression array
 */
export function metersLineWidthExpression(metersExpression: unknown): unknown[] {
  const metersPerPixelAtZoom0 = mercatorMetersPerPixelAtZoom0();
  const widthAtZoom0 = ["/", metersExpression, metersPerPixelAtZoom0];
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    0,
    widthAtZoom0,
    MAX_MERCATOR_ZOOM,
    ["*", widthAtZoom0, 2 ** MAX_MERCATOR_ZOOM],
  ];
}

/**
 * Ground width in meters of a section feature, from the real data Testudo's
 * exporter writes onto it.
 *
 * Preference order, most direct first:
 *
 * 1. `total_width` — the exporter's own already-summed per-lane widths, which
 *    already applies its road-class-dependent fallback for lanes with no width
 *    of their own. Confirmed present on current exports (values 3–77 m).
 * 2. `num_lanes` × {@link FALLBACK_LANE_WIDTH_M} — older exports carry the lane
 *    count but no `total_width` at all, so this reconstructs it.
 * 3. A single fallback lane, for a feature carrying neither.
 *
 * Both properties are read through `["to-number", ..., 0]` and then rejected
 * when they come back 0, so a null, a missing key and an explicit zero all fall
 * through to the next source rather than collapsing the line to nothing.
 */
export function sectionWidthMetersExpression(): unknown {
  return [
    "max", 0.1,
    ["case", [">", ["to-number", ["get", "total_width"], 0], 0], ["to-number", ["get", "total_width"], 0], [">", ["to-number", ["get", "num_lanes"], 0], 0], ["*", ["to-number", ["get", "num_lanes"], 0], FALLBACK_LANE_WIDTH_M], FALLBACK_SECTION_WIDTH_M],
  ];
}

/**
 * Ground width in meters of a single lane feature.
 *
 * Lane features carry their own `width` directly (confirmed present on current
 * exports), so there is no lane count to multiply here — one feature is one
 * lane. A missing or zero width falls back to {@link FALLBACK_LANE_WIDTH_M}.
 */
export function laneWidthMetersExpression(): unknown {
  return [
    "max", 0.1,
    ["case", [">", ["to-number", ["get", "width"], 0], 0], ["to-number", ["get", "width"], 0], FALLBACK_LANE_WIDTH_M],
  ];
}

/**
 * Ground width in meters of a turn (lane-to-lane movement) feature.
 *
 * Turn features carry `lane_width` plus an often-null `turn_lane_count`; a turn
 * is drawn as the movement's own width, so the count is multiplied in only when
 * the exporter actually supplied one.
 */
export function turnWidthMetersExpression(): unknown {
  return [
    "max", 0.1, ["*",
    [
      "case",
      [">", ["to-number", ["get", "lane_width"], 0], 0],
      ["to-number", ["get", "lane_width"], 0],
      FALLBACK_LANE_WIDTH_M,
    ],
    [
      "case",
      [">", ["to-number", ["get", "turn_lane_count"], 0], 0],
      ["to-number", ["get", "turn_lane_count"], 0],
      1,
    ]],
  ];
}

class VehiclePlaybackEngine {
  private readonly map: MapLibreMap;
  private settings: VehiclePlaybackSettings;
  private data: VehiclePlaybackData | null = null;
  /** Parsed network GeoJSON for the loaded package, or null when none. */
  private geometry: VehicleGeometryLayers | null = null;
  private readonly handleStyleData: () => void;
  private readonly networkClickHandlers = new Map<string, (event: any) => void>();
  private rafId: number | null = null;
  private lastFrame: number | null = null;
  private destroyed = false;
  private deckActive = false;
  /** Playhead at the last coverage check, to throttle the streaming calls. */
  private lastCoverageTick = Number.NEGATIVE_INFINITY;
  // Lazily-resolved deck.gl bundle; null until the host resolves it, during
  // which nothing is drawn (the package is usually still streaming anyway).
  private readonly getDeck: () => GeoLibreDeckGL | null;

  constructor(
    map: MapLibreMap,
    settings: VehiclePlaybackSettings,
    data: VehiclePlaybackData | null,
    getDeck: () => GeoLibreDeckGL | null,
  ) {
    this.map = map;
    this.settings = settings;
    this.data = data;
    this.getDeck = getDeck;
    this.tick = this.tick.bind(this);
    // A basemap style swap wipes custom sources/layers; re-add them when the
    // new style settles (the idiom used by the sun and graticule plugins).
    this.handleStyleData = () => {
      if (this.destroyed) return;
      this.unbindNetworkClickHandlers();
      this.syncNetworkLayers();
    };
    this.map.on("styledata", this.handleStyleData);
    this.render();
    if (settings.playing && data) this.play();
  }

  /** Adopt the loaded package's network geometry and draw it. */
  setGeometry(geometry: VehicleGeometryLayers | null): void {
    this.geometry = geometry;
    this.syncNetworkLayers();
  }

  /**
   * Create, update or remove the network GeoJSON sources and layers so the map
   * matches `showNetwork` / `networkView`.
   *
   * Idempotent, and safe to call before the style is ready — the `styledata`
   * handler re-runs it once MapLibre can accept sources.
   */
  private syncNetworkLayers(): void {
    if (this.destroyed) return;
    const map = this.map;
    // Adding a source before the style has loaded throws.
    if (!map.isStyleLoaded()) return;

    const geometry = this.geometry;
    const selection = this.map.getSource(`${NETWORK_SOURCE_PREFIX}-selection`) as { setData?: (value: never) => void } | undefined;
    selection?.setData?.({ type: "FeatureCollection", features: [] } as never);
    if (!geometry || !this.settings.showNetwork) {
      this.removeNetworkLayers();
      return;
    }

    // The VWE format has no nodes/junctions polygon file, so the COARSE view
    // approximates each junction's footprint as the convex hull of the turn
    // connectors that meet there, instead of the fixed-radius circle this
    // used to draw (see #1250; deriveNodePolygonsFromTurns in
    // vehicle-playback-data.ts).
    const nodesData = geometry.nodes ?? deriveNodePolygonsFromTurns(geometry.turns);

    this.ensureLineSource(SECTIONS_SOURCE_ID, geometry.sections);
    this.ensureLineSource(LANES_SOURCE_ID, geometry.lanes);
    this.ensureLineSource(TURNS_SOURCE_ID, geometry.turns);
    this.ensureLineSource(NODES_SOURCE_ID, nodesData);

    // Line widths are driven from the REAL width data Testudo's exporter writes
    // onto each feature (sections: `total_width` / `num_lanes`; lanes: `width`;
    // turns: `lane_width` × `turn_lane_count`), converted to screen pixels by
    // the same zoom-driven construction the core vector styler uses for
    // "map units" strokes. A section therefore reads as wide as it really is
    // relative to the basemap, instead of a flat 2.5 px at every zoom.
    this.ensureLineLayer(SECTIONS_LAYER_ID, SECTIONS_SOURCE_ID, {
      "line-color": "#64748b",
      "line-width": metersLineWidthExpression(sectionWidthMetersExpression()),
      "line-opacity": 0.85,
    });
    this.ensureLineLayer(LANES_LAYER_ID, LANES_SOURCE_ID, {
      "line-color": "#94a3b8",
      "line-width": metersLineWidthExpression(laneWidthMetersExpression()),
      "line-opacity": 0.8,
    });
    this.ensureLineLayer(TURNS_LAYER_ID, TURNS_SOURCE_ID, {
      "line-color": "#cbd5e1",
      "line-width": metersLineWidthExpression(turnWidthMetersExpression()),
      "line-opacity": 0.75,
    });
    this.ensureFillLayer(NODES_LAYER_ID, NODES_SOURCE_ID, {
      "fill-color": "#a8b5c7",
      "fill-opacity": 0.6,
    });

    // Coarse view is "Sections + Nodes"; detailed is "Lanes + Turns". Turns are
    // per-lane movements, so they belong with the lane geometry; nodes are the
    // coarse junction summary, so they belong with the section centerlines.
    this.setLayerVisible(SECTIONS_LAYER_ID, this.settings.showSections && Boolean(geometry.sections));
    this.setLayerVisible(NODES_LAYER_ID, this.settings.showNodes && Boolean(nodesData));
    this.setLayerVisible(LANES_LAYER_ID, this.settings.showLanes && Boolean(geometry.lanes));
    this.setLayerVisible(TURNS_LAYER_ID, this.settings.showTurns && Boolean(geometry.turns));
    this.bindNetworkClickHandlers();

    this.syncNetworkDepthOrder();
  }

  /**
   * Apply the `seeThroughBuildings` setting to the network layers.
   *
   * MapLibre's own 2D line/circle layers have no `depthTest`-equivalent paint
   * property — the deck.gl `depthCompare` trick the vehicle layer uses is not
   * available here. What decides whether a line is hidden by a 3D building is
   * the style's LAYER ORDER: a `fill-extrusion` building layer writes depth, so
   * any line layer ordered before it is drawn first and then painted over.
   *
   * So the equivalent mechanism is to move the network layers to the very top
   * of the style when the toggle is on (drawn last, over the buildings), and to
   * move them back below the first 3D extrusion layer when it is off, so the
   * buildings occlude them again. This is the same `map.moveLayer` approach the
   * 3D-tiles plugin uses to keep its own layers correctly ordered.
   *
   * Note: GeoLibre's default basemap style ships no `fill-extrusion` layer, so
   * on a stock project there is nothing for this to hide behind and the toggle
   * has no VISIBLE effect on the network. It takes effect as soon as a 3D
   * buildings / extrusion layer is added to the style (Overture buildings, an
   * extruded vector layer, the geo-editor's 3D mode).
   */
  private syncNetworkDepthOrder(): void {
    if (this.destroyed) return;
    const map = this.map;
    if (!map.isStyleLoaded()) return;

    // Ordered bottom-to-top within the network itself: sections/lanes first,
    // then turns, then the node points on top, matching how they were added.
    const ordered = [
      SECTIONS_LAYER_ID,
      LANES_LAYER_ID,
      TURNS_LAYER_ID,
      NODES_LAYER_ID,
    ] as const;

    // When seeing through is OFF, sit below the first 3D extrusion layer so it
    // can occlude us. With no such layer in the style, `beforeId` is undefined
    // and `moveLayer` simply moves to the top — the same place the ON branch
    // puts them, which is exactly right: with no buildings there is nothing to
    // be occluded by either way.
    const beforeId = this.settings.seeThroughBuildings
      ? undefined
      : this.firstExtrusionLayerId();

    for (const id of ordered) {
      if (!map.getLayer(id)) continue;
      try {
        map.moveLayer(id, beforeId);
      } catch {
        // A layer the style dropped mid-swap; the styledata handler re-syncs.
      }
    }
  }

  /** Id of the lowest `fill-extrusion` layer in the style, if the style has one. */
  private firstExtrusionLayerId(): string | undefined {
    const layers = this.map.getStyle()?.layers as { id: string; type: string }[] | undefined;
    if (!layers) return undefined;
    for (const layer of layers) {
      if (layer.type === "fill-extrusion") return layer.id;
    }
    return undefined;
  }

  /** Add a GeoJSON source, or update its data when it already exists. */
  private ensureLineSource(id: string, data: unknown | null): void {
    const map = this.map;
    const payload = (data ?? EMPTY_FEATURE_COLLECTION) as never;
    const existing = map.getSource(id) as { setData?: (value: never) => void } | undefined;
    if (existing) {
      existing.setData?.(payload);
      return;
    }
    map.addSource(id, { type: "geojson", data: payload });
  }

  private bindNetworkClickHandlers(): void {
    const highlightSource = `${NETWORK_SOURCE_PREFIX}-selection`;
    if (!this.map.getSource(highlightSource)) this.map.addSource(highlightSource, { type: "geojson", data: EMPTY_FEATURE_COLLECTION as never });
    if (!this.map.getLayer(`${highlightSource}-line`)) this.map.addLayer({ id: `${highlightSource}-line`, type: "line", source: highlightSource, paint: { "line-color": "#facc15", "line-width": 4 } });
    if (!this.map.getLayer(`${highlightSource}-circle`)) this.map.addLayer({ id: `${highlightSource}-circle`, type: "circle", source: highlightSource, paint: { "circle-color": "#facc15", "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    for (const [layerId, layerName] of [[SECTIONS_LAYER_ID, "Sections"], [LANES_LAYER_ID, "Lanes"], [TURNS_LAYER_ID, "Turns"], [NODES_LAYER_ID, "Nodes"]] as const) {
      if (this.networkClickHandlers.has(layerId)) continue;
      const handler = (event: any) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const source = this.map.getSource(highlightSource) as any;
        source?.setData({ type: "FeatureCollection", features: [feature] });
        new maplibregl.Popup({ closeButton: true, closeOnClick: false }).setLngLat(event.lngLat).setDOMContent(createIdentifyPopupElement(layerName, feature.properties ?? {}, feature.id)).addTo(this.map);
      };
      this.networkClickHandlers.set(layerId, handler);
      this.map.on("click", layerId, handler);
    }
  }

  private ensureLineLayer(id: string, source: string, paint: Record<string, unknown>): void {
    if (this.map.getLayer(id)) return;
    this.map.addLayer({
      id,
      type: "line",
      source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: paint as never,
    } as never);
  }

  private unbindNetworkClickHandlers(): void {
    for (const [id, handler] of this.networkClickHandlers) this.map.off("click", id, handler);
    this.networkClickHandlers.clear();
  }

  private ensureFillLayer(id: string, source: string, paint: Record<string, unknown>): void {
    if (this.map.getLayer(id)) return;
    this.map.addLayer({ id, type: "fill", source, paint: paint as never } as never);
  }

  private setLayerVisible(id: string, visible: boolean): void {
    if (!this.map.getLayer(id)) return;
    this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }

  /** Remove every network layer and source this engine added, if present. */
  private removeNetworkLayers(): void {
    const map = this.map;
    this.unbindNetworkClickHandlers();
    for (const id of NETWORK_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of NETWORK_SOURCE_IDS) {
      if (map.getSource(id)) map.removeSource(id);
    }
    const selectionSource = `${NETWORK_SOURCE_PREFIX}-selection`;
    for (const id of [`${selectionSource}-line`, `${selectionSource}-circle`]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(selectionSource)) map.removeSource(selectionSource);
  }

  getMapInstance(): MapLibreMap {
    return this.map;
  }

  /** Adopt a freshly loaded package (or clear it) and redraw. */
  setData(data: VehiclePlaybackData | null): void {
    this.data = data;
    this.lastCoverageTick = Number.NEGATIVE_INFINITY;
    if (!data) {
      this.pause();
      this.clearDeck();
      // The network belongs to the package that was just cleared.
      this.setGeometry(null);
      return;
    }
    this.render();
    if (this.settings.playing && this.rafId === null) this.play();
  }

  applySettings(settings: VehiclePlaybackSettings): void {
    const wasPlaying = this.settings.playing;
    const previous = this.settings;
    this.settings = settings;
    this.render();
    if (
      settings.showNetwork !== previous.showNetwork ||
      settings.showSections !== previous.showSections || settings.showLanes !== previous.showLanes ||
      settings.showTurns !== previous.showTurns || settings.showNodes !== previous.showNodes
    ) {
      this.syncNetworkLayers();
    } else if (settings.seeThroughBuildings !== previous.seeThroughBuildings) {
      // The same toggle that sets the vehicles' deck.gl depth test also decides
      // whether the network lines draw over or under 3D buildings; that is a
      // pure layer-ordering change, so it needs no source/layer rebuild.
      this.syncNetworkDepthOrder();
    }
    if (settings.playing && !wasPlaying && this.data) this.play();
    else if (!settings.playing && wasPlaying) this.pause();
  }

  /**
   * Fast per-frame path: adopt a new playhead and redraw without the play/pause
   * reconciliation {@link applySettings} does.
   */
  applyTick(tick: number): void {
    this.settings = { ...this.settings, tick };
    this.render();
  }

  destroy(): void {
    this.pause();
    this.clearDeck();
    // Remove the network layers BEFORE latching `destroyed`, since the removal
    // helpers no-op once it is set.
    this.removeNetworkLayers();
    for (const [id, handler] of this.networkClickHandlers) this.map.off("click", id, handler);
    this.networkClickHandlers.clear();
    this.map.off("styledata", this.handleStyleData);
    this.destroyed = true;
  }

  /** Draw the interpolated frame at the current playhead. */
  render(): void {
    if (this.destroyed) return;
    if (!vehiclePlaybackLayerVisible) { this.clearDeck(); return; }
    const data = this.data;
    const deck = this.getDeck();
    if (!data || !deck) {
      this.clearDeck();
      return;
    }

    data.setPlayhead(this.settings.tick, this.settings.playing);
    // Streaming is async and deliberately not awaited: the frame draws from
    // whatever is resident now, and the next frames pick up the new chunk.
    if (Math.abs(this.settings.tick - this.lastCoverageTick) >= COVERAGE_CHECK_INTERVAL_TICKS) {
      this.lastCoverageTick = this.settings.tick;
      void data.ensureCoverage(this.settings.tick).catch((error: unknown) => {
        console.warn("[GeoLibre] vehicle-playback: coverage load failed", error);
      });
    }

    const samples = data.sampleAt(this.settings.tick);
    setFrameStats(samples.length, data.getLoadedFraction());
    const rows = buildVehicleRows(samples, data);

    const globalOpacity = this.settings.opacity;
    const layer = new deck.layers.PolygonLayer<VehicleRow>({
      id: `${VEHICLE_PLAYBACK_DECK_SOURCE}-vehicles`,
      // One layer for every vehicle in the frame: deck.gl uploads this as a
      // single buffer, where one layer per vehicle would not survive the
      // per-frame churn at these counts. Articulated vehicles contribute
      // several rows to this same buffer rather than a layer of their own.
      data: rows,
      getPolygon: (d: VehicleRow) => d.ring,
      getFillColor: (d: VehicleRow) => {
        const [r, g, b] = vehicleColorRgb(d.sample.typeName, d.sample.lengthM);
        return [r, g, b, Math.round(255 * d.sample.opacity * globalOpacity)];
      },
      // Static per vehicle type, so it needs no tick-keyed update trigger: the
      // `data` array itself is rebuilt every frame, which is the trigger.
      getElevation: (d: VehicleRow) => d.sample.heightM,
      getLineColor: [255, 255, 255, Math.round(140 * globalOpacity)],
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      stroked: true,
      filled: true,
      extruded: true,
      elevationScale: 1,
      // Position and color change every frame; without these deck.gl would
      // reuse the previous frame's attribute buffers.
      updateTriggers: {
        getPolygon: [this.settings.tick],
        getFillColor: [this.settings.tick, globalOpacity],
      },
      // The toggle, and the whole reason it needs to exist: `depthCompare:
      // "always"` disables the depth test, so the footprints paint over
      // whatever is already in the depth buffer — 3D buildings, Google
      // photorealistic tiles, terrain. That is what makes a vehicle visible
      // through a building. Restoring the default `"less-equal"` lets the 3D
      // scene occlude vehicles again, which is the physically correct look
      // when the user wants it. Previously this was hardcoded to "always", so
      // there was no way back.
      parameters: {
        depthCompare: this.settings.seeThroughBuildings ? "always" : "less-equal",
      },
    }) as unknown as Layer;

    setSharedDeckLayers(VEHICLE_PLAYBACK_DECK_SOURCE, [layer]);
    this.deckActive = true;
  }

  /** Remove this engine's contribution to the shared deck overlay, if any. */
  private clearDeck(): void {
    if (!this.deckActive) return;
    setSharedDeckLayers(VEHICLE_PLAYBACK_DECK_SOURCE, []);
    this.deckActive = false;
    setFrameStats(0, this.data?.getLoadedFraction() ?? 0);
  }

  play(): void {
    if (this.destroyed || this.rafId !== null || !this.data) return;
    this.lastFrame = null;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrame = null;
  }

  private tick(now: number): void {
    this.rafId = null;
    if (this.destroyed || !this.settings.playing || !this.data) return;
    if (this.lastFrame !== null) {
      // Cap the delta so a long stall (backgrounded/minimized tab pauses rAF)
      // resumes smoothly instead of jumping the playhead far ahead.
      const elapsedSec = Math.min(0.25, (now - this.lastFrame) / 1000);
      // Continuous float accumulation, not integer stepping: the fractional part
      // is exactly what the sub-tick interpolator consumes.
      const ticksPerSecond = (1 / this.data.manifest.dt) * this.settings.speed;
      advanceVehiclePlaybackTick(elapsedSec * ticksPerSecond, this.data.manifest.maxTick);
    }
    this.lastFrame = now;
    // advanceVehiclePlaybackTick may have paused playback at the end.
    if (this.settings.playing) {
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }
}

// ---------------------------------------------------------------------------
// Module store: single source of truth shared by the engine and the React panel.
// ---------------------------------------------------------------------------

let engine: VehiclePlaybackEngine | null = null;
let panelVisible = false;
let settings: VehiclePlaybackSettings = { ...DEFAULT_VEHICLE_PLAYBACK_SETTINGS };
// The loaded package lives here (not in settings): it is large and re-fetchable
// from `manifestUrl`, so a project stores only the URL.
let data: VehiclePlaybackData | null = null;
let status: VehiclePlaybackStatus = { ...IDLE_STATUS };
// Guards against a stale load resolving after the user has moved on to another
// manifest URL and overwriting the newer package.
let loadToken = 0;
// The host's deck.gl bundle, resolved lazily the first time the panel attaches.
let deckGLBundle: GeoLibreDeckGL | null = null;
let deckGLPending = false;

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

function patchStatus(next: Partial<VehiclePlaybackStatus>): void {
  status = { ...status, ...next };
  notifyStatus();
}

/**
 * Record the most recent frame's counters. Called by the engine on every render,
 * so it notifies only when a displayed value actually changed — otherwise the
 * panel would re-render 60 times a second.
 */
function setFrameStats(vehicleCount: number, loadedFraction: number): void {
  const rounded = Math.round(loadedFraction * 100) / 100;
  if (status.vehicleCount === vehicleCount && status.loadedFraction === rounded) return;
  status = { ...status, vehicleCount, loadedFraction: rounded };
  notifyStatus();
}

// Resolve the deck.gl bundle and the shared interleaved overlay once, then
// re-render so a package loaded before deck.gl was ready appears.
function ensureDeck(app: GeoLibreAppAPI): void {
  if (deckGLBundle || deckGLPending || !app.getDeckGL) return;
  deckGLPending = true;
  void app
    .getDeckGL()
    .then(async (bundle) => {
      deckGLBundle = bundle;
      await ensureSharedDeckOverlay(app);
      engine?.render();
    })
    .catch((error) => {
      console.warn("[GeoLibre] vehicle-playback: deck.gl unavailable", error);
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
    engine = new VehiclePlaybackEngine(map, settings, data, () => deckGLBundle);
  }
  ensureDeck(app);
  return true;
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
}

/** Open the vehicle-playback panel and attach the engine. Idempotent. */
export function openVehiclePlaybackPanel(app: GeoLibreAppAPI): void {
  appRef = app;
  app.registerExternalNativeLayer?.({ id: VEHICLE_PLAYBACK_STORE_LAYER_ID, name: "Vehicle Playback", type: "geojson", nativeLayerIds: [], paintMode: "plugin", metadata: { customLayerType: "deck.gl" }, paintBridge: { setVisibility: (visible) => { vehiclePlaybackLayerVisible = visible; engine?.render(); } } });
  registerDuckDbLayer({
    pluginId: "vehicle-playback",
    dispose: () => {
      detachEngine();
      data?.destroy();
      data = null;
      pendingManifest = null;
    },
  });
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  attachEngine(app);
}

/**
 * Close the panel, stop playback, and clear the vehicles from the map.
 *
 * Also tears down the loaded package and invalidates any load in flight: the
 * panel is the only thing driving `data`, so once it is gone nothing should
 * keep streaming/decoding chunks in the background for a UI the user closed.
 */
export function closeVehiclePlaybackPanel(_app?: GeoLibreAppAPI): void {
  releaseDuckDbLayer("vehicle-playback");
  appRef?.unregisterExternalNativeLayer?.(VEHICLE_PLAYBACK_STORE_LAYER_ID);
  if (settings.playing) {
    settings = { ...settings, playing: false };
  }
  detachEngine();
  loadToken += 1;
  data?.destroy();
  data = null;
  // The retained manifest belongs to the package being torn down; keeping it
  // would let a later scenario switch resurrect a closed package.
  pendingManifest = null;
  status = { ...IDLE_STATUS };
  notifyStatus();
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
    notifyState();
  }
}

export function isVehiclePlaybackPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeVehiclePlaybackPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/** Current settings (a copy callers may freely read). */
export function getVehiclePlaybackSettings(): VehiclePlaybackSettings {
  return { ...settings };
}

/**
 * Stable settings reference for `useSyncExternalStore`. `settings` is replaced
 * immutably on every change, so the identity is constant between changes.
 */
export function getVehiclePlaybackSnapshot(): VehiclePlaybackSettings {
  return settings;
}

export function subscribeVehiclePlayback(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Stable load/progress snapshot for `useSyncExternalStore`. */
export function getVehiclePlaybackStatus(): VehiclePlaybackStatus {
  return status;
}

export function subscribeVehiclePlaybackStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Apply a partial settings change: normalize, push to the engine, and notify
 * subscribers. Returns true when something actually changed.
 */
export function setVehiclePlaybackSettings(next: Partial<VehiclePlaybackSettings>): boolean {
  const normalized = normalizeVehiclePlaybackSettings(
    { ...settings, ...next },
    DEFAULT_VEHICLE_PLAYBACK_SETTINGS,
  );
  if (settingsEqual(normalized, settings)) return false;
  settings = normalized;
  engine?.applySettings(settings);
  notifyState();
  return true;
}

/** Convenience toggle for the play/pause button. */
export function toggleVehiclePlaybackPlaying(): void {
  // Pressing Play at the end of a non-looping package restarts from the top,
  // otherwise playback would immediately re-stop and appear to do nothing.
  const atEnd = status.maxTick > 0 && settings.tick >= status.maxTick;
  setVehiclePlaybackSettings({
    playing: !settings.playing,
    tick: !settings.playing && atEnd ? 0 : settings.tick,
  });
}

/**
 * Scrub to an absolute tick (used by the panel timeline). Uses the engine's
 * lightweight `applyTick` path rather than the full `applySettings`
 * reconciliation, so dragging only redraws the vehicles.
 */
export function setVehiclePlaybackTick(tick: number): void {
  const clamped = Math.max(0, Math.min(status.maxTick, tick));
  if (!Number.isFinite(clamped) || clamped === settings.tick) return;
  settings = { ...settings, tick: clamped };
  engine?.applyTick(clamped);
  notifyState();
}

/**
 * Advance the playhead by `deltaTicks`, honoring the loop setting. Called by the
 * engine's animation loop each frame; stops at the end when not looping.
 *
 * @param deltaTicks - Ticks to advance (fractional)
 * @param maxTick - Last addressable tick of the loaded package
 */
export function advanceVehiclePlaybackTick(deltaTicks: number, maxTick: number): void {
  let next = settings.tick + deltaTicks;
  if (next >= maxTick) {
    if (settings.loop) {
      next = maxTick > 0 ? next % maxTick : 0;
    } else {
      settings = { ...settings, tick: maxTick, playing: false };
      engine?.applySettings(settings);
      notifyState();
      return;
    }
  }
  settings = { ...settings, tick: next };
  engine?.applyTick(next);
  notifyState();
}

/**
 * Point the plugin at a VWE package and load it.
 *
 * Fetches and parses only the manifest; the chunks stream in around the playhead
 * as playback proceeds, with a background pass filling in the rest. Passing an
 * empty URL clears the current package. Resolves once the manifest has been
 * parsed (or the load has failed, which is reported through the status store
 * rather than thrown, since the panel is the only caller).
 *
 * @param url - URL of the package's `manifest.json`
 */
export async function setVehiclePlaybackManifestUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  const token = (loadToken += 1);

  data?.destroy();
  data = null;
  engine?.setData(null);

  if (!trimmed) {
    settings = { ...settings, manifestUrl: null, playing: false, tick: 0 };
    status = { ...IDLE_STATUS };
    notifyState();
    notifyStatus();
    return;
  }

  settings = { ...settings, manifestUrl: trimmed, playing: false, tick: 0 };
  notifyState();
  patchStatus({ loading: true, error: null, vehicleCount: 0, loadedFraction: 0 });

  try {
    const raw = await fetchVehicleManifestJson(trimmed);
    if (token !== loadToken) return;
    const scenarios = listVehicleManifestScenarios(raw);
    // Remember the manifest so a scenario switch needs no second fetch.
    pendingManifest = { raw, scenarios, url: trimmed, directory: null };
    // Single-scenario packages auto-select, which is byte-for-byte the old
    // behavior; only a genuinely multi-scenario manifest waits for a choice.
    await adoptScenario(0, token);
  } catch (error) {
    if (token !== loadToken) return;
    patchStatus({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
      maxTick: 0,
      dt: 1,
      scenarios: [],
    });
  }
}

/**
 * The manifest behind the currently loaded package, retained so switching
 * scenarios re-parses it instead of re-fetching.
 */
let pendingManifest: {
  raw: unknown;
  scenarios: VehicleManifestScenario[];
  url: string | null;
  directory: VehicleDirectoryHandle | null;
} | null = null;

/**
 * Build the data layer for one scenario of the retained manifest, stream its
 * first chunk, and load its network geometry.
 *
 * @param scenarioIndex - Which scenario to play
 * @param token - The load token this work belongs to; a newer load abandons it
 */
async function adoptScenario(scenarioIndex: number, token: number): Promise<void> {
  const pending = pendingManifest;
  if (!pending) return;

  data?.destroy();
  data = null;
  engine?.setData(null);

  const capability = capabilityAvailable(pending.raw, "animation");
  if (!capability.available) throw new Error(capability.reason ?? "Animation is unavailable.");
  const source: VehiclePackageSource = pending.directory
    ? createDirectoryPackageSource(pending.directory)
    : createHttpPackageSource(pending.url ?? "");
  const animationManifest = await loadScenarioAnimationManifest(pending.raw, source, scenarioIndex);
  const loaded = pending.directory
    ? new VehiclePlaybackData(parseVehicleManifest(pending.raw, null, scenarioIndex, animationManifest), source)
    : new VehiclePlaybackData(parseVehicleManifest(pending.raw, pending.url, scenarioIndex, animationManifest), source);

  if (token !== loadToken) {
    loaded.destroy();
    return;
  }

  data = loaded;
  patchStatus({
    loading: false,
    error: null,
    maxTick: loaded.manifest.maxTick,
    dt: loaded.manifest.dt,
    scenarios: pending.scenarios,
    scenarioIndex: loaded.manifest.scenarioIndex,
    hasSections: Boolean(loaded.manifest.geometry.sections),
    hasLanes: Boolean(loaded.manifest.geometry.lanes),
    hasTurns: Boolean(loaded.manifest.geometry.turns),
    localFolderName: pending.directory?.name ?? null,
  });
  engine?.setData(loaded);

  // Network geometry is a backdrop: never let it block or fail playback.
  void loadVehicleGeometry(loaded.source, loaded.manifest.geometry)
    .then((geometry: VehicleGeometryLayers) => {
      if (token !== loadToken) return;
      engine?.setGeometry(geometry);
    })
    .catch((error: unknown) => {
      console.warn("[GeoLibre] vehicle-playback: network geometry failed", error);
    });

  // Cover the start before the first frame, then fill in the rest lazily.
  await loaded.ensureCoverage(0);
  if (token !== loadToken) return;
  engine?.render();
  loaded.startBackgroundLoad();
  // Frame the package so the vehicles are not off-screen on first play.
  if (loaded.manifest.bounds) fitVehiclePlaybackBounds(loaded.manifest.bounds);
}

/**
 * Switch the loaded package to another of its manifest's scenarios.
 *
 * No-ops for a single-scenario package or an out-of-range index, so the panel
 * can call it unconditionally.
 *
 * @param scenarioIndex - Index into the status store's `scenarios`
 */
export async function setVehiclePlaybackScenario(scenarioIndex: number): Promise<void> {
  const pending = pendingManifest;
  if (!pending || scenarioIndex === status.scenarioIndex) return;
  if (scenarioIndex < 0 || scenarioIndex >= pending.scenarios.length) return;

  const token = (loadToken += 1);
  settings = { ...settings, playing: false, tick: 0 };
  notifyState();
  patchStatus({ loading: true, error: null, vehicleCount: 0, loadedFraction: 0 });
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

/** Whether this browser can open a local package folder (Chromium only). */
export function canLoadLocalVehiclePackage(): boolean {
  return supportsLocalPackageFolders();
}

/**
 * Prompt for a VWE package folder and load it from disk.
 *
 * Reads `manifest.json`, then streams `chunks/*` and `geometry/*` through the
 * directory handle instead of the network, so a package never has to be served
 * over HTTP to be played. A cancelled picker resolves quietly.
 */
export async function loadLocalVehiclePlaybackFolder(): Promise<void> {
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
  data?.destroy();
  data = null;
  engine?.setData(null);
  // A local package has no URL; clear the persisted one so a project reload
  // does not try to re-fetch a manifest that never came from the network.
  settings = { ...settings, manifestUrl: null, playing: false, tick: 0 };
  notifyState();
  patchStatus({ loading: true, error: null, vehicleCount: 0, loadedFraction: 0 });

  try {
    const raw = await readLocalVehicleManifestJson(directory);
    if (token !== loadToken) return;
    // Validate the handle up front so a wrong folder fails here, clearly.
    createDirectoryPackageSource(directory);
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
      maxTick: 0,
      dt: 1,
      scenarios: [],
    });
  }
}

// The app API is captured on attach so a load triggered from the panel (which
// has no app handle of its own) can still frame the package.
let appRef: GeoLibreAppAPI | null = null;
let vehiclePlaybackLayerVisible = true;

function fitVehiclePlaybackBounds(bounds: [number, number, number, number]): void {
  appRef?.fitBounds?.(bounds);
}

/**
 * Apply a saved project's vehicle-playback state: adopt its settings, reload the
 * package from the persisted manifest URL, and open or close the panel to match
 * the persisted `open` flag. Playback never auto-starts on load. Mirrors the sun
 * and route-animation restore paths; the only place allowed to change
 * open/closed state from stored data.
 *
 * @param app - The host application API
 * @param state - The persisted plugin state, if any
 * @returns Whether anything changed
 */
export function restoreVehiclePlayback(app: GeoLibreAppAPI, state?: unknown): boolean {
  appRef = app;
  const next = normalizeVehiclePlaybackSettings(state, {
    ...DEFAULT_VEHICLE_PLAYBACK_SETTINGS,
  });
  next.playing = false;

  // Drop the previous project's package so nothing draws stale vehicles while
  // the new one loads. This always destroys any currently-loaded package, so
  // the re-fetch below must not be gated on whether the URL text changed from
  // the (now-overwritten) `settings.manifestUrl` — that comparison is always
  // false on a normal same-URL reload, which would leave the panel pointing at
  // the right URL with no data ever re-fetched.
  data?.destroy();
  data = null;
  engine?.setData(null);
  status = { ...IDLE_STATUS };
  notifyStatus();

  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  let changed = false;
  if (!settingsEqual(next, settings)) {
    settings = next;
    notifyState();
    changed = true;
  }
  engine?.applySettings(settings);

  const wasVisible = panelVisible;
  if (shouldOpen) openVehiclePlaybackPanel(app);
  else closeVehiclePlaybackPanel(app);

  // Re-fetch after the panel state settles, so the engine exists to receive it.
  if (next.manifestUrl) {
    void setVehiclePlaybackManifestUrl(next.manifestUrl);
  }
  return changed || panelVisible !== wasVisible;
}

/**
 * Re-bind the engine to the current map without touching open/closed state.
 * Called after a map re-init or basemap change; must never reset the panel.
 */
export function reattachVehiclePlayback(app: GeoLibreAppAPI): void {
  appRef = app;
  if (panelVisible) attachEngine(app);
  else detachEngine();
}

export const maplibreVehiclePlaybackPlugin: GeoLibrePlugin = {
  id: VEHICLE_PLAYBACK_PLUGIN_ID,
  name: "Vehicle Playback",
  version: "1.0.0",
  activeByDefault: false,
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    openVehiclePlaybackPanel(app);
  },
  deactivate: (app: GeoLibreAppAPI) => closeVehiclePlaybackPanel(app),
  // Persist the panel-open flag plus settings (including the manifest URL, so a
  // saved project reopens on the same package) but never the chunk data itself.
  // Nothing is stored while closed and at defaults. `playing` is never persisted
  // as true — playback is an explicit user action on load.
  getProjectState: () => {
    if (!panelVisible && isDefaultSettings(settings)) return undefined;
    return { open: panelVisible, ...settings, playing: false };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => restoreVehiclePlayback(app, state),
};
