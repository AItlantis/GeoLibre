import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  articulatedSegmentCount,
  articulatedVehicleFootprints,
  isArticulatedSample,
  type VehicleHistoryEntry,
  type VehicleSample,
} from "../packages/plugins/src/plugins/vehicle-playback-data";

/**
 * Synthetic geometry tests for the articulated (tram) footprint builder.
 *
 * These drive `articulatedVehicleFootprints` with hand-built path histories —
 * no map, no deck.gl, no package — and assert the invariants that make a tram
 * read as a jointed vehicle:
 *
 * - consecutive segment CENTERS are exactly one `spacingM` apart, on a straight
 *   run and around a curve alike;
 * - on a straight run every segment is colinear and the visible clearance
 *   between two bodies is the small fixed joint gap, not a wide slot (the
 *   straight-line seam this suite was added for);
 * - around a curve the segments actually bend relative to each other.
 */

const METERS_PER_DEGREE = 111_320;
const LAT0 = 41.39;
const LON0 = 2.16;
const LON_SCALE = 1 / (METERS_PER_DEGREE * Math.cos((LAT0 * Math.PI) / 180));
const LAT_SCALE = 1 / METERS_PER_DEGREE;

/** Local planar meters relative to the (LON0, LAT0) origin. */
function toMeters(lon: number, lat: number): [number, number] {
  return [(lon - LON0) / LON_SCALE, (lat - LAT0) / LAT_SCALE];
}

function distanceM(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Centroid of a footprint ring, in local planar meters. */
function ringCenter(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    const [mx, my] = toMeters(lon, lat);
    x += mx;
    y += my;
  }
  return [x / ring.length, y / ring.length];
}

/**
 * `orientedRectangle` emits [front-left, front-right, rear-right, rear-left],
 * so the front and rear edge midpoints are these corner pairs.
 */
function ringEdges(ring: [number, number][]): {
  frontMid: [number, number];
  rearMid: [number, number];
} {
  const p = ring.map(([lon, lat]) => toMeters(lon, lat));
  return {
    frontMid: [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2],
    rearMid: [(p[2][0] + p[3][0]) / 2, (p[2][1] + p[3][1]) / 2],
  };
}

const TRAM: VehicleSample = {
  id: 1,
  lon: LON0,
  lat: LAT0,
  z: 0,
  heading: 90,
  opacity: 1,
  speedKmh: 30,
  typeName: "Tram",
  lengthM: 30,
  widthM: 2.6,
  heightM: 3.4,
  shapeKey: "tram",
};

/** A dead-straight, due-east path sampled every `stepM` meters. */
function straightHistory(stepM: number, count: number): VehicleHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    lon: LON0 + i * stepM * LON_SCALE,
    lat: LAT0,
    heading: 90,
    distanceM: i * stepM,
    tick: i,
  }));
}

/** A constant-radius left turn, starting due east. */
function curveHistory(stepM: number, count: number, radiusM: number): VehicleHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const travelled = i * stepM;
    const theta = travelled / radiusM;
    return {
      lon: LON0 + radiusM * Math.sin(theta) * LON_SCALE,
      lat: LAT0 + radiusM * (1 - Math.cos(theta)) * LAT_SCALE,
      heading: (90 - (theta * 180) / Math.PI + 360) % 360,
      distanceM: travelled,
      tick: i,
    };
  });
}

/** Place the live sample exactly on the history head. */
function sampleAtHead(history: VehicleHistoryEntry[]): VehicleSample {
  const head = history[history.length - 1];
  return { ...TRAM, lon: head.lon, lat: head.lat, heading: head.heading };
}

describe("articulated tram footprints", () => {
  it("treats a tram as articulated and splits it into segments", () => {
    assert.equal(isArticulatedSample(TRAM), true);
    assert.equal(isArticulatedSample({ ...TRAM, shapeKey: "car_sedan" }), false);
    assert.equal(articulatedSegmentCount(30), 4);
  });

  it("keeps segment centers exactly one spacing apart on a DEAD-STRAIGHT run", () => {
    const history = straightHistory(5, 60);
    const rings = articulatedVehicleFootprints(sampleAtHead(history), history);
    const spacingM = TRAM.lengthM / rings.length;

    assert.equal(rings.length, 4);
    const centers = rings.map(ringCenter);
    for (let i = 1; i < centers.length; i += 1) {
      const gap = distanceM(centers[i - 1], centers[i]);
      assert.ok(
        Math.abs(gap - spacingM) < 1e-6,
        `segment ${i - 1}->${i} center spacing ${gap} != ${spacingM}`,
      );
    }
  });

  it("keeps every segment colinear on a DEAD-STRAIGHT run", () => {
    const history = straightHistory(5, 60);
    const rings = articulatedVehicleFootprints(sampleAtHead(history), history);
    const centers = rings.map(ringCenter);

    // The path is due east, so every center must share one latitude (y) and
    // march monotonically backwards in x.
    for (const [, y] of centers) {
      assert.ok(Math.abs(y - centers[0][1]) < 1e-6, `center off-axis by ${y - centers[0][1]} m`);
    }
    for (let i = 1; i < centers.length; i += 1) {
      assert.ok(centers[i][0] < centers[i - 1][0], "segments must trail behind the head");
    }
  });

  it("leaves only a hairline joint clearance on a DEAD-STRAIGHT run", () => {
    // The regression this guards: a proportional (0.92 length factor) gap left
    // a 0.6 m full-width slot between colinear segments, which read as the tram
    // being broken into pieces. A curve masked it because the joints pivot.
    const history = straightHistory(5, 60);
    const rings = articulatedVehicleFootprints(sampleAtHead(history), history);

    for (let i = 1; i < rings.length; i += 1) {
      const ahead = ringEdges(rings[i - 1]);
      const behind = ringEdges(rings[i]);
      const clearance = distanceM(ahead.rearMid, behind.frontMid);
      assert.ok(
        clearance > 0 && clearance <= 0.15,
        `joint ${i - 1}->${i} clearance ${clearance} m is not a hairline seam`,
      );
    }
  });

  it("keeps segment centers one spacing apart around a CURVE too", () => {
    const history = curveHistory(3, 160, 40);
    const rings = articulatedVehicleFootprints(sampleAtHead(history), history);
    const spacingM = TRAM.lengthM / rings.length;
    const centers = rings.map(ringCenter);

    for (let i = 1; i < centers.length; i += 1) {
      const gap = distanceM(centers[i - 1], centers[i]);
      // Centers are chord-measured across an arc of one spacing, so they sit a
      // hair closer together than the along-path spacing; 2% covers a 40 m
      // radius turn without admitting a telescoping train.
      assert.ok(
        Math.abs(gap - spacingM) < spacingM * 0.02,
        `segment ${i - 1}->${i} center spacing ${gap} strays from ${spacingM}`,
      );
    }
  });

  it("bends the segments through a CURVE instead of staying rigid", () => {
    const history = curveHistory(3, 160, 25);
    const rings = articulatedVehicleFootprints(sampleAtHead(history), history);
    const centers = rings.map(ringCenter);

    // Rear segments must leave the head's axis: on a left turn the trailing
    // centers fall away from the straight line the front segment points along.
    const [hx, hy] = centers[0];
    const [tx, ty] = centers[centers.length - 1];
    const chord = Math.hypot(tx - hx, ty - hy);
    const alongPath = (centers.length - 1) * (TRAM.lengthM / centers.length);
    assert.ok(chord < alongPath, "a curved body's end-to-end chord must be shorter than its path");

    // And the joints must actually be asymmetric — the hallmark of a hinge.
    const first = ringEdges(rings[0]);
    const second = ringEdges(rings[1]);
    const jointOffset = distanceM(first.rearMid, second.frontMid);
    assert.ok(jointOffset > 0, "adjacent segments must not coincide");
  });

  it("falls back to a rigid body when no history is available", () => {
    const rings = articulatedVehicleFootprints(TRAM, []);
    assert.equal(rings.length, 4);
    // Without history every segment collapses onto the sample's own pose.
    const centers = rings.map(ringCenter);
    for (const center of centers) {
      assert.ok(Math.abs(center[0] - centers[0][0]) < 1e-9);
      assert.ok(Math.abs(center[1] - centers[0][1]) < 1e-9);
    }
  });
});
