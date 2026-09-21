import {
  featureLaneIndex,
  featureSectionId,
  kpiValue,
  laneKey,
  type KpiRow,
  type NetworkFeature,
  type NetworkFeatureCollection,
  type NetworkKpiResults,
} from "./network-kpi-data";
import { type NetworkKpiMetric } from "./network-kpi-ramps";

/**
 * Turns the network's LINE geometry plus a KPI table into the POLYGON rows the
 * deck.gl layer draws.
 *
 * The sections/lanes GeoJSON a package ships is centerlines, but a KPI view
 * needs area: a flat choropleth reads better as a road-width ribbon than as a
 * hairline, and a 3D extrusion needs a footprint to extrude at all. So each
 * centerline is buffered to its own real width — `total_width` on a section,
 * `width` on a lane, both written by Testudo's exporter — producing one closed
 * ring per feature.
 *
 * The buffering is a simple per-segment offset in local meters converted back to
 * degrees at the feature's own latitude. It is deliberately NOT a full geometric
 * buffer with mitered joins: at road widths and city zooms the difference is
 * sub-pixel, and a robust mitering implementation would be far more code than
 * this view justifies. Self-intersection at a very sharp vertex is possible and
 * harmless — deck.gl tessellates it into a slightly fatter corner.
 */

/** Meters per degree of latitude; constant enough for road-width buffering. */
const METERS_PER_DEGREE_LAT = 111320;

/** Fallback width when a feature carries no usable width data (meters). */
const FALLBACK_LANE_WIDTH_M = 3;

/** One polygon row handed to the deck.gl layer. */
export interface KpiPolygonRow {
  /** Closed ground ring in `[lon, lat]`. */
  ring: [number, number][];
  /** The KPI value for the active metric, or null when there is no result. */
  value: number | null;
  /** Section id, for tooltips and debugging. */
  sectionId: number;
  /** Lane index for a lane row, or null for a section row. */
  laneIndex: number | null;
}

/**
 * A geometry-only polygon row: the ribbon a feature buffers to, with no KPI
 * value baked in. Built once per (geometry, metric-independent) load and
 * reused across interval ticks — {@link buildSectionRows}/{@link buildLaneRows}
 * fuse a `value` onto a row like this, but a value swap alone (an interval
 * tick) needs none of the buffering work this row required to produce.
 */
export interface KpiGeometryRow {
  /** Closed ground ring in `[lon, lat]`. */
  ring: [number, number][];
  /** Section id — the join key into a {@link NetworkKpiResults} snapshot. */
  sectionId: number;
  /** Lane index for a lane row, or null for a section row — joins via {@link laneKey}. */
  laneIndex: number | null;
  /** Stable key identifying this row, for deck.gl `getFillColor`/`getElevation` lookups. */
  key: string;
}

/** Longitude degrees per meter at a given latitude. */
function lonDegreesPerMeter(latitude: number): number {
  const cos = Math.cos((latitude * Math.PI) / 180);
  // Guard the poles so a degenerate cos cannot produce an infinite offset.
  return 1 / (METERS_PER_DEGREE_LAT * Math.max(0.01, Math.abs(cos)));
}

/** Latitude degrees per meter (independent of position, to this accuracy). */
function latDegreesPerMeter(): number {
  return 1 / METERS_PER_DEGREE_LAT;
}

/**
 * Every `[lon, lat]` position of a LineString or MultiLineString feature.
 *
 * A MultiLineString is flattened to its LONGEST part rather than concatenated:
 * joining disjoint parts end-to-end would draw a spurious ribbon across the gap
 * between them.
 */
function featureLine(feature: NetworkFeature): [number, number][] | null {
  const geometry = feature.geometry;
  if (!geometry) return null;
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;

  if (geometry.type === "LineString") {
    return normalizePositions(coordinates as unknown[]);
  }
  if (geometry.type === "MultiLineString") {
    let best: [number, number][] | null = null;
    for (const part of coordinates as unknown[]) {
      if (!Array.isArray(part)) continue;
      const line = normalizePositions(part as unknown[]);
      if (line && (!best || line.length > best.length)) best = line;
    }
    return best;
  }
  return null;
}

/** Coerce raw GeoJSON positions to finite `[lon, lat]` pairs. */
function normalizePositions(raw: unknown[]): [number, number][] | null {
  const out: [number, number][] = [];
  for (const position of raw) {
    if (!Array.isArray(position) || position.length < 2) continue;
    const lon = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    // Drop a repeated vertex: a zero-length segment has no direction to offset
    // perpendicular to, and would inject a NaN normal into the ribbon.
    const last = out[out.length - 1];
    if (last && last[0] === lon && last[1] === lat) continue;
    out.push([lon, lat]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Buffer a centerline into a closed ring of the given ground width.
 *
 * Walks the line offsetting each vertex by half the width along the local
 * perpendicular (averaging the two adjacent segment normals at interior
 * vertices so the ribbon does not kink), then returns the left side followed by
 * the right side reversed — a single closed ring deck.gl can fill or extrude.
 *
 * @param line - The centerline positions
 * @param widthM - Full ribbon width in meters
 * @returns A closed `[lon, lat]` ring, or null when the line is degenerate
 */
export function bufferLineToRing(
  line: [number, number][],
  widthM: number,
): [number, number][] | null {
  if (line.length < 2) return null;
  const half = Math.max(0.1, widthM) / 2;
  // Use the midpoint latitude for the whole feature: a road section is short
  // enough that the longitude scale does not meaningfully change along it.
  const midLat = line[Math.floor(line.length / 2)][1];
  const lonPerM = lonDegreesPerMeter(midLat);
  const latPerM = latDegreesPerMeter();

  /** Unit normal (left of travel) of the segment from `a` to `b`, in meters. */
  const normalAt = (a: [number, number], b: [number, number]): [number, number] | null => {
    // Convert the segment to local meters before taking the perpendicular, so
    // the offset is a true ground distance rather than a degree distance that
    // would be latitude-skewed.
    const dx = (b[0] - a[0]) / lonPerM;
    const dy = (b[1] - a[1]) / latPerM;
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) return null;
    return [-dy / length, dx / length];
  };

  const normals: ([number, number] | null)[] = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    normals.push(normalAt(line[i], line[i + 1]));
  }

  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < line.length; i += 1) {
    // Interior vertices average the incoming and outgoing normals so the two
    // adjacent ribbon segments meet instead of overlapping or gapping.
    const before = i > 0 ? normals[i - 1] : null;
    const after = i < normals.length ? normals[i] : null;
    let nx = 0;
    let ny = 0;
    let count = 0;
    for (const normal of [before, after]) {
      if (!normal) continue;
      nx += normal[0];
      ny += normal[1];
      count += 1;
    }
    if (count === 0) continue;
    const length = Math.hypot(nx, ny);
    if (!(length > 0)) continue;
    nx /= length;
    ny /= length;

    const point = line[i];
    left.push([point[0] + nx * half * lonPerM, point[1] + ny * half * latPerM]);
    right.push([point[0] - nx * half * lonPerM, point[1] - ny * half * latPerM]);
  }

  if (left.length < 2) return null;
  const ring = [...left, ...right.reverse()];
  // Close the ring explicitly; deck.gl accepts either form but an explicit
  // closure keeps the data valid if it is ever exported as GeoJSON.
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** Ground width of a section feature, from the exporter's real width data. */
function sectionWidthM(feature: NetworkFeature): number {
  const props = feature.properties ?? {};
  const total = Number(props.total_width);
  if (Number.isFinite(total) && total > 0) return total;
  const lanes = Number(props.num_lanes);
  if (Number.isFinite(lanes) && lanes > 0) return lanes * FALLBACK_LANE_WIDTH_M;
  return FALLBACK_LANE_WIDTH_M;
}

/** Ground width of a single lane feature. */
function laneWidthM(feature: NetworkFeature): number {
  const width = Number((feature.properties ?? {}).width);
  return Number.isFinite(width) && width > 0 ? width : FALLBACK_LANE_WIDTH_M;
}

/**
 * Build the section-level polygon rows for a metric.
 *
 * Features whose section has no result row, or whose result for this metric was
 * filtered out as "no data" (a negative sentinel), are dropped entirely rather
 * than drawn in the ramp's zero color — an unmeasured road must not read as a
 * measured zero.
 */
export function buildSectionRows(
  sections: NetworkFeatureCollection | null,
  results: NetworkKpiResults | null,
  metric: NetworkKpiMetric,
): KpiPolygonRow[] {
  if (!sections) return [];
  const rows: KpiPolygonRow[] = [];
  for (const feature of sections.features) {
    const sectionId = featureSectionId(feature);
    if (sectionId === null) continue;
    const value = results ? kpiValue(results.sections.get(sectionId), metric) : null;
    // Keep the network footprint visible while a package has no readable KPI
    // database; the renderer paints this null value with its neutral fallback.
    if (results && value === null) continue;
    const line = featureLine(feature);
    if (!line) continue;
    const ring = bufferLineToRing(line, sectionWidthM(feature));
    if (!ring) continue;
    rows.push({ ring, value, sectionId, laneIndex: null });
  }
  return rows;
}

/**
 * Build the lane-level polygon rows for a metric.
 *
 * The join key is {@link laneKey}, whose lane component is already 0-indexed on
 * both sides: the geometry writes `lane_index` from 0 and the query subtracted
 * one from Aimsun's 1-indexed `MILANE.lane` when it built the map.
 */
export function buildLaneRows(
  lanes: NetworkFeatureCollection | null,
  results: NetworkKpiResults | null,
  metric: NetworkKpiMetric,
): KpiPolygonRow[] {
  if (!lanes) return [];
  const rows: KpiPolygonRow[] = [];
  for (const feature of lanes.features) {
    const sectionId = featureSectionId(feature);
    const laneIndex = featureLaneIndex(feature);
    if (sectionId === null || laneIndex === null) continue;
    const value = results ? kpiValue(results.lanes.get(laneKey(sectionId, laneIndex)), metric) : null;
    if (results && value === null) continue;
    const line = featureLine(feature);
    if (!line) continue;
    const ring = bufferLineToRing(line, laneWidthM(feature));
    if (!ring) continue;
    rows.push({ ring, value, sectionId, laneIndex });
  }
  return rows;
}

/** Stable row key: joins a geometry row to a KPI result independent of metric. */
function rowKeyImpl(sectionId: number, laneIndex: number | null): string {
  return laneIndex === null ? `s:${sectionId}` : `l:${laneKey(sectionId, laneIndex)}`;
}

/**
 * Build the section-level GEOMETRY rows once, independent of any metric or
 * KPI result — just the buffered ribbon per section feature.
 *
 * Unlike {@link buildSectionRows}, this never filters on "does this section
 * have a result for the active metric": geometry rows are a static base layer,
 * so every section with valid geometry gets a row regardless of whether (or
 * which) KPI value is currently available for it.
 */
export function buildSectionGeometryRows(
  sections: NetworkFeatureCollection | null,
): KpiGeometryRow[] {
  if (!sections) return [];
  const rows: KpiGeometryRow[] = [];
  for (const feature of sections.features) {
    const sectionId = featureSectionId(feature);
    if (sectionId === null) continue;
    const line = featureLine(feature);
    if (!line) continue;
    const ring = bufferLineToRing(line, sectionWidthM(feature));
    if (!ring) continue;
    rows.push({ ring, sectionId, laneIndex: null, key: rowKeyImpl(sectionId, null) });
  }
  return rows;
}

/**
 * Build the lane-level GEOMETRY rows once, independent of any metric or KPI
 * result. See {@link buildSectionGeometryRows}.
 */
export function buildLaneGeometryRows(lanes: NetworkFeatureCollection | null): KpiGeometryRow[] {
  if (!lanes) return [];
  const rows: KpiGeometryRow[] = [];
  for (const feature of lanes.features) {
    const sectionId = featureSectionId(feature);
    const laneIndex = featureLaneIndex(feature);
    if (sectionId === null || laneIndex === null) continue;
    const line = featureLine(feature);
    if (!line) continue;
    const ring = bufferLineToRing(line, laneWidthM(feature));
    if (!ring) continue;
    rows.push({ ring, sectionId, laneIndex, key: rowKeyImpl(sectionId, laneIndex) });
  }
  return rows;
}

/**
 * Builds a cheap `row key -> current KPI value` lookup from a results
 * snapshot, for a KPI-overlay layer's accessors to read live without
 * rebuilding any geometry. `null` means "no result for this metric" (dropped
 * from the fused {@link buildSectionRows}/{@link buildLaneRows} rows, but kept
 * here so the overlay layer can still choose how to render "no data").
 */
export function buildKpiValueIndex(
  results: NetworkKpiResults | null,
  metric: NetworkKpiMetric,
): Map<string, number | null> {
  const index = new Map<string, number | null>();
  if (!results) return index;
  for (const [sectionId, row] of results.sections) {
    index.set(rowKeyImpl(sectionId, null), kpiValue(row, metric));
  }
  for (const [key, row] of results.lanes) {
    // `laneKey`'s own composite key format is already the join key lane rows
    // use, so the lane branch can reuse it directly instead of decomposing and
    // re-encoding it.
    index.set(`l:${key}`, kpiValue(row, metric));
  }
  return index;
}

/** Re-exported so the engine can type its row maps without a second import. */
export type { KpiRow };
