/** Detector geometry (detectors.geojson with oid, eid, x, y) and the join with the aggregates. */
import type { DetAgg } from "./aggregate.ts";

export interface GeoPoint {
  lon: number;
  lat: number;
}
export interface GeoIndex {
  byOid: Map<string, GeoPoint>;
  byEid: Map<string, GeoPoint>;
  count: number;
}

const okLon = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180;
const okLat = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 90;
const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : Number(v));

/**
 * Accepts a FeatureCollection. The point is the Point geometry (EPSG:4326, GeoJSON order) or,
 * failing that, properties x (lon) / y (lat) when they are valid degrees. Projected metres
 * (|x| > 180) are rejected: the extractor is expected to emit EPSG:4326.
 */
export function parseDetectorGeo(json: unknown): GeoIndex {
  const byOid = new Map<string, GeoPoint>();
  const byEid = new Map<string, GeoPoint>();
  const feats = (json as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(feats)) throw new Error("detectors geometry: not a FeatureCollection");
  let count = 0;
  type F = { geometry?: { type?: string; coordinates?: unknown[] } | null; properties?: Record<string, unknown> | null };
  for (const f of feats as F[]) {
    const p = f.properties ?? {};
    let pt: GeoPoint | null = null;
    const g = f.geometry;
    if (g?.type === "Point" && Array.isArray(g.coordinates) && okLon(g.coordinates[0]) && okLat(g.coordinates[1])) {
      pt = { lon: g.coordinates[0] as number, lat: g.coordinates[1] as number };
    } else if (okLon(num(p.x)) && okLat(num(p.y))) {
      pt = { lon: num(p.x), lat: num(p.y) };
    }
    if (!pt) continue;
    count++;
    if (p.oid !== undefined && p.oid !== null) byOid.set(String(p.oid), pt);
    if (p.eid !== undefined && p.eid !== null) byEid.set(String(p.eid), pt);
  }
  return { byOid, byEid, count };
}

/** oid first (the reliable join per the plan), then eid. */
export function locate(geo: GeoIndex | null, a: Pick<DetAgg, "id" | "oid">): GeoPoint | null {
  if (!geo) return null;
  return (a.oid !== null ? geo.byOid.get(a.oid) : undefined) ?? geo.byEid.get(a.id) ?? null;
}

export interface DetFeatureCollection {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, unknown> }>;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function buildFeatures(
  aggs: readonly DetAgg[],
  geo: GeoIndex | null,
  extra?: (a: DetAgg) => Record<string, unknown>,
): { fc: DetFeatureCollection; located: number } {
  const features: DetFeatureCollection["features"] = [];
  for (const a of aggs) {
    const pt = locate(geo, a);
    if (!pt) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pt.lon, pt.lat] },
      properties: {
        eid: a.id,
        oid: a.oid,
        sim: round1(a.sim),
        obs: round1(a.obs),
        diff: round1(a.diff),
        relErr: a.relErr === null ? null : Math.round(a.relErr * 1000) / 1000,
        geh: a.geh,
        status: a.status,
        ...(extra ? extra(a) : {}),
      },
    });
  }
  return { fc: { type: "FeatureCollection", features }, located: features.length };
}

export interface UnmatchedLike {
  oid: string;
  flow: number;
}

/** Position of an unmatched simulated detector (no eid, so only the oid join applies). */
export function locateOid(geo: GeoIndex | null, oid: string): GeoPoint | null {
  return geo?.byOid.get(oid) ?? null;
}

/** Map features for simulated detectors without an external id; status "unmatched". */
export function buildUnmatchedFeatures(unmatched: readonly UnmatchedLike[], geo: GeoIndex | null): DetFeatureCollection["features"] {
  const out: DetFeatureCollection["features"] = [];
  for (const u of unmatched) {
    const pt = locateOid(geo, u.oid);
    if (!pt) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pt.lon, pt.lat] },
      properties: { eid: "", oid: u.oid, sim: round1(u.flow), obs: 0, diff: 0, status: "unmatched", unmatched: true },
    });
  }
  return out;
}
