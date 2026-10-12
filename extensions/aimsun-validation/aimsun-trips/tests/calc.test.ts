import test from "node:test";
import assert from "node:assert/strict";
import { BAND_EDGES, bandLabel, bandOf, boundsOf, csvCell, describeSelection, divergingHex, linesToFc, parseSelection, radiusPx, sequentialHex, widthPx } from "../../_od/calc.ts";

test("widthPx / radiusPx: monotone, bounded, area-proportional radius", () => {
  assert.equal(widthPx(0, 100), 1);
  assert.equal(widthPx(100, 100), 9);
  assert.equal(widthPx(500, 100), 9); // clamped
  assert.ok(widthPx(25, 100) > widthPx(4, 100));
  assert.equal(widthPx(5, 0), 1);
  assert.equal(radiusPx(100, 100, 3, 24), 24);
  assert.equal(radiusPx(-100, 100, 3, 24), 24); // sign-free
  assert.ok(Math.abs(radiusPx(25, 100, 0, 24) - 12) < 1e-9); // area ~ v: r(25%) = r(100%)/2
  assert.equal(radiusPx(0.0001, 100, 3, 24), 3);
});

test("divergingHex: blue negative, white zero, red positive, symmetric, saturating", () => {
  assert.equal(divergingHex(0, 10), "#f7f7f7");
  assert.equal(divergingHex(-10, 10), "#2166ac");
  assert.equal(divergingHex(10, 10), "#b2182b");
  assert.equal(divergingHex(1000, 10), "#b2182b");
  assert.equal(divergingHex(Number.NaN, 10), "#f7f7f7");
  assert.equal(divergingHex(5, 0), "#f7f7f7");
  assert.equal(sequentialHex(0), "#fff7bc");
  assert.equal(sequentialHex(1), "#08306b");
});

test("deviation bands follow the rendering_adjustments contract (0, .05, .1, .2, .5, inf)", () => {
  assert.deepEqual([...BAND_EDGES], [0, 0.05, 0.1, 0.2, 0.5]);
  assert.deepEqual([0, 0.049, 0.05, 0.099, 0.1, 0.19, 0.2, 0.49, 0.5, 7].map(bandOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(bandLabel(0), "0-5%");
  assert.equal(bandLabel(3), "20-50%");
  assert.equal(bandLabel(4), ">= 50%");
  assert.equal(bandLabel(-1), "new");
});

test("parseSelection: group/centroid/all; centroid text 'id - name' -> id; junk -> all", () => {
  assert.deepEqual(parseSelection("all", ""), { kind: "all" });
  assert.deepEqual(parseSelection("group", "AD Island"), { kind: "group", value: "AD Island" });
  assert.deepEqual(parseSelection("group", ""), { kind: "all" });
  assert.deepEqual(parseSelection("centroid", "44093053 - 1"), { kind: "centroid", value: "44093053" });
  assert.deepEqual(parseSelection("centroid", "44093053"), { kind: "centroid", value: "44093053" });
  assert.deepEqual(parseSelection("centroid", "abc"), { kind: "all" });
  assert.deepEqual(parseSelection("centroid", "1; DROP TABLE x"), { kind: "centroid", value: "1" }); // only the integer survives
  assert.equal(describeSelection({ kind: "centroid", value: "7" }, () => "Seven", "All"), "7 - Seven");
  assert.equal(describeSelection({ kind: "all" }, () => undefined, "All"), "All");
});

test("linesToFc: skips rows without coordinates, sorts largest last, carries style props", () => {
  const rows = [
    { origin: "1", destination: "2", trips: 10, o_lon: 54, o_lat: 24, d_lon: 54.1, d_lat: 24 },
    { origin: "1", destination: "3", trips: 50, o_lon: 54, o_lat: 24, d_lon: 54, d_lat: 24.1 },
    { origin: "1", destination: "4", trips: 99, o_lon: null, o_lat: null, d_lon: 1, d_lat: 1 },
    { origin: "1", destination: "5", trips: -70, o_lon: 54, o_lat: 24, d_lon: 54.2, d_lat: 24 },
  ];
  const fc = linesToFc(rows, (r) => (r.trips < 0 ? "#00f" : "#f00"), (r) => Math.abs(r.trips) / 10, (r) => `to ${r.destination}`);
  assert.equal(fc.features.length, 3);
  assert.deepEqual(fc.features.map((f) => f.properties.tip), ["to 2", "to 3", "to 5"]); // |trips| ascending
  assert.equal(fc.features[2].properties.c, "#00f");
  assert.deepEqual(fc.features[0].geometry.coordinates, [[54, 24], [54.1, 24]]);
  assert.deepEqual(boundsOf(fc), [54, 24, 54.2, 24.1]);
  assert.equal(boundsOf({ type: "FeatureCollection", features: [] }), null);
});

test("csvCell escapes per RFC 4180", () => {
  assert.equal(csvCell("a"), "a");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(3.5), "3.5");
});
