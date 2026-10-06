import type { FeatureCollection, Feature, Point } from "geojson";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const pathValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export interface TestudoPackageStructure {
  manifest: Json;
  packageInfo: Json;
  sectionsPath: string | null;
  lanesPath: string | null;
  nodesPath: string | null;
  centroidPath: string | null;
  animationManifestPaths: string[];
  maxTick: number;
  dt: number;
}

/** Parse only package metadata; artifact bodies remain host-proxied and lazy. */
export function parseTestudoPackageStructure(manifestValue: unknown, packageValue: unknown): TestudoPackageStructure {
  const manifest = object(manifestValue);
  const packageInfo = object(packageValue);
  const geometry = object(manifest.geometry);
  const baseNetworks = object(geometry.base_networks);
  const metadata = object(manifest.metadata);
  const time = object(packageInfo.time);
  const animations = Array.isArray(packageInfo.animations) ? packageInfo.animations
    : Array.isArray(manifest.animations) ? manifest.animations : [];
  const manifestPaths = animations.map((entry) => {
    const item = object(entry);
    return pathValue(item.manifestPath) ?? pathValue(item.path);
  }).filter((value): value is string => Boolean(value));
  const tickCount = Number(metadata.n_ticks ?? manifest.n_ticks ?? manifest.tick_count ?? 1);
  const dt = Number(metadata.dt ?? manifest.dt ?? packageInfo.dt ?? time.dtSeconds ?? 1);
  return {
    manifest,
    packageInfo,
    sectionsPath: pathValue(geometry.sections) ?? pathValue(baseNetworks.centerlines),
    lanesPath: pathValue(geometry.lanes) ?? pathValue(baseNetworks.lanes),
    nodesPath: pathValue(baseNetworks.nodes),
    centroidPath: pathValue(object(object(manifest.model_inputs).centroids).path)
      ?? pathValue(object(manifest.inputs).centroids) ?? pathValue(object(manifest.scenario_inputs).centroids),
    animationManifestPaths: manifestPaths,
    maxTick: Math.max(0, Math.trunc(tickCount) - 1),
    dt: Number.isFinite(dt) && dt > 0 ? dt : 1,
  };
}

export interface TestudoAnimationChunkDescriptor { path: string; startTick: number; endTick: number; }
export function parseTestudoAnimationManifest(value: unknown): TestudoAnimationChunkDescriptor[] {
  const chunks = object(value).chunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.flatMap((chunk) => {
    const row = object(chunk);
    const path = pathValue(row.path);
    const startTick = Number(row.start_tick ?? row.startTick);
    const endTick = Number(row.end_tick ?? row.endTick);
    return path && Number.isFinite(startTick) && Number.isFinite(endTick) && endTick >= startTick
      ? [{ path, startTick: Math.trunc(startTick), endTick: Math.trunc(endTick) }] : [];
  }).sort((a, b) => a.startTick - b.startTick);
}

export interface TestudoVehiclePoint { id: string; longitude: number; latitude: number; heading?: number; }
/** Read the sparse events_v1 encoding at one tick. Earlier events persist. */
export function vehiclesAtTick(chunk: unknown, tick: number, previous: Map<string, TestudoVehiclePoint> = new Map()): TestudoVehiclePoint[] {
  const root = object(chunk);
  const events = object(root.events);
  const rows = Object.entries(events).map(([key, value]) => [Number(key), value] as const)
    .filter(([at]) => Number.isFinite(at)).sort((a, b) => a[0] - b[0]);
  const pastTicks = new Map<string, number>();
  const future = new Map<string, { tick: number; point: TestudoVehiclePoint }>();
  const removed = new Set<string>();
  for (const [at, values] of rows) {
    if (!Array.isArray(values)) continue;
    for (const raw of values) {
      const row = object(raw); const id = row.id;
      if (id === undefined) continue;
      const key = String(id);
      if (row.event === "remove" || row.event === "despawn") {
        if (at <= tick) { previous.delete(key); removed.add(key); }
        continue;
      }
      const state = object(row.state);
      const front = object(state.front_position);
      const longitude = Number(state.WorldX ?? front.x ?? state.lon);
      const latitude = Number(state.WorldY ?? front.y ?? state.lat);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      const point: TestudoVehiclePoint = {
        id: key, longitude, latitude,
        ...(Number.isFinite(Number(state.heading)) ? { heading: Number(state.heading) } : {}),
      };
      if (at <= tick) { previous.set(key, point); pastTicks.set(key, at); removed.delete(key); }
      else if (!future.has(key)) future.set(key, { tick: at, point });
    }
  }
  for (const [id, next] of future) {
    const start = previous.get(id); const startTick = pastTicks.get(id);
    if (!start || startTick === undefined || removed.has(id) || next.tick <= startTick) continue;
    const ratio = Math.max(0, Math.min(1, (tick - startTick) / (next.tick - startTick)));
    previous.set(id, { ...start, longitude: start.longitude + (next.point.longitude - start.longitude) * ratio,
      latitude: start.latitude + (next.point.latitude - start.latitude) * ratio });
  }
  return [...previous.values()];
}

export function pointCollection(points: TestudoVehiclePoint[]): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: points.map((point): Feature<Point> => ({
    type: "Feature", geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: { id: point.id, heading: point.heading ?? 0 },
  })) };
}
