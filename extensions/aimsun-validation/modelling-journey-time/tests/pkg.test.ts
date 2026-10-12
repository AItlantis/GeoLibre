import test from "node:test";
import assert from "node:assert/strict";
import { canonicalTable, parseSubpathGeoJson, planFiles, subpathRefs } from "../src/pkg.ts";
import { interpolate, makeTranslator } from "../src/i18n.ts";
import type { HostApp } from "../src/host.ts";

test("canonicalTable: known names and the subpaths_geo alias, case-insensitive", () => {
  assert.equal(canonicalTable("subpath_obs_jt"), "subpath_obs_jt");
  assert.equal(canonicalTable("Subpath_Sim_JT"), "subpath_sim_jt");
  assert.equal(canonicalTable("subpaths_geo"), "subpaths");
  assert.equal(canonicalTable("detectors_sim"), null);
});

test("parseSubpathGeoJson: keeps line features, counts the rest, rejects non-FeatureCollections", () => {
  const { fc, skipped } = parseSubpathGeoJson({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { name: "a" } },
      { type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]] }, properties: { name: "b" } },
      { type: "Feature", geometry: null, properties: { name: "c" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "d" } },
    ],
  });
  assert.equal(fc.features.length, 2);
  assert.equal(skipped, 2);
  assert.throws(() => parseSubpathGeoJson({ type: "Feature" }), /FeatureCollection/);
});

test("subpathRefs: id/name/group and the per-run exists flag (null when absent)", () => {
  const refs = subpathRefs({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: 9, geometry: null, properties: { id: 47280708, name: "Al Ain Road_In", group_label: "Journey Time routes - HSMe", exists_in_run_scenario: false } },
      { type: "Feature", id: 10, geometry: null, properties: { name: "AD01_b" } },
    ],
  });
  assert.deepEqual(refs, [
    { id: 47280708, name: "Al Ain Road_In", group: "Journey Time routes - HSMe", exists: false },
    { id: 10, name: "AD01_b", group: null, exists: null },
  ]);
  assert.deepEqual(subpathRefs(null), []);
});

test("planFiles: stems without a manifest; manifest wins and maps aliases; unrelated files ignored", () => {
  const names = ["pkg/subpath_obs_jt.parquet", "pkg/subpaths.geojson", "pkg/detectors_sim.parquet", "pkg/readme.txt"];
  assert.deepEqual(
    planFiles(names).map((p) => [p.name, p.table]),
    [
      ["pkg/subpath_obs_jt.parquet", "subpath_obs_jt"],
      ["pkg/subpaths.geojson", "subpaths"],
    ],
  );
  const manifest = {
    schema_version: 1 as const,
    files: [
      { table: "subpaths_geo", path: "geo/lines.geojson", sha256: "abc", rows: 3 },
      { table: "subpath_sim_jt", path: "sim.parquet" },
      { table: "od_before", path: "od_before.parquet" },
    ],
  };
  const plan = planFiles(["x/lines.geojson", "x/sim.parquet", "x/od_before.parquet"], manifest);
  assert.deepEqual(plan, [
    { name: "x/lines.geojson", table: "subpaths", sha256: "abc", rows: 3 },
    { name: "x/sim.parquet", table: "subpath_sim_jt", sha256: undefined, rows: undefined },
  ]);
});

test("planFiles preserves run-labelled simulated JT tables from one multi-run manifest", () => {
  const manifest = { schema_version: 1 as const, files: [
    { table: "subpath_sim_jt", path: "data/JT_A/subpath_sim_jt.parquet" },
    { table: "subpath_sim_jt", path: "data/JT_B/subpath_sim_jt.parquet" },
  ] };
  const plan = planFiles(["pkg/data/JT_A/subpath_sim_jt.parquet", "pkg/data/JT_B/subpath_sim_jt.parquet"], manifest);
  assert.deepEqual(plan.map((p) => [p.name, p.table, p.run]), [
    ["pkg/data/JT_A/subpath_sim_jt.parquet", "subpath_sim_jt", "JT_A"],
    ["pkg/data/JT_B/subpath_sim_jt.parquet", "subpath_sim_jt", "JT_B"],
  ]);
});

test("i18n: host translate wins, English default + interpolation otherwise, keys are namespaced", () => {
  assert.equal(interpolate("{{n}} days, {{x}}", { n: 3 }), "3 days, {{x}}");
  const seen: string[] = [];
  let app: HostApp | null = null;
  const t = makeTranslator("my-plugin", () => app);
  assert.equal(t("a", "Hello {{n}}", { n: 2 }), "Hello 2"); // no app yet
  app = { addGeoJsonLayer: () => "x", translate: (k, d) => (seen.push(k), `[${d}]`), getLocale: () => "ar" };
  assert.equal(t("a", "Hello"), "[Hello]");
  assert.deepEqual(seen, ["plugin.my-plugin.a"]);
  assert.equal(t.locale(), "ar");
  app = { addGeoJsonLayer: () => "x", translate: () => "" }; // empty translation -> default
  assert.equal(t("a", "Fallback"), "Fallback");
});
