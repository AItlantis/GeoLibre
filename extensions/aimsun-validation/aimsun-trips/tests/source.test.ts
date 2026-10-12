import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, classifyPath, indexFromManifestUrl, isSafeRelativePath, itemsFromManifest, manifestUrlFor, sortRuns, type RawItem } from "../../_od/source.ts";

const item = (path: string, run?: string): RawItem => ({ path, run, src: { name: path, kind: "url", url: `http://x/${path}` } });

test("classifyPath / sortRuns / manifestUrlFor / isSafeRelativePath", () => {
  assert.deepEqual(classifyPath("data/AMPK_3/od_before.parquet"), { run: "AMPK_3", kind: "before" });
  assert.deepEqual(classifyPath("PMPK_3\\groupings.parquet"), { run: "PMPK_3", kind: "groupings" });
  assert.equal(classifyPath("data/_aconsole_raw/AMPK_3/od_before.csv"), null);
  assert.deepEqual(classifyPath("od_after.parquet"), { run: "", kind: "after" });
  assert.deepEqual(sortRuns(["PMPK_3", "Z", "AMPK_3b", "AMPK_3"]), ["AMPK_3", "AMPK_3b", "PMPK_3", "Z"]);
  assert.equal(manifestUrlFor("http://h/data/"), "http://h/data/manifest.json");
  assert.equal(manifestUrlFor(" http://h/m.json "), "http://h/m.json");
  assert.throws(() => manifestUrlFor(" "));
  for (const bad of ["../x", "/abs", "http://e/x", "a\\b", "", 5]) assert.equal(isSafeRelativePath(bad), false);
  assert.equal(isSafeRelativePath("AMPK_3/od_before.parquet"), true);
});

test("buildIndex: runs in contract order, shared root files fill gaps, incomplete runs reported", () => {
  const idx = buildIndex("pkg", [
    item("PMPK_3/od_before.parquet"), item("PMPK_3/od_after.parquet"), item("PMPK_3/centroids.geojson"),
    item("AMPK_3/od_before.parquet"), item("AMPK_3/od_after.parquet"), item("AMPK_3/groupings.parquet"),
    item("centroids.geojson"), // shared
    item("AMPK_3b/od_before.parquet"), // no after -> incomplete
  ]);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3", "PMPK_3"]);
  assert.equal(idx.runs[0].centroids.name, "centroids.geojson"); // from shared
  assert.equal(idx.runs[0].groupings?.name, "AMPK_3/groupings.parquet");
  assert.equal(idx.runs[1].groupings, null);
  assert.deepEqual(idx.incomplete.map((i) => [i.run, i.missing]), [["AMPK_3b", ["after"]]]);
  const flat = buildIndex("one", [item("od_before.parquet"), item("od_after.parquet"), item("centroids.geojson")]);
  assert.deepEqual(flat.runs.map((r) => r.run), ["one"]);
  assert.equal(buildIndex("x", [item("detectors_sim.parquet")]).runs.length, 0);
  const ex = buildIndex("x", [item("A/od_before.parquet"), item("A/od_after.parquet"), item("A/centroids.geojson")], new Set(["A"]));
  assert.equal(ex.runs.length, 0);
});

test("manifest: aconsole fragment (outputs relative to the run folder, run from manifest.run)", async () => {
  const m = { schema_version: 1, run: "AMPK_3", outputs: { "od_before.parquet": { sha256: "aa" }, "od_after.parquet": { sha256: "bb" }, "centroids.geojson": { sha256: "cc" }, "groupings.parquet": {}, "detectors.geojson": {} } };
  const { items, exclude } = await itemsFromManifest("http://h/data/AMPK_3/manifest_aconsole.json", m, async () => assert.fail("no probe needed"));
  const idx = buildIndex("l", items, exclude);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3"]);
  assert.equal(idx.runs[0].before.url, "http://h/data/AMPK_3/od_before.parquet");
  assert.equal(idx.runs[0].before.sha256, "aa");
});

test("manifest: tabular fragment (runs list, no OD paths) is probed by convention; unavailable runs dropped", async () => {
  const m = { schema_version: 1, outputs_sha256: { "AMPK_3/detectors_sim.parquet": "x" }, runs: [{ run: "AMPK_3", available: true }, { run: "PMPK_3b", available: false }, { run: "PMPK_3", available: true }] };
  const probed: string[] = [];
  const have = new Set(["http://h/d/AMPK_3/od_before.parquet", "http://h/d/AMPK_3/od_after.parquet", "http://h/d/AMPK_3/centroids.geojson", "http://h/d/PMPK_3/od_before.parquet", "http://h/d/PMPK_3/od_after.parquet", "http://h/d/PMPK_3/centroids.geojson", "http://h/d/PMPK_3/groupings.parquet"]);
  const { items, exclude } = await itemsFromManifest("http://h/d/manifest_tabular.json", m, async (u) => (probed.push(u), have.has(u)));
  const idx = buildIndex("l", items, exclude);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3", "PMPK_3"]);
  assert.equal(idx.runs[0].groupings, null); // AMPK_3 has no groupings in this fake
  assert.ok(idx.runs[1].groupings);
  assert.ok(!probed.some((u) => u.includes("PMPK_3b")));
});

test("manifest: rejects bad schema_version and unsafe paths", async () => {
  await assert.rejects(itemsFromManifest("http://h/m.json", { schema_version: 2 }, async () => false), /schema_version/);
  await assert.rejects(itemsFromManifest("http://h/m.json", { schema_version: 1, files: [{ path: "../x/od_before.parquet" }] }, async () => false), /relative/);
  await assert.rejects(itemsFromManifest("http://h/m.json", { schema_version: 1, outputs_sha256: { "/abs/od_before.parquet": "x" } }, async () => false), /unsafe/);
  await assert.rejects(itemsFromManifest("http://h/m.json", null, async () => false), /not an object/);
});

test("indexFromManifestUrl: HTTP error surfaces; HEAD probing goes through the injected fetch", async () => {
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("manifest.json")) return new Response(JSON.stringify({ schema_version: 1, runs: [{ run: "AMPK_3" }] }), { status: 200 });
    if (init?.method === "HEAD" && u.includes("AMPK_3/")) return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const idx = await indexFromManifestUrl("http://h/d/", f);
  assert.deepEqual(idx.runs.map((r) => r.run), ["AMPK_3"]);
  await assert.rejects(indexFromManifestUrl("http://h/missing.json", (async () => new Response(null, { status: 404 })) as typeof fetch), /HTTP 404/);
});
