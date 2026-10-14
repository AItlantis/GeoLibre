/** Detector geometry (detectors.geojson with oid, eid, x, y and, since C6, coverage polygons) and the join with the aggregates. */
import type { DetAgg } from "./aggregate.ts";

export interface GeoPoint {
  lon: number;
  lat: number;
}

/** GeoJSON polygonal coverage of one simulated detector (one ring group per covered lane). */
export interface CoverageGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown[];
}

/**
 * One simulated detector (render identity = oid). Analytical identity stays per eid:
 * several parts may share one eid (see oidsByEid) and this module never aggregates them.
 */
export interface DetectorPart {
  oid: string;
  eid: string | null;
  /** WGS84 anchor (Point geometry, else properties x/y, else the coverage centroid). */
  point: GeoPoint;
  /** Real coverage (Polygon/MultiPolygon); null for Point-only detectors. */
  coverage: CoverageGeometry | null;
  sectionId: unknown;
  lanes: number[] | null;
  positionM: number | null;
  lengthM: number | null;
  /** Forward true bearing, degrees clockwise from north in [0,360) (the reverse flip is already applied). */
  bearingDeg: number | null;
  direction: string | null;
  geometryMethod: string | null;
  geometryQuality: string | null;
}

export interface GeoIndex {
  byOid: Map<string, GeoPoint>;
  byEid: Map<string, GeoPoint>;
  /** Per-oid detector parts (anchor, coverage, direction). */
  parts: Map<string, DetectorPart>;
  /** eid -> every oid carrying it (Jumeira: 292 oids, 255 eids). Exposed, never aggregated here. */
  oidsByEid: Map<string, string[]>;
  /** True when at least one feature carries a real Polygon/MultiPolygon coverage. */
  hasCoverage: boolean;
  count: number;
}

const okLon = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180;
const okLat = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 90;
const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : Number(v));
const optNum = (v: unknown): number | null => {
  const n = num(v);
  return Number.isFinite(n) ? n : null;
};
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const validPos = (c: unknown): boolean => Array.isArray(c) && okLon(c[0]) && okLat(c[1]);
const validRing = (r: unknown): boolean => Array.isArray(r) && r.length >= 4 && r.every(validPos);
const validPolygon = (p: unknown): boolean => Array.isArray(p) && p.length >= 1 && p.every(validRing);

/** Validated coverage geometry, or null (an invalid ring or position rejects the whole geometry). */
function coverageOf(g: { type?: string; coordinates?: unknown } | null | undefined): CoverageGeometry | null {
  const c = g?.coordinates;
  if (!Array.isArray(c)) return null;
  if (g?.type === "Polygon" && validPolygon(c)) return { type: "Polygon", coordinates: c };
  if (g?.type === "MultiPolygon" && c.length >= 1 && c.every(validPolygon)) return { type: "MultiPolygon", coordinates: c };
  return null;
}

/** Mean of the outer-ring vertices of the first polygon (closing vertex excluded). */
function centroidOf(cov: CoverageGeometry): GeoPoint {
  const first = (cov.type === "Polygon" ? cov.coordinates : (cov.coordinates[0] as unknown[])) as number[][][];
  const ring = first[0].slice(0, -1);
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return { lon: x / ring.length, lat: y / ring.length };
}

function bearingOf(v: unknown): number | null {
  const n = optNum(v);
  if (n === null) return null;
  return n >= 0 && n < 360 ? n : ((n % 360) + 360) % 360;
}

/**
 * Accepts a FeatureCollection of Point, Polygon and MultiPolygon features (contract C6; legacy
 * Point-only packages unchanged). The anchor point is, in order: the Point geometry, properties
 * x (lon) / y (lat) when valid degrees, the coverage centroid (polygons). Projected metres
 * (|x| > 180) are rejected: the extractor is expected to emit EPSG:4326. Feature.id is used as
 * the oid when properties.oid is absent.
 */
export function parseDetectorGeo(json: unknown): GeoIndex {
  const byOid = new Map<string, GeoPoint>();
  const byEid = new Map<string, GeoPoint>();
  const parts = new Map<string, DetectorPart>();
  const oidsByEid = new Map<string, string[]>();
  const feats = (json as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(feats)) throw new Error("detectors geometry: not a FeatureCollection");
  let count = 0;
  type F = { id?: unknown; geometry?: { type?: string; coordinates?: unknown[] } | null; properties?: Record<string, unknown> | null };
  for (const f of feats as F[]) {
    const p = f.properties ?? {};
    let pt: GeoPoint | null = null;
    const g = f.geometry;
    const cov = coverageOf(g);
    if (g?.type === "Point" && Array.isArray(g.coordinates) && okLon(g.coordinates[0]) && okLat(g.coordinates[1])) {
      pt = { lon: g.coordinates[0] as number, lat: g.coordinates[1] as number };
    } else if (okLon(num(p.x)) && okLat(num(p.y))) {
      pt = { lon: num(p.x), lat: num(p.y) };
    } else if (cov) {
      pt = centroidOf(cov);
    }
    if (!pt) continue;
    count++;
    const oidRaw = p.oid !== undefined && p.oid !== null ? p.oid : f.id;
    const oid = oidRaw !== undefined && oidRaw !== null && oidRaw !== "" ? String(oidRaw) : null;
    const eid = p.eid !== undefined && p.eid !== null ? String(p.eid) : null;
    if (oid !== null) byOid.set(oid, pt);
    if (eid !== null) byEid.set(eid, pt);
    if (oid === null) continue;
    parts.set(oid, {
      oid,
      eid,
      point: pt,
      coverage: cov,
      sectionId: p.section_id ?? null,
      lanes: Array.isArray(p.lanes) ? p.lanes.map(Number).filter(Number.isFinite) : null,
      positionM: optNum(p.position_m),
      lengthM: optNum(p.length_m),
      bearingDeg: bearingOf(p.bearing_deg),
      direction: optStr(p.direction),
      geometryMethod: optStr(p.geometry_method),
      geometryQuality: optStr(p.geometry_quality),
    });
    if (eid !== null) {
      const list = oidsByEid.get(eid);
      if (!list) oidsByEid.set(eid, [oid]);
      else if (!list.includes(oid)) list.push(oid);
    }
  }
  const hasCoverage = [...parts.values()].some((x) => x.coverage !== null);
  return { byOid, byEid, parts, oidsByEid, hasCoverage, count };
}

/** Every part of an analytical detector: all oids sharing the eid plus the aggregate's own oid. */
export function partsForAgg(geo: GeoIndex | null, a: Pick<DetAgg, "id" | "oid">): DetectorPart[] {
  if (!geo) return [];
  const oids = new Set<string>(geo.oidsByEid.get(a.id) ?? []);
  if (a.oid !== null && geo.parts.has(a.oid)) oids.add(a.oid);
  const out: DetectorPart[] = [];
  for (const o of oids) {
    const part = geo.parts.get(o);
    if (part) out.push(part);
  }
  return out;
}

/** Coverage geometries of parts (feed for geometryPositions / RunFitter extents). */
export function coverageGeometries(parts: Iterable<DetectorPart>): Array<{ coordinates: unknown }> {
  const out: Array<{ coordinates: unknown }> = [];
  for (const p of parts) if (p.coverage) out.push({ coordinates: p.coverage.coordinates });
  return out;
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

/** Coverage layer data: area features (Polygon/MultiPolygon, kind "area") and glyph anchors (Point, kind "arrow"). */
export interface CoverageFeature {
  type: "Feature";
  geometry: { type: "Polygon" | "MultiPolygon" | "Point"; coordinates: unknown };
  properties: Record<string, unknown>;
}
export interface CoverageCollection {
  type: "FeatureCollection";
  features: CoverageFeature[];
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

const hasArea = (parts: readonly DetectorPart[]): boolean => parts.some((p) => p.coverage !== null);

/** "arrow" only for a single travel direction with a known bearing; everything else is the neutral glyph. */
export function glyphFor(part: Pick<DetectorPart, "direction" | "bearingDeg">): "arrow" | "neutral" {
  return (part.direction === "forward" || part.direction === "reverse") && part.bearingDeg !== null ? "arrow" : "neutral";
}

/**
 * Coverage + glyph features for the given parts. Each oid is drawn once; `base` (the analytical
 * metric properties of the detector) is copied onto every part, so parts never multiply
 * anything: the KPIs and charts do not read these features.
 */
export function coverageFeatures(parts: readonly DetectorPart[], base: Record<string, unknown>): CoverageFeature[] {
  if (!hasArea(parts)) return [];
  const out: CoverageFeature[] = [];
  for (const part of parts) {
    const props = {
      ...base,
      oid: part.oid,
      bearing_deg: part.bearingDeg,
      direction: part.direction ?? "unknown",
      glyph: glyphFor(part),
    };
    if (part.coverage) {
      out.push({ type: "Feature", geometry: { type: part.coverage.type, coordinates: part.coverage.coordinates }, properties: { ...props, kind: "area" } });
    }
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [part.point.lon, part.point.lat] }, properties: { ...props, kind: "arrow" } });
  }
  return out;
}

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
        ...(geo?.hasCoverage && hasArea(partsForAgg(geo, a)) ? { cov: true } : {}),
        ...(extra ? extra(a) : {}),
      },
    });
  }
  return { fc: { type: "FeatureCollection", features }, located: features.length };
}

/** Coverage features for the analytical detectors (one set of parts per eid, each oid drawn once). */
export function buildCoverage(
  aggs: readonly DetAgg[],
  geo: GeoIndex | null,
  extra?: (a: DetAgg) => Record<string, unknown>,
): CoverageCollection {
  const features: CoverageFeature[] = [];
  if (!geo?.hasCoverage) return { type: "FeatureCollection", features };
  const seen = new Set<string>();
  for (const a of aggs) {
    const parts = partsForAgg(geo, a).filter((p) => !seen.has(p.oid));
    for (const p of parts) seen.add(p.oid);
    if (!hasArea(partsForAgg(geo, a))) continue;
    const base = {
      eid: a.id,
      sim: round1(a.sim),
      obs: round1(a.obs),
      diff: round1(a.diff),
      relErr: a.relErr === null ? null : Math.round(a.relErr * 1000) / 1000,
      geh: a.geh,
      status: a.status,
      cov: true,
      ...(extra ? extra(a) : {}),
    };
    features.push(...coverageFeatures(parts, base));
  }
  return { type: "FeatureCollection", features };
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
    const part = geo?.parts.get(u.oid);
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pt.lon, pt.lat] },
      properties: { eid: "", oid: u.oid, sim: round1(u.flow), obs: 0, diff: 0, status: "unmatched", unmatched: true, ...(part?.coverage ? { cov: true } : {}) },
    });
  }
  return out;
}

/** Coverage features of unmatched simulated detectors (no eid: not selectable, grey). */
export function buildUnmatchedCoverage(unmatched: readonly UnmatchedLike[], geo: GeoIndex | null): CoverageFeature[] {
  const out: CoverageFeature[] = [];
  if (!geo?.hasCoverage) return out;
  for (const u of unmatched) {
    const part = geo.parts.get(u.oid);
    if (!part?.coverage) continue;
    out.push(...coverageFeatures([part], { eid: "", sim: round1(u.flow), obs: 0, diff: 0, status: "unmatched", unmatched: true, cov: true }));
  }
  return out;
}

/** [lon, lat] positions of every located detector: anchors plus all coverage vertices (input for RunFitter; polygon extents). */
export function detectorExtentPoints(geo: GeoIndex | null, aggs: readonly Pick<DetAgg, "id" | "oid">[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!geo) return out;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") out.push([c[0], c[1]]);
    else for (const x of c) walk(x);
  };
  for (const a of aggs) {
    const pt = locate(geo, a);
    if (pt) out.push([pt.lon, pt.lat]);
    for (const p of partsForAgg(geo, a)) walk(p.coverage?.coordinates);
  }
  return out;
}
