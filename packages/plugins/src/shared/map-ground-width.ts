import { mercatorMetersPerPixelAtZoom0 } from "@geolibre/core";

const MAX_MERCATOR_ZOOM = 24;
export const FALLBACK_LANE_WIDTH_M = 3;
const FALLBACK_SECTION_WIDTH_M = FALLBACK_LANE_WIDTH_M;

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

