/*
 * ESM turn geometry companion adapted from the pinned
 * rendering-outputs-turns.js (origin commit 92f105dfd0484f6ca69c7edce098b1be080d8cc4).
 * Converts turn centerlines to neutral-grey metre-width ribbons without globals.
 */
import type { Feature, FeatureCollection, Position } from "geojson";

const METERS_PER_DEGREE = 111319.49079327358;
const DEFAULT_TURN_WIDTH_METERS = 3.5;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function turnRibbon(feature: Feature): Feature | null {
  const geometry = feature.geometry;
  if (!geometry || (geometry.type !== "LineString" && geometry.type !== "MultiLineString")) return null;
  const properties = object(feature.properties);
  const configured = [properties.width, properties.lane_width].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  const halfWidth = (typeof configured === "number" ? configured : DEFAULT_TURN_WIDTH_METERS) / 2;
  const lines: Position[][] = geometry.type === "LineString" ? [geometry.coordinates as Position[]] : geometry.coordinates as Position[][];
  const polygons: Position[][][] = [];
  for (const coordinates of lines) for (let index = 0; index + 1 < coordinates.length; index += 1) {
    const a = coordinates[index]!; const b = coordinates[index + 1]!;
    const longitudeScale = METERS_PER_DEGREE * Math.max(Math.cos(((a[1]! + b[1]!) / 2) * Math.PI / 180), 1e-6);
    const dx = (b[0]! - a[0]!) * longitudeScale; const dy = (b[1]! - a[1]!) * METERS_PER_DEGREE;
    const length = Math.hypot(dx, dy); if (!length) continue;
    const longitudeOffset = -dy / length * halfWidth / longitudeScale;
    const latitudeOffset = dx / length * halfWidth / METERS_PER_DEGREE;
    polygons.push([[[a[0]! + longitudeOffset, a[1]! + latitudeOffset], [b[0]! + longitudeOffset, b[1]! + latitudeOffset],
      [b[0]! - longitudeOffset, b[1]! - latitudeOffset], [a[0]! - longitudeOffset, a[1]! - latitudeOffset],
      [a[0]! + longitudeOffset, a[1]! + latitudeOffset]]]);
  }
  return polygons.length ? { type: "Feature", id: feature.id, properties: feature.properties, geometry: { type: "MultiPolygon", coordinates: polygons } } : null;
}

export function turnRibbonFeatureCollection(network: FeatureCollection): FeatureCollection {
  return { type: "FeatureCollection", features: network.features.map(turnRibbon).filter((feature): feature is Feature => Boolean(feature)) };
}
