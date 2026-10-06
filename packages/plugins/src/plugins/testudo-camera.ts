import type { FeatureCollection, Position } from "geojson";
import type { TestudoCameraView } from "../shared/testudo-feature-session";

export type TestudoBounds = [[number, number], [number, number]];

export type ValidatedTestudoCameraView = Required<TestudoCameraView>;

export function validateTestudoCameraView(value: unknown): ValidatedTestudoCameraView {
  if (!value || typeof value !== "object") throw new Error("Camera view must be an object.");
  const view = value as Partial<TestudoCameraView>;
  if (!Array.isArray(view.center) || view.center.length !== 2
    || !view.center.every((number) => typeof number === "number" && Number.isFinite(number))) {
    throw new Error("Camera center must contain finite longitude and latitude values.");
  }
  const [longitude, latitude] = view.center;
  if (longitude! < -180 || longitude! > 180 || latitude! < -90 || latitude! > 90) {
    throw new Error("Camera center must be within longitude [-180, 180] and latitude [-90, 90].");
  }
  if (typeof view.zoom !== "number" || !Number.isFinite(view.zoom) || view.zoom < 0 || view.zoom > 24) {
    throw new Error("Camera zoom must be between 0 and 24.");
  }
  const bearing = view.bearing ?? 0;
  const pitch = view.pitch ?? 0;
  if (typeof bearing !== "number" || !Number.isFinite(bearing)) throw new Error("Camera bearing must be finite.");
  if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch < 0 || pitch > 85) {
    throw new Error("Camera pitch must be between 0 and 85 degrees.");
  }
  return { center: [longitude!, latitude!], zoom: view.zoom, bearing, pitch };
}

function visitCoordinates(value: unknown, accept: (position: Position) => void): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    accept(value as Position);
    return;
  }
  for (const item of value) visitCoordinates(item, accept);
}

export function networkBounds(...collections: Array<FeatureCollection | undefined>): TestudoBounds | null {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const collection of collections) {
    for (const feature of collection?.features ?? []) {
      if (!feature.geometry) continue;
      const positions: Position[] = [];
      const collectGeometry: (geometry: typeof feature.geometry) => void = (geometry) => {
        if (!geometry) return;
        if ("coordinates" in geometry) visitCoordinates(geometry.coordinates, (position) => { positions.push(position); });
        else geometry.geometries.forEach(collectGeometry);
      };
      collectGeometry(feature.geometry);
      for (const position of positions) {
        const longitude = position[0]; const latitude = position[1];
        if (typeof longitude !== "number" || typeof latitude !== "number"
          || !Number.isFinite(longitude) || !Number.isFinite(latitude)
          || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;
        west = Math.min(west, longitude); east = Math.max(east, longitude);
        south = Math.min(south, latitude); north = Math.max(north, latitude);
      }
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}

function validBounds(value: unknown): TestudoBounds | null {
  if (Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every((number) => typeof number === "number" && Number.isFinite(number))) {
    value = [[value[0], value[1]], [value[2], value[3]]];
  }
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Array.isArray)) return null;
  const [sw, ne] = value;
  if (sw!.length < 2 || ne!.length < 2) return null;
  const numbers = [sw![0], sw![1], ne![0], ne![1]];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) return null;
  const [west, south, east, north] = numbers as number[];
  if (west! < -180 || east! > 180 || south! < -90 || north! > 90 || west! > east! || south! > north!) return null;
  return [[west!, south!], [east!, north!]];
}

/** Reads the small set of package-level camera declarations accepted by v3.1. */
export function declaredDefaultCamera(...metadata: Array<Record<string, unknown>>): ValidatedTestudoCameraView | TestudoBounds | null {
  for (const source of metadata) {
    const candidates = [source, source.metadata && typeof source.metadata === "object" ? source.metadata as Record<string, unknown> : null]
      .filter((candidate): candidate is Record<string, unknown> => candidate !== null);
    for (const candidate of candidates) {
      for (const key of ["defaultView", "default_view", "defaultCamera", "default_camera", "camera", "view"]) {
        const raw = candidate[key];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const view = raw as Record<string, unknown>;
        const bounds = validBounds(view.bbox ?? view.bounds);
        if (bounds) return bounds;
        const center = view.center ?? view.centerLngLat;
        if (Array.isArray(center) && center.length === 2) {
          try { return validateTestudoCameraView({ center: [center[0], center[1]] as [number, number], zoom: view.zoom ?? 12, bearing: view.bearing, pitch: view.pitch }); }
          catch { /* Ignore invalid declarations and use network bounds. */ }
        }
      }
      const bounds = validBounds(candidate.defaultBbox ?? candidate.default_bbox ?? candidate.bbox
        ?? candidate.defaultBounds ?? candidate.default_bounds ?? candidate.bounds);
      if (bounds) return bounds;
      const center = candidate.defaultCenter ?? candidate.default_center ?? candidate.center;
      if (Array.isArray(center) && center.length === 2) {
        try { return validateTestudoCameraView({ center: [center[0], center[1]] as [number, number], zoom: candidate.zoom ?? 12, bearing: candidate.bearing, pitch: candidate.pitch }); }
        catch { /* Ignore invalid declarations and use network bounds. */ }
      }
    }
  }
  return null;
}
