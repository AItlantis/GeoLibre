// DetController against the REAL AMPK_3 package (data root: $AIMSUN_DATA_DIR; when
// unset: skipped). Skipped when absent. Same SQL as the wasm build.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DetController, withLock } from "../src/common/controller.ts";
import { computeKpis } from "../src/common/aggregate.ts";
import { openNodeDb } from "./node-db.ts";

const ROOT = process.env.AIMSUN_DATA_DIR ?? "";
const have = !!ROOT && existsSync(join(ROOT, "AMPK_3", "detectors_sim.parquet"));
const skip = !have && `no data in ${ROOT}`;

const folderItems = (withGeo = true) => {
  const out: Array<{ path: string; arrayBuffer: () => Promise<ArrayBuffer> }> = [];
  for (const run of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(ROOT, run.name))) {
      const p = join(ROOT, run.name, f);
      if (!f.endsWith(".parquet") && !(withGeo && f === "detectors.geojson")) continue;
      out.push({ path: `data/${run.name}/${f}`, arrayBuffer: async () => new Uint8Array(readFileSync(p)).buffer as ArrayBuffer });
    }
  }
  return out;
};

const settle = async (c: DetController): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((c.state.phase === "ready" && !c.state.busy) || c.state.phase === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("controller did not settle");
};

test("folder load: AMPK_3 validation summary matches the shared view (n=509, r2~0.989, %GEH<5~54.4)", { skip }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(folderItems(), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual(c.state.runs, ["AMPK_3", "AMPK_3b", "PMPK_3"]);
    assert.equal(c.state.run, "AMPK_3");
    assert.deepEqual([c.state.fromMin, c.state.toMin, c.state.bucket], [420, 480, 60]);
    assert.deepEqual(c.state.bucketOptions, [60]);
    assert.equal(c.hasGeo, existsSync(join(ROOT, "AMPK_3", "detectors.geojson")));
    assert.equal(c.rows.length, 509);
    assert.equal(c.unmatched.length, 51, "AMPK_3: 51 simulated detectors with flow have no eid");

    const k = computeKpis(c.rows);
    assert.equal(k.n, 509);
    assert.ok(Math.abs(k.r2! - 0.989) < 0.002, `r2 ${k.r2}`);
    assert.ok(Math.abs(k.pctGehLt5! - 54.4) < 0.1, `pct ${k.pctGehLt5}`);

    // the TS KPIs must agree with the shared SQL summary view
    const sum = (await db.query<Record<string, unknown>>("SELECT * FROM v_det_summary"))[0];
    assert.equal(Number(sum.n), k.n);
    for (const [js, sql] of [[k.rmse, "rmse"], [k.mae, "mae"], [k.bias, "bias"], [k.r2, "r2"], [k.slope, "slope"], [k.pctGehLt5, "pct_geh_lt5"]] as const) {
      assert.ok(Math.abs(js! - Number(sum[sql])) < 1e-6, `${sql}: ${js} vs ${sum[sql]}`);
    }
    assert.equal(c.aggs.length, 509); // one bucket: one row per detector
    assert.equal(c.dayProfiles.mean.observed.length, 288);
    assert.ok(c.dayProfiles.mean.simulated.length > 0);
    assert.deepEqual([c.dayProfiles.mean.simulated[0].startMin, c.dayProfiles.mean.simulated.at(-1)?.endMin], [420, 480]);
    assert.ok(c.counts.nSim >= 509 && c.counts.nObs >= 509);
    await c.dispose();
  } finally {
    close();
  }
});

test("comparison lazily caches compact run snapshots and reports differing observed windows", { skip }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(folderItems(), "data");
    c.setWindow(420, 470);
    await settle(c);
    const runs = await c.loadComparisonRuns();
    assert.deepEqual(runs.map((r) => r.run), ["AMPK_3", "AMPK_3b", "PMPK_3"]);
    assert.ok(runs.every((r) => r.rows.length > 0 && r.detectors.length > 0));
    const am = runs.find((r) => r.run === "AMPK_3")!;
    const pm = runs.find((r) => r.run === "PMPK_3")!;
    assert.notDeepEqual([am.startMin, am.endMin], [pm.startMin, pm.endMin]);
    assert.equal(c.state.run, "AMPK_3", "the user's active run is restored after comparison data loads");
    assert.deepEqual([c.state.fromMin, c.state.toMin], [420, 470], "the active run window is preserved");
    assert.strictEqual(await c.loadComparisonRuns(), runs, "subsequent mode switches reuse snapshots without reloading runs");
    await c.dispose();
  } finally { close(); }
});

test("degraded mode: no detectors.geojson in the package still gives rows, KPIs and no geometry", { skip }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(folderItems(false), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.hasGeo, false);
    assert.equal(c.geo, null);
    assert.equal(c.rows.length, 509);
    await c.dispose();
  } finally {
    close();
  }
});

test("with geometry: detectors are located by oid/eid", { skip: skip || (!ROOT || !existsSync(join(ROOT, "AMPK_3", "detectors.geojson")) && "no detectors.geojson yet") }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(folderItems(true), "data");
    await settle(c);
    assert.equal(c.hasGeo, true);
    const { buildFeatures } = await import("../src/common/geo.ts");
    const { located, fc } = buildFeatures(c.aggs, c.geo);
    assert.ok(located / c.aggs.length > 0.9, `located ${located}/${c.aggs.length}`);
    const [lon, lat] = fc.features[0].geometry.coordinates;
    assert.ok(lon > 50 && lon < 60 && lat > 20 && lat < 30, `${lon},${lat}`);
    await c.dispose();
  } finally {
    close();
  }
});

test("run switch, observed source and window re-query", { skip }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(folderItems(), "data");
    await settle(c);
    const nBoth = c.rows.length;

    c.setObsSource("validation");
    await settle(c);
    const nVal = c.rows.length;
    assert.ok(nVal > 0 && nVal <= nBoth, `validation-only ${nVal} vs both ${nBoth}`);
    c.setObsSource("calibration");
    await settle(c);
    assert.ok(c.rows.length > 0 && c.rows.length <= nBoth);
    c.setObsSource("both");
    await settle(c);
    assert.equal(c.rows.length, nBoth);

    // a window that misses the simulated hour is empty, not an error
    c.setWindow(0, 60);
    await settle(c);
    assert.equal(c.state.phase, "ready");
    assert.equal(c.rows.length, 0);
    c.setWindow(420, 480);
    await settle(c);
    assert.equal(c.rows.length, nBoth);

    await c.selectRun("PMPK_3");
    await settle(c);
    assert.equal(c.state.run, "PMPK_3");
    assert.deepEqual([c.state.fromMin, c.state.toMin], [1020, 1080]);
    assert.ok(c.rows.length > 400);
    await c.dispose();
  } finally {
    close();
  }
});

test("manifest URL load (fetch stub over the data folder) verifies sha256 and drops unavailable runs", { skip }, async () => {
  const { db, close } = await openNodeDb();
  try {
    const fetchImpl = (async (url: string) => {
      const rel = decodeURIComponent(new URL(url).pathname.replace(/^\/data\//, ""));
      const p = join(ROOT, rel);
      if (!existsSync(p)) return new Response("nf", { status: 404 });
      return new Response(readFileSync(p));
    }) as unknown as typeof fetch;
    const c = new DetController({ getDb: async () => db, prefix: "mcm_", fetchImpl });
    await c.loadUrl("http://localhost/data/manifest_tabular.json", "PMPK_3");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.state.run, "PMPK_3");
    assert.ok(!c.state.runs.includes("PMPK_3b"));
    assert.equal(c.packageUrl, "http://localhost/data/manifest_tabular.json");
    await c.dispose();

    const bad = new DetController({
      getDb: async () => db,
      prefix: "mcm_",
      fetchImpl: (async (url: string) =>
        String(url).endsWith("manifest_tabular.json")
          ? new Response(readFileSync(join(ROOT, "manifest_tabular.json")))
          : new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
    });
    await bad.loadUrl("http://localhost/data/manifest_tabular.json");
    await settle(bad);
    assert.equal(bad.state.phase, "error");
    assert.match(bad.state.error ?? "", /sha256 mismatch/);
  } finally {
    close();
  }
});

test("a package with no detector tables fails loudly", async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles([{ path: "x/readme.txt", arrayBuffer: async () => new ArrayBuffer(0) }]);
    assert.equal(c.state.phase, "error");
    assert.match(c.state.error ?? "", /No available detector view.*detectors_sim\.parquet.*detectors_obs\.parquet/);
  } finally {
    close();
  }
});

test("withLock serialises overlapping work", async () => {
  const order: string[] = [];
  const a = withLock(async () => {
    order.push("a1");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a2");
  });
  const b = withLock(async () => {
    order.push("b1");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
  // a failing task does not poison the chain
  await assert.rejects(withLock(async () => Promise.reject(new Error("x"))));
  await withLock(async () => order.push("after"));
  assert.equal(order.at(-1), "after");
});

