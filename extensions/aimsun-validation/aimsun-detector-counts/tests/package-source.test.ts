import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  classifyPath,
  isSafeRelativePath,
  itemsFromManifest,
  manifestUrlFor,
  resolveUrl,
  sortRuns,
  type RawItem,
} from "../src/common/package-source.ts";
import { buildFeatures, locate, parseDetectorGeo } from "../src/common/geo.ts";
import { aggregateDetectors } from "../src/common/aggregate.ts";

const item = (path: string): RawItem => ({ path, read: async () => new Uint8Array() });

test("classifyPath uses the parent directory as the run", () => {
  assert.deepEqual(classifyPath("data/AMPK_3/detectors_sim.parquet"), { run: "AMPK_3", kind: "sim" });
  assert.deepEqual(classifyPath("AMPK_3\\detectors_obs.parquet"), { run: "AMPK_3", kind: "obs" });
  assert.deepEqual(classifyPath("detectors.geojson"), { run: "", kind: "geo" });
  assert.equal(classifyPath("AMPK_3/plcov/convergence.parquet"), null);
});

test("buildIndex groups runs, orders them, and lists incomplete ones", () => {
  const idx = buildIndex("data", [
    item("data/PMPK_3/detectors_sim.parquet"),
    item("data/PMPK_3/detectors_obs.parquet"),
    item("data/AMPK_3b/detectors_sim.parquet"),
    item("data/AMPK_3b/detectors_obs.parquet"),
    item("data/AMPK_3/detectors_sim.parquet"),
    item("data/AMPK_3/detectors_obs.parquet"),
    item("data/AMPK_3/detectors.geojson"),
    item("data/ZZ/detectors_sim.parquet"),
  ]);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3", "AMPK_3b", "PMPK_3"]);
  assert.ok(idx.runs[0].geo);
  assert.equal(idx.runs[1].geo, null);
  assert.deepEqual(idx.incomplete, ["ZZ"]);
});

test("buildIndex: a single flat run folder, and shared obs/geo fallbacks", () => {
  const flat = buildIndex("myrun", [item("detectors_sim.parquet"), item("detectors_obs.parquet")]);
  assert.deepEqual(flat.runs.map((r) => r.run), ["myrun"]);
  const shared = buildIndex("pkg", [item("detectors_obs.parquet"), item("detectors.geojson"), item("A/detectors_sim.parquet"), item("B/detectors_sim.parquet")]);
  assert.deepEqual(shared.runs.map((r) => r.run), ["A", "B"]);
  assert.ok(shared.runs.every((r) => r.obs && r.geo));
});

test("manifest: outputs_sha256 form, unavailable runs dropped, hashes carried", () => {
  const manifest = {
    schema_version: 1,
    outputs_sha256: {
      "AMPK_3/detectors_sim.parquet": "aa".repeat(32),
      "AMPK_3/detectors_obs.parquet": "bb".repeat(32),
      "PMPK_3b/detectors_sim.parquet": "cc".repeat(32),
      "PMPK_3b/detectors_obs.parquet": "dd".repeat(32),
      "AMPK_3/plcov/convergence.parquet": "ee".repeat(32),
    },
    runs: [
      { run: "AMPK_3", available: true },
      { run: "PMPK_3b", available: false },
    ],
  };
  const { items, exclude } = itemsFromManifest("http://h/data/manifest.json", manifest, async () => new Uint8Array());
  const idx = buildIndex("data", items, exclude);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3"]);
  assert.equal(idx.runs[0].sim.sha256, "aa".repeat(32));
});

test("manifest: files form with run override and flat paths", () => {
  const { items } = itemsFromManifest(
    "http://h/pkg/manifest.json",
    {
      schema_version: 1,
      run: "AMPK_3",
      files: [
        { table: "detectors_sim", path: "detectors_sim.parquet" },
        { table: "detectors_obs", path: "detectors_obs.parquet" },
      ],
    },
    async () => new Uint8Array(),
  );
  assert.deepEqual(buildIndex("p", items).runs.map((r) => r.run), ["AMPK_3"]);
});

test("manifest validation: schema version and unsafe paths", () => {
  const f = async () => new Uint8Array();
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 2, files: [] }, f), /schema_version/);
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 1, files: [{ path: "../x.parquet" }] }, f), /relative/);
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 1, outputs_sha256: { "/abs/x.parquet": "a" } }, f), /unsafe/);
  assert.equal(isSafeRelativePath("http://evil/x"), false);
  assert.equal(isSafeRelativePath("a/b.parquet"), true);
});

test("urls", () => {
  assert.equal(manifestUrlFor("http://h/data/"), "http://h/data/manifest.json");
  assert.equal(manifestUrlFor(" http://h/m.json "), "http://h/m.json");
  assert.throws(() => manifestUrlFor(" "), /empty/);
  assert.equal(resolveUrl("http://h/data/manifest.json", "AMPK_3/a.parquet"), "http://h/data/AMPK_3/a.parquet");
  assert.deepEqual(sortRuns(["PMPK_3", "X", "AMPK_3b", "AMPK_3"]), ["AMPK_3", "AMPK_3b", "PMPK_3", "X"]);
});

test("parseDetectorGeo: Point geometry, x/y fallback, projected metres rejected", () => {
  const g = parseDetectorGeo({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [55.1, 25.2] }, properties: { oid: 10, eid: "E1" } },
      { type: "Feature", geometry: null, properties: { oid: 11, eid: "E2", x: 55.3, y: 25.3 } },
      { type: "Feature", geometry: null, properties: { oid: 12, eid: "E3", x: 350000, y: 2790000 } },
      { type: "Feature", geometry: null, properties: { oid: 13, eid: "E4", x: null, y: null } },
    ],
  });
  assert.equal(g.count, 2);
  assert.deepEqual(g.byOid.get("11"), { lon: 55.3, lat: 25.3 });
  assert.equal(g.byOid.has("12"), false);
  assert.throws(() => parseDetectorGeo({}), /FeatureCollection/);
});

test("locate prefers oid then eid; buildFeatures keeps only located detectors", () => {
  const g = parseDetectorGeo({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { oid: 10, eid: "E1" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [3, 4] }, properties: { oid: 99, eid: "E2" } },
    ],
  });
  assert.deepEqual(locate(g, { id: "zzz", oid: "10" }), { lon: 1, lat: 2 });
  assert.deepEqual(locate(g, { id: "E2", oid: "77" }), { lon: 3, lat: 4 });
  assert.equal(locate(null, { id: "E2", oid: null }), null);
  const aggs = aggregateDetectors([
    { detector_id: "E1", oid: 10, bucket_start_min: 0, sim_flow_h: 100, obs_flow_h: 90, geh: 0, status: "pass" },
    { detector_id: "nope", oid: 5, bucket_start_min: 0, sim_flow_h: 1, obs_flow_h: 1, geh: 0, status: "pass" },
  ]);
  const { fc, located } = buildFeatures(aggs, g);
  assert.equal(located, 1);
  assert.equal(fc.features[0].properties.eid, "E1");
  assert.deepEqual(fc.features[0].geometry.coordinates, [1, 2]);
  assert.equal(buildFeatures(aggs, null).located, 0);
});
