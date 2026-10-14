// Real per-run Testudo package (Jumeira, 5-min micro sim, 15-min observed): obs must be indexed and loaded,
// and the bucket list is 15 min / 30 min / 1 h / whole period.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DetController, type DbLike } from "../src/common/controller.ts";
import { buildIndex, itemsFromManifest } from "../src/common/package-source.ts";
import { bucketOptions, bucketStep, durationLabel, wholePeriod, WHOLE_PERIOD } from "../src/common/sql.ts";
import { openNodeDb } from "./node-db.ts";

const fx = (n: string): Buffer => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const MANIFEST_URL = "https://h/api/v1/analysis-bytes/v/TOK/analysis/1.1---Static-Assignment-Experiment-AM/analysis_manifest.json";
const RUN = "1.1---Static-Assignment-Experiment-AM";
const requested: string[] = [];
const fetchImpl = (async (url: string) => {
  requested.push(String(url));
  const name = decodeURIComponent(String(url).split("/").pop() ?? "");
  if (name === "analysis_manifest.json") return new Response(new Uint8Array(fx("real-run-analysis-manifest.json")));
  try {
    return new Response(new Uint8Array(fx(name)));
  } catch {
    return new Response("nf", { status: 404 });
  }
}) as unknown as typeof fetch;

const settle = async (c: DetController): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((c.state.phase === "ready" && !c.state.busy) || c.state.phase === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("controller did not settle");
};

test("single-run manifest (run only in m.run, no run prefix in paths) indexes obs, sim and geo", () => {
  const m = JSON.parse(fx("real-run-analysis-manifest.json").toString());
  const { items, exclude, observed } = itemsFromManifest(MANIFEST_URL, m, async () => new Uint8Array());
  const idx = buildIndex("x", items, exclude, observed);
  assert.equal(idx.runs.length, 1);
  assert.equal(idx.runs[0].run, RUN);
  assert.ok(idx.runs[0].obs && idx.runs[0].sim && idx.runs[0].geo);
  assert.equal(idx.runs[0].observed?.gridSeconds, 900);
});

test("host open (manifest URL + run) requests detectors_obs.parquet and enables validation", async () => {
  requested.length = 0;
  const { db, close } = await openNodeDb();
  try {
    const c = new DetController({ getDb: async () => db, prefix: "mcm_", fetchImpl });
    assert.equal(await c.loadUrl(MANIFEST_URL, RUN), true, c.state.error ?? "");
    await settle(c);
    assert.ok(requested.some((u) => u.endsWith("/detectors_obs.parquet")), requested.join("\n"));
    assert.equal(c.hasObs, true);
    assert.ok(c.counts.nObs > 0);
    assert.ok(c.rows.length > 0);
    await c.dispose();
  } finally {
    close();
  }
});

/** Jumeira-like micro run: 5-min simulated intervals 06:00-09:15, 15-min observed grid (interval-end), 2 detectors. */
async function microFixture(): Promise<{ sim: Uint8Array; obs: Uint8Array }> {
  const { db, close } = await openNodeDb();
  try {
    await db.exec(`COPY (
      SELECT 1 AS did, 'micro' AS run, d.oid, d.eid, 1 AS ent, 0 AS sid, CAST(m * 60 AS BIGINT) AS interval_start_s, 300 AS duration_s,
             CAST(600 + d.oid AS DOUBLE) AS flow, CAST(50 AS DOUBLE) AS volume
      FROM (VALUES (101, 'D1'), (102, 'D2')) d(oid, eid), range(360, 555, 5) r(m)
    ) TO 'gen_sim.parquet' (FORMAT parquet);
    COPY (
      SELECT d.eid AS detector_id, TIMESTAMP '2020-01-01 00:00:00' + INTERVAL (m + 15) MINUTE AS ts, CAST(500 + d.oid AS DOUBLE) AS flow, 'f' AS source_file
      FROM (VALUES (101, 'D1'), (102, 'D2')) d(oid, eid), range(360, 555, 15) r(m)
    ) TO 'gen_obs.parquet' (FORMAT parquet);`);
    return { sim: new Uint8Array(readFileSync("gen_sim.parquet")), obs: new Uint8Array(readFileSync("gen_obs.parquet")) };
  } finally {
    close();
  }
}

async function microController(db: DbLike): Promise<DetController> {
  const { sim, obs } = await microFixture();
  const manifest = { schema_version: 1, run: "micro", files: [{ path: "detectors_sim.parquet" }, { path: "detectors_obs.parquet" }], observed: { referenceDay: "2020-01-01", gridSeconds: 900, timestampConvention: "interval-end", units: "veh/h" } };
  const f = (async (url: string) => {
    const n = String(url).split("/").pop();
    return new Response(n === "m.json" ? JSON.stringify(manifest) : new Uint8Array(n === "detectors_sim.parquet" ? sim : obs));
  }) as unknown as typeof fetch;
  const c = new DetController({ getDb: async () => db, prefix: "mcm_", fetchImpl: f });
  assert.equal(await c.loadUrl("http://h/m.json"), true, c.state.error ?? "");
  await settle(c);
  return c;
}

test("bucket list for a 5-min sim / 15-min observed run is 15, 30, 60 + whole period", async () => {
  assert.deepEqual(bucketOptions(5, 0, 1440, 15), [15, 30, 60]);
  assert.equal(bucketStep(5, 15), 15);
  const { db, close } = await openNodeDb();
  try {
    const c = await microController(db);
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    assert.deepEqual([c.state.fromMin, c.state.toMin], [360, 555]);
    await c.dispose();
  } finally {
    close();
  }
});

test("wholePeriod: 3 h span, odd spans clamp to complete 15-min intervals", () => {
  assert.deepEqual(wholePeriod(360, 540, 15), { originMin: 360, minutes: 180 });
  assert.deepEqual(wholePeriod(420, 555, 15), { originMin: 420, minutes: 135 }); // 2 h 15 min
  assert.deepEqual(wholePeriod(425, 545, 15), { originMin: 435, minutes: 105 }); // starts on the grid
  assert.deepEqual(wholePeriod(420, 430, 15), null);
  assert.equal(durationLabel(135), "2 h 15 min");
  assert.equal(durationLabel(180), "3 h");
});

test("15 / 30 / 60 / whole-period aggregation: only complete buckets count, whole period is one bucket", async () => {
  const { db, close } = await openNodeDb();
  try {
    const c = await microController(db);
    const run = async (from: number, to: number, b: number) => {
      c.setWindow(from, to);
      c.setBucket(b);
      await settle(c);
      assert.equal(c.state.phase, "ready", c.state.error ?? "");
      return c.rows;
    };
    // 06:00-09:00 (3 h): 12 / 6 / 3 / 1 buckets per detector; two detectors
    assert.equal((await run(360, 540, 15)).length, 2 * 12);
    assert.equal((await run(360, 540, 30)).length, 2 * 6);
    assert.equal((await run(360, 540, 60)).length, 2 * 3);
    const w3 = await run(360, 540, WHOLE_PERIOD);
    assert.equal(w3.length, 2);
    assert.deepEqual(c.whole(), { originMin: 360, minutes: 180 });
    for (const r of w3) {
      assert.equal(r.sim_flow_h, 600 + Number(r.oid));
      assert.equal(r.obs_flow_h, 500 + Number(r.oid));
    }
    // 06:00-08:15 = 2 h 15 min, not a whole number of hours: the 60-min bucket keeps only 2 complete hours, whole period keeps all 135 min
    assert.equal((await run(360, 495, 60)).length, 2 * 2);
    assert.equal((await run(360, 495, WHOLE_PERIOD)).length, 2);
    assert.deepEqual(c.whole(), { originMin: 360, minutes: 135 });
    // a window that does not end on the 15-min grid is clamped to complete intervals (06:00-08:07 -> 2 h)
    assert.equal((await run(360, 487, WHOLE_PERIOD)).length, 2);
    assert.deepEqual(c.whole(), { originMin: 360, minutes: 120 });
    // a window shorter than one interval has no whole period: no rows, no crash
    assert.equal(c.whole(360, 370), null);
    await c.dispose();
  } finally {
    close();
  }
});

test("a detector file whose path is not a recognised name is classified by its manifest table (obs cannot be hidden)", () => {
  const m = {
    schema_version: 1,
    run: "R1",
    files: [
      { table: "detectors_sim", path: "blobs/a1.parquet" },
      { table: "detectors_obs", path: "blobs/b2.parquet" },
      { table: "detectors_geo", path: "blobs/c3.json" },
    ],
  };
  const { items, exclude } = itemsFromManifest("https://h/x/analysis_manifest.json", m, async () => new Uint8Array());
  const r = buildIndex("x", items, exclude).runs;
  assert.equal(r.length, 1);
  assert.ok(r[0].sim && r[0].obs && r[0].geo);
  assert.equal(r[0].run, "R1");
});
