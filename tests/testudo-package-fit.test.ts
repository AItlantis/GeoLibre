import assert from "node:assert/strict";
import { test } from "node:test";
import { PackageFitter, cameraForBounds, decidePackageFit, geometryBounds, manifestBounds, parsePackageBounds } from "../packages/plugins/src/shared/testudo-package-fit";
import { isSetPresentSuspendedPayload } from "../apps/geolibre-desktop/src/lib/testudo-protocol";

const DUBAI = { min_lon: 55.1, min_lat: 25.1, max_lon: 55.3, max_lat: 25.3 };

test("parsePackageBounds accepts dict and array forms, rejects invalid", () => {
  assert.deepEqual(parsePackageBounds(DUBAI), [55.1, 25.1, 55.3, 25.3]);
  assert.deepEqual(parsePackageBounds([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(parsePackageBounds({ west: 1, south: 2, east: 3, north: 4 }), [1, 2, 3, 4]);
  for (const bad of [null, undefined, 5, "x", [], [1, 2, 3], [NaN, 0, 1, 1], [0, 0, Infinity, 1], [-181, 0, 1, 1], [0, -91, 1, 1], [0, 0, 181, 1], [0, 0, 1, 91], [5, 0, 1, 1], [0, 5, 1, 1], ["1", 2, 3, 4], { min_lon: "a" }, {}]) {
    assert.equal(parsePackageBounds(bad), null, JSON.stringify(bad));
  }
});

test("manifestBounds reads metadata.bounds and tolerates null", () => {
  assert.deepEqual(manifestBounds({ metadata: { bounds: DUBAI } }), [55.1, 25.1, 55.3, 25.3]);
  assert.equal(manifestBounds({ metadata: { bounds: null } }), null);
  assert.equal(manifestBounds({}), null);
  assert.equal(manifestBounds(null), null);
});

test("geometryBounds extent over nested coordinates, ignores invalid points, falls through empty collections", () => {
  const fc = { features: [
    { geometry: { coordinates: [[55.1, 25.2], [55.3, 25.1]] } },
    { geometry: { coordinates: [[[55.2, 25.4]]] } },
    { geometry: { coordinates: [999, 999] } },
    { geometry: null },
  ] };
  assert.deepEqual(geometryBounds([null, { features: [] }, fc]), [55.1, 25.1, 55.3, 25.4]);
  assert.equal(geometryBounds([null, { features: [{ geometry: { coordinates: [[NaN, 1]] } }] }]), null);
});

test("decidePackageFit: fit once per key, never after user moved, skip without bounds", () => {
  const base = { key: "v1", fittedKey: null, userMovedKey: null, bounds: DUBAI };
  assert.deepEqual(decidePackageFit(base), { action: "fit", bounds: [55.1, 25.1, 55.3, 25.3] });
  assert.deepEqual(decidePackageFit({ ...base, fittedKey: "v1" }), { action: "skip", reason: "already-fitted" });
  assert.deepEqual(decidePackageFit({ ...base, userMovedKey: "v1" }), { action: "skip", reason: "user-moved" });
  assert.deepEqual(decidePackageFit({ ...base, bounds: null }), { action: "skip", reason: "no-bounds" });
  assert.deepEqual(decidePackageFit({ ...base, key: null }), { action: "skip", reason: "no-key" });
  assert.equal(decidePackageFit({ ...base, fittedKey: "v0", userMovedKey: "v0" }).action, "fit"); // a new version fits again
});

test("cameraForBounds clamps zoom to maxZoom and centres", () => {
  const point = cameraForBounds([55, 25, 55, 25], { width: 800, height: 600 });
  assert.equal(point.zoom, 16);
  const city = cameraForBounds([55.1, 25.1, 55.3, 25.3], { width: 1000, height: 800 });
  assert.ok(city.zoom > 8 && city.zoom < 12, String(city.zoom));
  assert.ok(Math.abs(city.center[0] - 55.2) < 1e-9 && Math.abs(city.center[1] - 25.2) < 1e-9);
});

type Handler = (e: { originalEvent?: unknown }) => void;
class FakeMap {
  handlers = new Map<string, Handler[]>();
  fits: unknown[] = [];
  on(t: string, f: Handler) { this.handlers.set(t, [...(this.handlers.get(t) ?? []), f]); }
  off(t: string, f: Handler) { this.handlers.set(t, (this.handlers.get(t) ?? []).filter(x => x !== f)); }
  fitBounds(b: unknown, o: unknown) { this.fits.push([b, o]); }
  emit(t: string, e: { originalEvent?: unknown }) { for (const f of this.handlers.get(t) ?? []) f(e); }
}

test("PackageFitter fits MapLibre with padding 48 maxZoom 16 once per key", () => {
  const map = new FakeMap(); const fitter = new PackageFitter();
  assert.equal(fitter.fit("v1", DUBAI, { map }), true);
  assert.deepEqual(map.fits[0], [[[55.1, 25.1], [55.3, 25.3]], { padding: 48, maxZoom: 16, duration: 0 }]);
  assert.equal(fitter.fit("v1", DUBAI, { map }), false);
  assert.equal(map.fits.length, 1);
  assert.equal(fitter.fit("v2", DUBAI, { map }), true); // new version
});

test("PackageFitter ignores programmatic moves but honours user moves, even before the first fit", () => {
  const map = new FakeMap(); const fitter = new PackageFitter();
  fitter.begin("v1"); fitter.watch(map);
  map.emit("zoomstart", {}); // programmatic: no originalEvent
  map.emit("dragstart", { originalEvent: {} });
  assert.equal(fitter.fit("v1", DUBAI, { map }), false);
  assert.equal(map.fits.length, 0);
  assert.equal(fitter.fit("v2", DUBAI, { map }), true); // user moves are per package version
});

test("PackageFitter skips invalid bounds, survives a throwing map, and uses applyCamera without a map", () => {
  const fitter = new PackageFitter();
  assert.equal(fitter.fit("v1", null, { map: new FakeMap() }), false);
  const throwing = { fitBounds() { throw new Error("boom"); } };
  assert.equal(new PackageFitter().fit("v1", DUBAI, { map: throwing }), false);
  const cameras: unknown[] = [];
  assert.equal(new PackageFitter().fit("v1", DUBAI, { map: null, applyCamera: c => { cameras.push(c); }, viewport: { width: 1000, height: 800 } }), true);
  assert.equal(cameras.length, 1);
  assert.equal(new PackageFitter().fit("v1", DUBAI, { map: null }), false);
});

test("PackageFitter.reset lets the same key fit again (package reset)", () => {
  const map = new FakeMap(); const fitter = new PackageFitter();
  assert.equal(fitter.fit("v1", DUBAI, { map }), true);
  fitter.reset();
  assert.equal(fitter.fit("v1", DUBAI, { map }), true);
});

test("isSetPresentSuspendedPayload is strict", () => {
  assert.equal(isSetPresentSuspendedPayload({ challenge: "c", suspended: true }), true);
  assert.equal(isSetPresentSuspendedPayload({ challenge: "c", suspended: false, tviewId: "main" }), true);
  for (const bad of [null, [], {}, { suspended: "true" }, { suspended: 1 }, { suspended: true, extra: 1 }, { suspended: true, tviewId: "other" }]) assert.equal(isSetPresentSuspendedPayload(bad), false, JSON.stringify(bad));
});
