/**
 * KPI color ramps and elevation math for the network-kpi plugin.
 *
 * Ported verbatim from Testudo's viewer — `viewer/theme/ramp-settings.js`
 * (`DEFAULT_DEFINITIONS`) for the ramps, and `viewer/env/env-utils.js`
 * (`KPI_RANGES` / `elevationByKPI` / `LOD_ZOOM_THRESHOLD`) for the extrusion and
 * level-of-detail constants — so a GeoLibre results view and a Testudo results
 * view of the same package read identically instead of using two different
 * palettes for the same numbers.
 *
 * The stop VALUES are metric units (veh/h, veh/km, km/h) and the ramps are
 * CONTINUOUS: Testudo interpolates linearly in RGB between adjacent stops.
 * GeoLibre's own `vectorStyleMode: "graduated"` only emits discrete `step`
 * expressions (see `packages/core/src/vector-color.ts`), which would band a
 * smooth ramp into five flat classes, so this module does the interpolation
 * itself — see {@link kpiColorRgb}.
 *
 * Kept as plain data with no Qt/deck/MapLibre imports so it is trivially
 * unit-testable and trivial to re-sync if Testudo's ramps change. A Python port
 * of these same literals lives in the aimsun-psp repo
 * (`shared/rendering/testudo_ramps.py`); the three copies must stay in step.
 */

/**
 * The result metrics this plugin can render.
 *
 * Every member must be backed by a real column the results query reads out of
 * `MISECT`/`MILANE` (see `KpiRow` in `network-kpi-data.ts`). `delay` maps to
 * Aimsun's `dtime` (delay time, in seconds), which both tables carry.
 *
 * A package manifest's `default_ramps` block advertises many more metrics than
 * this — `co2`, `nox`, `noise`, `vehicle_speed`, `vehicle_accel`, and the
 * `path_*` / `cmp_*` families. Those are deliberately NOT members: the
 * section/lane results tables have no column for them, so offering one could
 * only ever paint an empty network. {@link manifestRampMetrics} keeps that
 * distinction explicit — "the package defines a ramp" is not the same claim as
 * "this plugin can render that metric".
 */
export type NetworkKpiMetric = "flow" | "density" | "speed" | "delay";

export const NETWORK_KPI_METRICS: readonly NetworkKpiMetric[] = [
  "flow",
  "density",
  "speed",
  "delay",
] as const;

/** Whether an arbitrary value names a metric this plugin can render. */
export function isNetworkKpiMetric(value: unknown): value is NetworkKpiMetric {
  return (
    typeof value === "string" && (NETWORK_KPI_METRICS as readonly string[]).includes(value)
  );
}

/** One continuous ramp: five stops in metric units, five colors low → high. */
export interface KpiRamp {
  /** Stop values in the metric's own unit, strictly ascending. */
  readonly stops: readonly number[];
  /** Hex colors paired positionally with {@link stops}. */
  readonly colors: readonly string[];
  /** Unit suffix for the legend, e.g. `veh/h`. */
  readonly unit: string;
  /** Human label for the metric picker and legend heading. */
  readonly label: string;
}

export type KpiRampOverrides = Partial<Record<NetworkKpiMetric, KpiRamp>>;

/**
 * Testudo's five-stop ramps, literal from `ramp-settings.js`.
 *
 * Note that `speed`'s colors run in the OPPOSITE severity direction to the other
 * two: for flow and density a high number is congestion (red), whereas a high
 * speed is free flow (green). The stops themselves ascend in all three.
 */
export const KPI_RAMPS: Readonly<Record<NetworkKpiMetric, KpiRamp>> = {
  flow: {
    stops: [0, 500, 1000, 1500, 2000],
    colors: ["#2878c8", "#28b478", "#c8dc3c", "#ff8c00", "#d73027"],
    unit: "veh/h",
    label: "Flow",
  },
  density: {
    stops: [0, 37, 75, 112, 150],
    colors: ["#32a032", "#78c83c", "#c8dc3c", "#ff8c00", "#d73027"],
    unit: "veh/km",
    label: "Density",
  },
  speed: {
    stops: [0, 30, 60, 90, 120],
    colors: ["#d73027", "#ff8c00", "#c8dc3c", "#78c83c", "#32a032"],
    unit: "km/h",
    label: "Speed",
  },
  delay: {
    stops: [0, 30, 60, 120, 240],
    colors: ["#2878c8", "#46aad2", "#d2dc46", "#ff8c00", "#d73027"],
    unit: "s",
    label: "Delay",
  },
};

/**
 * Value range each metric's extrusion height is normalized against, literal
 * from `env-utils.js`'s `KPI_RANGES`.
 *
 * These happen to coincide with the first and last ramp stop for all three
 * metrics today, but they are a SEPARATE constant in Testudo (elevation is not
 * required to share the color ramp's domain), so they are kept separate here
 * too rather than derived from {@link KPI_RAMPS}.
 */
export const KPI_RANGES: Readonly<Record<NetworkKpiMetric, { min: number; max: number }>> = {
  flow: { min: 0, max: 2000 },
  density: { min: 0, max: 150 },
  speed: { min: 0, max: 120 },
  delay: { min: 0, max: 240 },
};

/**
 * Zoom at which the renderer switches from section-level to lane-level KPI,
 * literal from `env-utils.js`'s `LOD_ZOOM_THRESHOLD`.
 *
 * Below it, one value per section is drawn (coarse, far fewer features); at or
 * above it, one value per lane. Exposed as the DEFAULT of a user setting rather
 * than hardcoded, because the right threshold depends on how dense a given
 * network's lanes are.
 */
export const LOD_ZOOM_THRESHOLD = 17;

/** Bounds of the user-tunable 3D extrusion height, from Testudo's own clamp. */
export const MAX_HEIGHT_MIN_M = 1;
export const MAX_HEIGHT_MAX_M = 200;
/** Default max extrusion height when the user has not chosen one. */
export const DEFAULT_MAX_HEIGHT_M = 10;

/**
 * Floor of the extruded height, in meters.
 *
 * Testudo's `elevationByKPI` returns `0.1 + ratio * (maxHeight - 0.1)`, so even
 * a just-above-zero value produces a sliver with nonzero height. Without it a
 * low-KPI polygon would collapse to a zero-height shell that deck.gl renders as
 * nothing at all, making "almost no flow" indistinguishable from "no data".
 */
const ELEVATION_FLOOR_M = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Parse `#rrggbb` (or `#rgb`) into an RGB triple. Throws on anything else. */
function parseHexColor(hex: string): [number, number, number] {
  const text = hex.trim().replace(/^#/, "");
  const full =
    text.length === 3
      ? text
          .split("")
          .map((c) => c + c)
          .join("")
      : text;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex color: ${hex}`);
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

// ---------------------------------------------------------------------------
// Manifest-supplied ramps.
//
// A package manifest carries a `default_ramps` block written at generation
// time. Those definitions are PACKAGE-SPECIFIC GROUND TRUTH — a network whose
// flows top out at 400 veh/h is exported with a ramp scaled to it, and painting
// it with the generic 0..2000 ramp above would render the whole map one flat
// blue. So a manifest ramp WINS over the hardcoded default for the metric it
// names, and the hardcoded ramp is the fallback for metrics the manifest is
// silent about.
//
// The override is a process-wide registry rather than a parameter threaded
// through every call, because `kpiColorRgb` / `elevationByKpi` are called
// per-feature per-frame from a deck.gl accessor and the panel and legend index
// `KPI_RAMPS` directly. Only one package is loaded at a time, so a single
// active set is sufficient and keeps every existing call site unchanged.
// ---------------------------------------------------------------------------

/** Ramps installed from the active package's manifest, by metric. */
let manifestRamps: Partial<Record<NetworkKpiMetric, KpiRamp>> = {};

/** Metric names the manifest defined a ramp for, including unrenderable ones. */
let manifestMetricNames: string[] = [];

/**
 * Parse one `defaultStops` entry.
 *
 * Handles the three `stopKind`s real manifests use: plain numbers, `percent`
 * strings like `"75%"`, and `signed` values that may be negative.
 */
function parseStop(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/%$/, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Convert one raw `default_ramps` entry into a {@link KpiRamp}.
 *
 * Returns null for anything this module cannot color with: a categorical ramp
 * (no numeric stops to interpolate between) or a definition whose stops are
 * missing, unparseable, or not strictly ascending. Being strict here means a
 * malformed manifest silently keeps the known-good hardcoded ramp instead of
 * producing a ramp that divides by zero or inverts.
 */
function parseManifestRamp(raw: unknown, fallback: KpiRamp): KpiRamp | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  // Only continuous ramps can be interpolated; categorical ones carry no stops.
  if (entry.kind !== undefined && entry.kind !== "continuous") return null;

  const rawStops = Array.isArray(entry.defaultStops) ? entry.defaultStops : null;
  const rawColors = Array.isArray(entry.defaultColors) ? entry.defaultColors : null;
  if (!rawStops || !rawColors || rawStops.length < 2) return null;

  const stops: number[] = [];
  for (const value of rawStops) {
    const parsed = parseStop(value);
    if (parsed === null) return null;
    stops.push(parsed);
  }
  // A non-ascending ramp would make the bracket search in kpiColorRgb
  // meaningless, so reject rather than silently mis-color.
  for (let i = 1; i < stops.length; i += 1) {
    if (!(stops[i] > stops[i - 1])) return null;
  }

  const colors: string[] = [];
  for (const value of rawColors) {
    if (typeof value !== "string") return null;
    try {
      parseHexColor(value);
    } catch {
      return null;
    }
    colors.push(value);
  }

  // Real manifests ship at least one ramp (`noise`) with more colors than
  // stops, so pair them positionally and drop the unpaired tail rather than
  // rejecting an otherwise usable definition.
  const paired = Math.min(stops.length, colors.length);
  if (paired < 2) return null;

  const unit = typeof entry.unit === "string" && entry.unit ? entry.unit : fallback.unit;
  const label = typeof entry.label === "string" && entry.label ? entry.label : fallback.label;
  return {
    stops: stops.slice(0, paired),
    colors: colors.slice(0, paired),
    unit,
    label,
  };
}

/**
 * Install the ramps a package manifest declares, replacing any previous set.
 *
 * Call with the whole parsed manifest on every package load — including a load
 * of a manifest that has no `default_ramps`, which correctly clears a previous
 * package's overrides back to the hardcoded defaults.
 *
 * @param rawManifest - The parsed manifest JSON, or null to clear
 * @returns The metrics that were actually overridden
 */
export function applyManifestRamps(rawManifest: unknown): NetworkKpiMetric[] {
  manifestRamps = {};
  manifestMetricNames = [];

  const root = (rawManifest ?? {}) as Record<string, unknown>;
  const block = root.default_ramps;
  if (!block || typeof block !== "object") {
    refreshRampRgb();
    return [];
  }

  const entries = block as Record<string, unknown>;
  manifestMetricNames = Object.keys(entries);

  const applied: NetworkKpiMetric[] = [];
  for (const metric of NETWORK_KPI_METRICS) {
    const parsed = parseManifestRamp(entries[metric], KPI_RAMPS[metric]);
    if (!parsed) continue;
    manifestRamps[metric] = parsed;
    applied.push(metric);
  }
  refreshRampRgb();
  return applied;
}

/**
 * Every metric the active manifest defined a ramp for, paired with whether this
 * plugin can actually render it.
 *
 * Exposed so a data-driven metric selector can show what the package offers
 * without this module pretending the results database has columns it does not.
 * `renderable: false` entries are advertised by the manifest but have no
 * MISECT/MILANE column behind them (`co2`, `path_od`, and so on).
 */
export function manifestRampMetrics(): { metric: string; renderable: boolean }[] {
  return manifestMetricNames.map((metric) => ({
    metric,
    renderable: isNetworkKpiMetric(metric) && metric in manifestRamps,
  }));
}

/**
 * The ramp in force for a metric: the manifest's when it supplied a usable one,
 * else the hardcoded Testudo default.
 */
export function activeRamp(metric: NetworkKpiMetric): KpiRamp {
  return manifestRamps[metric] ?? KPI_RAMPS[metric];
}

/** Ramp colors pre-parsed to RGB, so the per-feature accessor does no parsing. */
let RAMP_RGB: Record<NetworkKpiMetric, [number, number, number][]> = {
  flow: [],
  density: [],
  speed: [],
  delay: [],
};

/** Re-derive the cached RGB triples from whichever ramps are in force. */
function refreshRampRgb(): void {
  RAMP_RGB = {
    flow: activeRamp("flow").colors.map(parseHexColor),
    density: activeRamp("density").colors.map(parseHexColor),
    speed: activeRamp("speed").colors.map(parseHexColor),
    delay: activeRamp("delay").colors.map(parseHexColor),
  };
}

refreshRampRgb();

/**
 * Color for a KPI value, by linear RGB interpolation between the two ramp stops
 * bracketing it.
 *
 * This is the continuous-ramp reproduction referred to in the module docstring:
 * deck.gl accessors take a color triple, not a MapLibre expression, so the
 * interpolation Testudo does inside its style expression is done here in JS
 * instead. Values below the first stop clamp to the first color and values above
 * the last clamp to the last, matching MapLibre `interpolate` semantics.
 *
 * @param value - The KPI value in the metric's own unit
 * @param metric - Which ramp to sample
 * @returns An `[r, g, b]` triple in `0..255`
 */
export function kpiColorRgb(value: number, metric: NetworkKpiMetric, overrides?: KpiRampOverrides): [number, number, number] {
  const ramp = overrides?.[metric] ?? KPI_RAMPS[metric];
  const colors = ramp === KPI_RAMPS[metric] ? RAMP_RGB[metric] : ramp.colors.map(parseHexColor);
  const stops = ramp.stops;
  if (!Number.isFinite(value) || value <= stops[0]) return colors[0];
  if (value >= stops[stops.length - 1]) return colors[colors.length - 1];

  for (let i = 1; i < stops.length; i += 1) {
    if (value > stops[i]) continue;
    const lo = stops[i - 1];
    const hi = stops[i];
    // Guard a degenerate (zero-width) span so a hand-edited ramp cannot divide
    // by zero; identical adjacent stops just snap to the lower color.
    const t = hi > lo ? (value - lo) / (hi - lo) : 0;
    const a = colors[i - 1];
    const b = colors[i];
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  return colors[colors.length - 1];
}

/**
 * Extrusion height in meters for a KPI value, ported from `env-utils.js`'s
 * `elevationByKPI`.
 *
 * A non-positive (or missing) value returns a flat 0, which is what keeps
 * "no data" sections lying flat on the ground instead of standing up at the
 * floor height. Anything positive is normalized against the metric's
 * {@link KPI_RANGES} span and mapped onto
 * `[ELEVATION_FLOOR_M, maxHeightMeters]`.
 *
 * @param value - The KPI value, or null/undefined when the section has no result
 * @param metric - Which range to normalize against
 * @param maxHeightMeters - User-chosen ceiling, clamped to `[1, 200]`
 * @returns Height in meters
 */
export function elevationByKpi(
  value: number | null | undefined,
  metric: NetworkKpiMetric,
  maxHeightMeters?: number | null,
): number {
  const rawValue = value ?? 0;
  if (!(rawValue > 0)) return 0;
  const range = KPI_RANGES[metric];
  const clamped = clamp(rawValue, range.min, range.max);
  const ratio = (clamped - range.min) / (range.max - range.min);
  const maxHeight = clamp(maxHeightMeters ?? DEFAULT_MAX_HEIGHT_M, MAX_HEIGHT_MIN_M, MAX_HEIGHT_MAX_M);
  return ELEVATION_FLOOR_M + ratio * (maxHeight - ELEVATION_FLOOR_M);
}

/** Legend rows for a metric: the five stops with their colors and units. */
export function kpiLegendStops(
  metric: NetworkKpiMetric,
  overrides?: KpiRampOverrides,
): { value: number; color: string; label: string }[] {
  const ramp = overrides?.[metric] ?? KPI_RAMPS[metric];
  return ramp.stops.map((value, index) => ({
    value,
    color: ramp.colors[index],
    label: `${value} ${ramp.unit}`,
  }));
}

/**
 * Build a MapLibre `["interpolate", ["linear"], ...]` paint expression for a
 * metric.
 *
 * Not used by the deck.gl render path (which calls {@link kpiColorRgb} per
 * feature instead), but kept as the canonical expression form so the same ramp
 * can drive a plain MapLibre GeoJSON layer — for example if a future 2D-only
 * fallback renders without deck.gl.
 *
 * @param property - The feature property holding the KPI value
 * @param metric - Which ramp to build
 */
export function kpiInterpolateExpression(property: string, metric: NetworkKpiMetric): unknown[] {
  const ramp = KPI_RAMPS[metric];
  const expression: unknown[] = ["interpolate", ["linear"], ["to-number", ["get", property], 0]];
  for (let i = 0; i < ramp.stops.length; i += 1) {
    expression.push(ramp.stops[i], ramp.colors[i]);
  }
  return expression;
}
