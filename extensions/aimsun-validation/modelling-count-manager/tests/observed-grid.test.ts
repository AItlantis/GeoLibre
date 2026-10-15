// Observed metadata (contract C3): reference day, grid and timestamp convention come from the
// run/analysis manifest; buckets are multiples of BOTH grids; observations land by interval END.
// Jumeira-like fixture: micro 300 s simulation, 15-minute observations on 2020-01-01.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DetController } from "../src/common/controller.ts";
import { bucketOptions, WHOLE_PERIOD, detViewScript, obsGridMinutes, dayProfileObsQuery } from "../src/common/sql.ts";
import { buildIndex, itemsFromManifest, parseObserved } from "../src/common/package-source.ts";
import { openNodeDb } from "./node-db.ts";

const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const enc = (o: unknown): ArrayBuffer => ab(new TextEncoder().encode(JSON.stringify(o)));
type Db = Awaited<ReturnType<typeof openNodeDb>>["db"];

/** E1: sim 600 veh/h flat, obs 540. E2: sim 1200 flat; obs 1200 except the 07:15-07:30 interval (600). */
async function jumeira(db: Db, opts: { obsDay?: string; extraSimSql?: string } = {}): Promise<{ sim: Uint8Array; obs: Uint8Array }> {
  const day = opts.obsDay ?? "2020-01-01";
  await db.exec(`
CREATE TABLE j_sim AS
SELECT 294179 AS did, 'MICRO' AS run, oid, eid, ent, 0 AS sid, 25200 + (ent - 1) * 300 AS interval_start_s, 300 AS duration_s,
       flow, flow * 300 / 3600.0 AS volume
FROM (VALUES (1, 'E1', 600.0), (2, 'E2', 1200.0)) d(oid, eid, flow), range(1, 13) t(ent);
INSERT INTO j_sim SELECT did, run, oid, eid, ent, 1, interval_start_s, duration_s, 9999.0, 9999.0 FROM j_sim;
${opts.extraSimSql ?? ""}
CREATE TABLE j_obs AS
SELECT d AS detector_id, TIMESTAMP '${day} 07:00:00' + to_minutes(15 * (i + 1)) AS ts,
       CASE WHEN d = 'E1' THEN 540.0 WHEN i = 1 THEN 600.0 ELSE 1200.0 END AS flow, 'validation' AS source_file
FROM (VALUES ('E1'), ('E2')) x(d), range(0, 4) t(i);
COPY j_sim TO 'jsim.parquet' (FORMAT parquet);
COPY j_obs TO 'jobs.parquet' (FORMAT parquet);
`);
  return { sim: new Uint8Array(readFileSync("jsim.parquet")), obs: new Uint8Array(readFileSync("jobs.parquet")) };
}

const OBSERVED = { referenceDay: "2020-01-01", gridSeconds: 900, units: "veh/h", timestampConvention: "interval-end", source: "pattern_rds_4.csv" };

const files = (sim: Uint8Array, obs: Uint8Array, meta?: unknown) => [
  { path: "data/MICRO/detectors_sim.parquet", arrayBuffer: async () => ab(sim) },
  { path: "data/MICRO/detectors_obs.parquet", arrayBuffer: async () => ab(obs) },
  ...(meta === undefined ? [] : [{ path: "data/MICRO/analysis_manifest.json", arrayBuffer: async () => enc(meta) }]),
];

const settle = async (c: DetController): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((c.state.phase === "ready" && !c.state.busy) || c.state.phase === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("controller did not settle");
};

test("bucketOptions: multiples of both the simulated interval and the observed grid", () => {
  assert.deepEqual(bucketOptions(5, 420, 480, 15), [15, 30, 60]); // 5-min bucket NOT offered; 45 does not align
  assert.deepEqual(bucketOptions(5, 420, 480), [5, 10, 15, 20, 30, 60]); // legacy: sim grid only, conventional buckets (no 35)
  assert.deepEqual(bucketOptions(60, 420, 660, 15), [60]); // hourly sim: unchanged
  assert.deepEqual(bucketOptions(60, 0, 240, 5), bucketOptions(60, 0, 240));
  assert.deepEqual(bucketOptions(5, 0, 120, 60), [60, 120]); // hourly observations
});

test("parseObserved validates and defaults; detViewScript maps it onto the adapter", () => {
  assert.equal(parseObserved(undefined), undefined);
  assert.deepEqual(parseObserved(OBSERVED), { ...OBSERVED, source: "pattern_rds_4.csv" });
  assert.throws(() => parseObserved({ ...OBSERVED, referenceDay: "01/01/2020" }), /referenceDay/);
  assert.throws(() => parseObserved({ ...OBSERVED, gridSeconds: 90 }), /gridSeconds/);
  assert.throws(() => parseObserved({ ...OBSERVED, units: "veh" }), /units/);
  assert.throws(() => parseObserved({ ...OBSERVED, timestampConvention: "middle" }), /timestampConvention/);
  assert.throws(() => obsGridMinutes({ gridSeconds: 30 }), /minutes/);
  const s = detViewScript({ prefix: "mcm_", obsSource: "both", bucketMinutes: 15, observed: parseObserved(OBSERVED) });
  assert.match(s, /TIMESTAMP '2020-01-01 00:00:00'/);
  assert.match(s, /- 15\b/);
  assert.match(s, /15 AS dur_min/);
  const legacy = detViewScript({ prefix: "mcm_", obsSource: "both", bucketMinutes: 60 });
  assert.match(legacy, /TIMESTAMP '2025-01-01 00:00:00'/);
  assert.match(legacy, /5 AS dur_min/);
  assert.match(dayProfileObsQuery("mean", undefined, 15), /o\.dur_min = 15 .*LIMIT 96/);
  assert.match(dayProfileObsQuery("mean"), /o\.dur_min = 5 .*LIMIT 288/);
});

test("manifest: observed read at top level and per run; invalid blocks fail loudly", () => {
  const m = { schema_version: 1, observed: OBSERVED, runs: [{ run: "MICRO", observed: { ...OBSERVED, gridSeconds: 3600 } }], files: [{ path: "MICRO/detectors_sim.parquet" }] };
  const { items, observed } = itemsFromManifest("https://h/p/manifest.json", m, async () => new Uint8Array());
  assert.equal(observed.shared?.gridSeconds, 900);
  assert.equal(observed.byRun.get("MICRO")?.gridSeconds, 3600);
  const idx = buildIndex("p", items, new Set(), observed);
  assert.equal(idx.runs[0].observed?.gridSeconds, 3600, "per-run entry wins over the shared block");
  assert.throws(() => itemsFromManifest("https://h/p/manifest.json", { schema_version: 1, observed: { referenceDay: "x" } }, async () => new Uint8Array()), /referenceDay/);
});

test("Jumeira-like: micro 5-min sim vs 15-min observed on 2020-01-01 (analysis_manifest.json)", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await jumeira(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed: OBSERVED }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.observed?.referenceDay, "2020-01-01");
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    assert.ok(!c.state.bucketOptions.includes(5), "the 5-minute bucket is not offered");
    assert.equal(c.state.bucket, 60, "hourly is the default when offered");
    assert.deepEqual([c.state.fromMin, c.state.toMin], [420, 480]);
    // hourly: sim = mean of 12 five-minute rates (sid 0 only), obs = mean of 4 quarter-hours
    const h = Object.fromEntries(c.rows.map((r) => [r.detector_id, [r.sim_flow_h, r.obs_flow_h]]));
    assert.deepEqual(h.E1, [600, 540]);
    assert.deepEqual(h.E2, [1200, 1050]); // (1200*3 + 600) / 4
    assert.equal(c.rows.length, 2);
    // 15-min buckets: 4 per detector, observations by interval END (07:15 stamp -> bucket 420)
    c.setBucket(15);
    await settle(c);
    assert.equal(c.rows.length, 8);
    const e2 = c.rows.filter((r) => r.detector_id === "E2").sort((a, b) => a.bucket_start_min - b.bucket_start_min);
    assert.deepEqual(e2.map((r) => [r.bucket_start_min, r.sim_flow_h, r.obs_flow_h]), [[420, 1200, 1200], [435, 1200, 600], [450, 1200, 1200], [465, 1200, 1200]]);
    assert.equal(c.dayProfiles.mean.observed.length, 4, "observed profile uses the 15-minute grid");
    assert.deepEqual(c.dayProfiles.mean.observed.map((p) => p.minute), [420, 435, 450, 465]);
    await c.dispose();
  } finally {
    close();
  }
});

test("observed from the manifest entry (URL path) behaves like analysis_manifest.json; wrong day matches nothing", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await jumeira(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    const idx = buildIndex("pkg", files(sim, obs).map((f) => ({ path: f.path, read: async () => new Uint8Array(await f.arrayBuffer()) })), new Set(), { byRun: new Map([["MICRO", parseObserved(OBSERVED)!]]) });
    await (c as unknown as { openIndex(i: typeof idx): Promise<void> }).openIndex(idx);
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    assert.equal(c.rows.length, 2);
    await c.dispose();
    // Same data but declared on another reference day: nothing lines up (no silent 2025 fallback).
    const c2 = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c2.loadFiles(files(sim, obs, { observed: { ...OBSERVED, referenceDay: "2025-01-01" } }), "data");
    await settle(c2);
    assert.equal(c2.rows.length, 0);
    await c2.dispose();
  } finally {
    close();
  }
});

test("invalid observed block is reported as an error, not ignored", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await jumeira(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed: { ...OBSERVED, gridSeconds: 100 } }), "data");
    await settle(c);
    assert.equal(c.state.phase, "error");
    assert.match(c.state.error ?? "", /gridSeconds/);
    await c.dispose();
  } finally {
    close();
  }
});

test("no `observed`: legacy defaults (2025-01-01, 5-minute grid) are unchanged", async () => {
  const { db, close } = await openNodeDb();
  try {
    await db.exec(`
CREATE TABLE l_sim AS SELECT * FROM (VALUES (1, 'E1', 0, 25200, 3600, 100.0)) t(oid, eid, sid, interval_start_s, duration_s, flow);
CREATE TABLE l_obs AS SELECT 'E1' AS detector_id, ts, 90.0 AS flow, 'validation' AS source_file
  FROM (SELECT unnest(generate_series(TIMESTAMP '2025-01-01 07:05:00', TIMESTAMP '2025-01-01 08:00:00', INTERVAL 5 MINUTE)) AS ts);
COPY l_sim TO 'lsim.parquet' (FORMAT parquet);
COPY l_obs TO 'lobs.parquet' (FORMAT parquet);`);
    const sim = new Uint8Array(readFileSync("lsim.parquet"));
    const obs = new Uint8Array(readFileSync("lobs.parquet"));
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs), "data");
    await settle(c);
    assert.equal(c.observed, null);
    assert.deepEqual(c.state.bucketOptions, [60, WHOLE_PERIOD]);
    assert.deepEqual(c.rows.map((r) => [r.detector_id, r.sim_flow_h, r.obs_flow_h]), [["E1", 100, 90]]);
    assert.equal(c.dayProfiles.mean.observed.length, 12);
    await c.dispose();
  } finally {
    close();
  }
});

test("detectors_sim mixing micro 300 s and macro 3600 s rows: finest rows only, no double counting", async () => {
  const { db, close } = await openNodeDb();
  try {
    const macro = "INSERT INTO j_sim VALUES (294180, 'MACRO', 1, 'E1', 1, 0, 25200, 3600, 3000.0, 3000.0), (294180, 'MACRO', 1, 'E1', 1, 1, 25200, 3600, 7000.0, 7000.0);";
    const { sim, obs } = await jumeira(db, { extraSimSql: macro });
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed: OBSERVED }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    const e1 = c.rows.find((r) => r.detector_id === "E1")!;
    assert.deepEqual([e1.sim_flow_h, e1.obs_flow_h], [600, 540]);
    await c.dispose();
  } finally {
    close();
  }
});
