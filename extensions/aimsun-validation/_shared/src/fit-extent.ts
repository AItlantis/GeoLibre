/**
 * Fit the map to a run's own geometry once per run/package load.
 * Rules: never refit on filter/bucket/window changes, never after the user moved the map for
 * that run (dragstart/zoomstart carrying an originalEvent), skip when no valid coordinate exists.
 */

export type Bounds = [west: number, south: number, east: number, north: number];

export interface FitMapLike {
  on?(type: string, fn: (e: any) => void): void;
  off?(type: string, fn: (e: any) => void): void;
  fitBounds?(bounds: [[number, number], [number, number]], opts?: Record<string, unknown>): void;
  flyTo?(opts: Record<string, unknown>): void;
}

export interface FitHost {
  getMap?: () => FitMapLike | null;
  fitBounds?: (bounds: Bounds) => void;
}

export const FIT_PADDING = 48;
export const FIT_MAX_ZOOM = 16;
export const FIT_DURATION = 600;

export function validLonLat(lon: unknown, lat: unknown): boolean {
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -85 && lat <= 85;
}

/** Simple (non antimeridian-wrapping) extent of the valid coordinates, or null when none. */
export function extentOf(points: Iterable<readonly [number, number] | { lon: number; lat: number }>): Bounds | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    const lon = Array.isArray(p) ? p[0] : (p as { lon: number }).lon;
    const lat = Array.isArray(p) ? p[1] : (p as { lat: number }).lat;
    if (!validLonLat(lon, lat)) continue;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export class RunFitter {
  private key: string | null = null;
  private fitted = false;
  private userMoved = false;
  private watched: FitMapLike | null = null;
  private readonly onMove = (e: any): void => {
    if (e && e.originalEvent) this.userMoved = true;
  };

  constructor(private readonly host: FitHost, private readonly isReducedMotion: () => boolean = reducedMotion) {}

  /** Fit once per key. Returns true when the camera was moved. */
  fit(key: string, points: Iterable<readonly [number, number] | { lon: number; lat: number }>): boolean {
    const map = this.host.getMap?.() ?? null;
    this.watch(map);
    if (key !== this.key) {
      this.key = key;
      this.fitted = false;
      this.userMoved = false;
    }
    if (this.fitted || this.userMoved) return false;
    const b = extentOf(points);
    if (!b) return false;
    try {
      this.apply(map, b);
    } catch {
      return false;
    }
    this.fitted = true;
    return true;
  }

  dispose(): void {
    this.unwatch();
    this.key = null;
  }

  private apply(map: FitMapLike | null, b: Bounds): void {
    const single = b[0] === b[2] && b[1] === b[3];
    const animate = !!map?.fitBounds && !this.isReducedMotion();
    const duration = animate ? FIT_DURATION : 0;
    if (map && single && map.flyTo) {
      map.flyTo({ center: [b[0], b[1]], zoom: FIT_MAX_ZOOM, essential: true, duration, animate });
    } else if (map?.fitBounds && !single) {
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration, animate, essential: true });
    } else if (this.host.fitBounds) {
      if (single) {
        const d = 0.002;
        this.host.fitBounds([b[0] - d, b[1] - d, b[2] + d, b[3] + d]);
      } else this.host.fitBounds(b);
    } else throw new Error("no fit available");
  }

  private watch(map: FitMapLike | null): void {
    if (map === this.watched) return;
    this.unwatch();
    if (!map?.on) return;
    map.on("dragstart", this.onMove);
    map.on("zoomstart", this.onMove);
    this.watched = map;
  }

  private unwatch(): void {
    try {
      this.watched?.off?.("dragstart", this.onMove);
      this.watched?.off?.("zoomstart", this.onMove);
    } catch {
      /* map torn down */
    }
    this.watched = null;
  }
}

/** All [lon, lat] positions of GeoJSON-like geometries (any nesting depth); invalid ones are filtered later. */
export function* geometryPositions(geometries: Iterable<{ coordinates?: unknown } | null | undefined>): Generator<[number, number]> {
  function* walk(c: unknown): Generator<[number, number]> {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") yield [c[0], c[1]];
    else for (const x of c) yield* walk(x);
  }
  for (const g of geometries) yield* walk(g?.coordinates);
}
