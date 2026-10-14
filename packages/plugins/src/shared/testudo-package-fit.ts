/**
 * Present-mode package fit: frame the map on the package extent once per package version.
 * Pure logic (bounds validation, geometry extent, fit decision, Cesium camera) so it is unit-testable;
 * the map side effects live in `PackageFitter` behind a structural map type.
 *
 * Rules: bounds must be finite and inside lon [-180,180] / lat [-90,90] with west<=east and south<=north;
 * fit at most once per key (package version); never after the user moved the map for that key;
 * skip when no valid bounds exist (manifest bounds first, then the loaded network geometry).
 */

export type PackageBounds = [west: number, south: number, east: number, north: number];

export const PACKAGE_FIT_PADDING = 48;
export const PACKAGE_FIT_MAX_ZOOM = 16;

export function isValidPackageBounds(value: unknown): value is PackageBounds {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [w, s, e, n] = value;
  return [w, s, e, n].every(item => typeof item === "number" && Number.isFinite(item))
    && w >= -180 && e <= 180 && w <= e && s >= -90 && n <= 90 && s <= n;
}

/** Accepts `[w,s,e,n]`, `{min_lon,min_lat,max_lon,max_lat}` or `{west,south,east,north}`; null when absent or invalid. */
export function parsePackageBounds(raw: unknown): PackageBounds | null {
  let candidate: unknown[] | null = null;
  if (Array.isArray(raw)) candidate = raw;
  else if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ("min_lon" in r) candidate = [r.min_lon, r.min_lat, r.max_lon, r.max_lat];
    else if ("west" in r) candidate = [r.west, r.south, r.east, r.north];
  }
  return candidate && isValidPackageBounds(candidate) ? [candidate[0], candidate[1], candidate[2], candidate[3]] as PackageBounds : null;
}

/** `manifest.metadata.bounds` of a package manifest (null/missing/invalid => null). */
export function manifestBounds(manifest: unknown): PackageBounds | null {
  if (!manifest || typeof manifest !== "object") return null;
  const metadata = (manifest as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" ? parsePackageBounds((metadata as Record<string, unknown>).bounds) : null;
}

interface Extent { w: number; s: number; e: number; n: number }

function walk(coordinates: unknown, extent: Extent, depth = 0): void {
  if (!Array.isArray(coordinates) || depth > 6) return;
  if (typeof coordinates[0] === "number") {
    const lon = coordinates[0], lat = coordinates[1];
    if (typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return;
    if (lon < extent.w) extent.w = lon;
    if (lon > extent.e) extent.e = lon;
    if (lat < extent.s) extent.s = lat;
    if (lat > extent.n) extent.n = lat;
    return;
  }
  for (const item of coordinates) walk(item, extent, depth + 1);
}

/** Extent of the valid coordinates of GeoJSON-like collections (first collection with any valid coordinate wins). */
export function geometryBounds(collections: Iterable<{ features?: ReadonlyArray<{ geometry?: { coordinates?: unknown } | null }> } | null | undefined>): PackageBounds | null {
  for (const collection of collections) {
    const features = collection?.features;
    if (!Array.isArray(features) || !features.length) continue;
    const extent: Extent = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity };
    for (const feature of features) walk(feature?.geometry?.coordinates, extent);
    if (Number.isFinite(extent.w)) return [extent.w, extent.s, extent.e, extent.n];
  }
  return null;
}

export type FitDecision =
  | { action: "fit"; bounds: PackageBounds }
  | { action: "skip"; reason: "no-key" | "already-fitted" | "user-moved" | "no-bounds" };

/** Pure fit decision for one package key. `fittedKey` is the key already framed; `userMovedKey` the key the user moved the map on. */
export function decidePackageFit(input: { key: string | null; fittedKey: string | null; userMovedKey: string | null; bounds: unknown }): FitDecision {
  if (!input.key) return { action: "skip", reason: "no-key" };
  if (input.fittedKey === input.key) return { action: "skip", reason: "already-fitted" };
  if (input.userMovedKey === input.key) return { action: "skip", reason: "user-moved" };
  const bounds = parsePackageBounds(input.bounds);
  return bounds ? { action: "fit", bounds } : { action: "skip", reason: "no-bounds" };
}

/** Engine-neutral camera (centre + zoom) for bounds in a viewport, for renderers without fitBounds (Cesium store view). */
export function cameraForBounds(bounds: PackageBounds, viewport: { width: number; height: number }, padding = PACKAGE_FIT_PADDING, maxZoom = PACKAGE_FIT_MAX_ZOOM): { center: [number, number]; zoom: number } {
  const [w, s, e, n] = bounds;
  const merc = (lat: number): number => { const r = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + r) / (1 - r)) / (4 * Math.PI); };
  const spanX = Math.max((e - w) / 360, 1e-9);
  const spanY = Math.max(merc(s) - merc(n), 1e-9);
  const availW = Math.max(viewport.width - 2 * padding, 1);
  const availH = Math.max(viewport.height - 2 * padding, 1);
  const zoom = Math.max(0, Math.min(maxZoom, Math.log2(Math.min(availW / (512 * spanX), availH / (512 * spanY)))));
  return { center: [(w + e) / 2, (s + n) / 2], zoom };
}

export interface PackageFitMap {
  on?(type: string, fn: (e: { originalEvent?: unknown }) => void): void;
  off?(type: string, fn: (e: { originalEvent?: unknown }) => void): void;
  fitBounds?(bounds: [[number, number], [number, number]], options?: Record<string, unknown>): void;
}

const USER_MOVE_EVENTS = ["dragstart", "zoomstart", "rotatestart", "pitchstart"];

/**
 * Fits once per key. User moves are detected through MapLibre start events that carry an `originalEvent`
 * (programmatic moves never do). `applyCamera` is used when there is no MapLibre map (Cesium).
 */
export class PackageFitter {
  private fittedKey: string | null = null;
  private userMovedKey: string | null = null;
  private activeKey: string | null = null;
  private watched: PackageFitMap | null = null;
  private readonly onMove = (event: { originalEvent?: unknown }): void => {
    if (event && event.originalEvent && this.activeKey) this.userMovedKey = this.activeKey;
  };

  /** Forget everything (package reset): the next package may fit again. */
  reset(): void { this.fittedKey = null; this.userMovedKey = null; this.activeKey = null; }

  dispose(): void { this.unwatch(); this.reset(); }

  /** Start/continue watching the map for user moves of the current key. Safe to call repeatedly and with a replaced map. */
  watch(map: PackageFitMap | null): void {
    if (this.watched === map) return;
    this.unwatch();
    this.watched = map;
    if (map) for (const type of USER_MOVE_EVENTS) map.on?.(type, this.onMove);
  }

  /** Begin a package key: user moves before the first fit of this key count for it. */
  begin(key: string | null): void {
    if (key !== this.activeKey) { this.activeKey = key; if (this.userMovedKey !== key) this.userMovedKey = null; }
  }

  /** Returns true when the camera was moved. Never throws. */
  fit(key: string | null, bounds: unknown, target: { map: PackageFitMap | null; applyCamera?: (camera: { center: [number, number]; zoom: number }) => void; viewport?: { width: number; height: number } }): boolean {
    this.begin(key);
    this.watch(target.map);
    const decision = decidePackageFit({ key, fittedKey: this.fittedKey, userMovedKey: this.userMovedKey, bounds });
    if (decision.action !== "fit") return false;
    const [w, s, e, n] = decision.bounds;
    try {
      if (target.map?.fitBounds) target.map.fitBounds([[w, s], [e, n]], { padding: PACKAGE_FIT_PADDING, maxZoom: PACKAGE_FIT_MAX_ZOOM, duration: 0 });
      else if (target.applyCamera) target.applyCamera(cameraForBounds(decision.bounds, target.viewport ?? { width: 1280, height: 720 }));
      else return false;
    } catch { return false; }
    this.fittedKey = key;
    return true;
  }

  private unwatch(): void {
    if (this.watched) for (const type of USER_MOVE_EVENTS) this.watched.off?.(type, this.onMove);
    this.watched = null;
  }
}
