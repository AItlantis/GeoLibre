import test from "node:test";
import assert from "node:assert/strict";
import { extentOf, geometryPositions, RunFitter, validLonLat, type FitMapLike } from "../src/fit-extent.ts";

function fakeMap(withFit = true) {
  const calls: Array<{ fn: string; args: any[] }> = [];
  const handlers = new Map<string, Array<(e: any) => void>>();
  const map: FitMapLike = {
    on: (t, f) => void (handlers.get(t) ?? handlers.set(t, []).get(t)!).push(f),
    off: (t, f) => void handlers.set(t, (handlers.get(t) ?? []).filter((h) => h !== f)),
    flyTo: (o) => void calls.push({ fn: "flyTo", args: [o] }),
    ...(withFit ? { fitBounds: (b: any, o: any) => void calls.push({ fn: "fitBounds", args: [b, o] }) } : {}),
  };
  const emit = (t: string, e: any) => (handlers.get(t) ?? []).forEach((h) => h(e));
  return { map, calls, emit };
}

const dubai: Array<[number, number]> = [[55.2, 25.1], [55.3, 25.2], [55.25, 25.15]];

test("extentOf computes bounds and filters invalid coordinates", () => {
  assert.deepEqual(extentOf([...dubai, [Number.NaN, 1], [200, 0], [0, 86], [-181, 0]]), [55.2, 25.1, 55.3, 25.2]);
  assert.deepEqual(extentOf([[-179, -10], [179, 10]]), [-179, -10, 179, 10]);
  assert.equal(extentOf([]), null);
  assert.equal(extentOf([[999, 999]]), null);
  assert.ok(validLonLat(-180, -85) && !validLonLat(0, 85.1));
});

test("geometryPositions flattens nested geometries", () => {
  const pts = [...geometryPositions([{ coordinates: [[1, 2], [3, 4]] }, { coordinates: [[[5, 6]]] }, null])];
  assert.deepEqual(pts, [[1, 2], [3, 4], [5, 6]]);
});

test("fit uses fitBounds with padding 48, maxZoom 16, 600 ms", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  assert.equal(fitter.fit("r1", dubai), true);
  assert.deepEqual(f.calls[0].args[0], [[55.2, 25.1], [55.3, 25.2]]);
  assert.equal(f.calls[0].args[1].padding, 48);
  assert.equal(f.calls[0].args[1].maxZoom, 16);
  assert.equal(f.calls[0].args[1].duration, 600);
});

test("reduced motion disables animation", () => {
  const f = fakeMap();
  new RunFitter({ getMap: () => f.map }, () => true).fit("r1", dubai);
  assert.equal(f.calls[0].args[1].animate, false);
  assert.equal(f.calls[0].args[1].duration, 0);
});

test("single point flies to zoom 16", () => {
  const f = fakeMap();
  new RunFitter({ getMap: () => f.map }, () => false).fit("r1", [[55.2, 25.1]]);
  assert.equal(f.calls[0].fn, "flyTo");
  assert.deepEqual(f.calls[0].args[0].center, [55.2, 25.1]);
  assert.equal(f.calls[0].args[0].zoom, 16);
});

test("empty or invalid input does nothing and does not consume the fit", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  assert.equal(fitter.fit("r1", []), false);
  assert.equal(fitter.fit("r1", [[500, 0]]), false);
  assert.equal(f.calls.length, 0);
  assert.equal(fitter.fit("r1", dubai), true);
});

test("fits once per run: filter changes (same key) do not refit", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  fitter.fit("r1", dubai);
  assert.equal(fitter.fit("r1", [[10, 10], [11, 11]]), false);
  assert.equal(f.calls.length, 1);
});

test("user move suppresses refit for that run; programmatic move events do not", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  fitter.fit("r1", dubai);
  f.emit("zoomstart", {}); // programmatic: no originalEvent
  f.emit("dragstart", {});
  f.emit("zoomstart", { originalEvent: { type: "wheel" } });
  assert.equal(fitter.fit("r2", dubai), true, "new run resets the flag");
  f.emit("dragstart", { originalEvent: { type: "mousedown" } });
  assert.equal(fitter.fit("r2", dubai), false);
  assert.equal(f.calls.length, 2);
});

test("user moving before the data is available suppresses the first fit", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  fitter.fit("r1", []); // attaches listeners, key set
  f.emit("dragstart", { originalEvent: {} });
  assert.equal(fitter.fit("r1", dubai), false);
});

test("run switch refits", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  fitter.fit("pkgA|run1", dubai);
  fitter.fit("pkgA|run2", [[1, 1], [2, 2]]);
  fitter.fit("pkgB|run1", [[3, 3], [4, 4]]);
  assert.equal(f.calls.length, 3);
});

test("falls back to app.fitBounds when the map has no fitBounds (globe)", () => {
  const f = fakeMap(false);
  const got: any[] = [];
  const fitter = new RunFitter({ getMap: () => f.map, fitBounds: (b) => void got.push(b) }, () => false);
  fitter.fit("r1", dubai);
  assert.deepEqual(got[0], [55.2, 25.1, 55.3, 25.2]);
  const g2: any[] = [];
  new RunFitter({ fitBounds: (b) => void g2.push(b) }, () => false).fit("r", [[1, 1]]);
  assert.equal(g2.length, 1);
});

test("dispose removes listeners", () => {
  const f = fakeMap();
  const fitter = new RunFitter({ getMap: () => f.map }, () => false);
  fitter.fit("r1", dubai);
  fitter.dispose();
  f.emit("dragstart", { originalEvent: {} });
  assert.equal(fitter.fit("r1", dubai), true); // key reset after dispose
});
