// Runs the SQL views against tiny in-memory data using the NATIVE DuckDB node package
// (@duckdb/node-api). The SQL is the same engine family as duckdb-wasm; the wasm path itself
// is exercised only in a browser (see README "Verification").
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql, VIEWS_SQL, VIEW_NAMES } from "../src/sql/views.sql.ts";
import { geh, haversineKm, regressionStats, hourlyFlowOver } from "../src/metrics.ts";

// The fixture below holds vehicle COUNTS per interval, so the count path is selected explicitly.
// (The default contract is flowKind "rate": see the rate tests at the end of the file.)
const COUNT_OPTS = { simFlowKind: "count", obsFlowKind: "count" } as const;
const COUNT_SQL = buildViewsSql(COUNT_OPTS);

let conn: DuckDBConnection;

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runScript(sql: string) {
  for (const s of statements(sql)) await conn.run(s);
}

async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson() as T[];
}

const num = (v: unknown) => Number(v);

before(async () => {
  const inst = await DuckDBInstance.create(":memory:");
  conn = await inst.connect();
  await runScript(`
    CREATE TABLE od_before(origin INTEGER, destination INTEGER, trips DOUBLE);
    CREATE TABLE od_after (origin INTEGER, destination INTEGER, trips DOUBLE);
    INSERT INTO od_before VALUES (1,2,100),(1,3,50),(2,3,0),(3,1,10);
    INSERT INTO od_after  VALUES (1,2,150),(1,4,20),(2,3,0),(3,1,10);
    CREATE TABLE centroids(id INTEGER, name VARCHAR, grp VARCHAR, lon DOUBLE, lat DOUBLE);
    INSERT INTO centroids VALUES (1,'a','N',0,0),(2,'b','N',0,1),(3,'c','S',1,0),(4,'d','S',1,1);
    CREATE TABLE detectors_sim(oid INTEGER, eid VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    CREATE TABLE detectors_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    -- D1: 4 x 15 min in hour 0 (sim 275 each = 1100 vph; obs 250 each = 1000 vph)
    INSERT INTO detectors_sim VALUES (11,'D1',0,15,275),(11,'D1',15,15,275),(11,'D1',30,15,275),(11,'D1',45,15,275);
    INSERT INTO detectors_obs VALUES ('D1',0,15,250),('D1',15,15,250),('D1',30,15,250),('D1',45,15,250);
    -- D2: one hour, sim 500 vs obs 1000
    INSERT INTO detectors_sim VALUES (12,'D2',0,60,500);
    INSERT INTO detectors_obs VALUES ('D2',0,60,1000);
    -- D3: both zero
    INSERT INTO detectors_sim VALUES (13,'D3',0,60,0);
    INSERT INTO detectors_obs VALUES ('D3',0,60,0);
    -- D4: obs zero, sim 100 (rel_error NULL)
    INSERT INTO detectors_sim VALUES (14,'D4',0,60,100);
    INSERT INTO detectors_obs VALUES ('D4',0,60,0);
    -- D5: partial coverage (only 30 min of obs) -> dropped
    INSERT INTO detectors_sim VALUES (15,'D5',0,60,100);
    INSERT INTO detectors_obs VALUES ('D5',0,30,50);
    -- D6: sim only (no observed) -> dropped
    INSERT INTO detectors_sim VALUES (16,'D6',0,60,100);
  `);
  await runScript(COUNT_SQL);
});

after(() => conn.closeSync());

test("all views exist", async () => {
  for (const v of VIEW_NAMES) await rows(`SELECT * FROM ${v} LIMIT 1`);
});

test("v_od_diff with zero-denominator handling", async () => {
  const r = await rows(`SELECT * FROM v_od_diff ORDER BY origin, destination`);
  const key = (o: number, d: number) => r.find((x) => num(x.origin) === o && num(x.destination) === d)!;
  assert.equal(r.length, 5);
  assert.equal(num(key(1, 2).delta), 50);
  assert.equal(num(key(1, 2).deviation_ratio), 0.5);
  assert.equal(num(key(1, 3).after), 0); // removed flow
  assert.equal(num(key(1, 3).deviation_ratio), -1);
  assert.equal(key(1, 4).deviation_ratio, null); // before = 0, after > 0
  assert.equal(key(1, 4).is_new_flow, true);
  assert.equal(num(key(2, 3).deviation_ratio), 0); // 0 -> 0
  assert.equal(num(key(3, 1).delta), 0);
});

test("v_od_group_agg", async () => {
  const r = await rows(`SELECT * FROM v_od_group_agg ORDER BY origin_group, destination_group`);
  const g = (o: string, d: string) => r.find((x) => x.origin_group === o && x.destination_group === d)!;
  // N->N: (1,2) 100->150 ; N->S: (1,3) 50->0, (1,4) 0->20, (2,3) 0->0 ; S->N: (3,1) 10->10
  assert.equal(num(g("N", "N").before), 100);
  assert.equal(num(g("N", "N").after), 150);
  assert.equal(num(g("N", "S").before), 50);
  assert.equal(num(g("N", "S").after), 20);
  assert.equal(num(g("N", "S").delta), -30);
  assert.equal(num(g("N", "S").deviation_ratio), -0.6);
  assert.equal(num(g("S", "N").deviation_ratio), 0);
});

test("v_trip_length matches TS haversine and bins", async () => {
  const od = await rows(`SELECT * FROM v_trip_length_od WHERE scenario='before' AND origin=1 AND destination=2`);
  assert.equal(od.length, 1);
  assert.ok(Math.abs(num(od[0].dist_km) - haversineKm(0, 0, 1, 0)) < 1e-6);
  // pair (2,3) has 0 trips -> excluded; histogram share sums to 1 per scenario
  const sums = await rows(`SELECT scenario, SUM(share) AS s, SUM(trips) AS t FROM v_trip_length GROUP BY scenario ORDER BY scenario`);
  for (const s of sums) assert.ok(Math.abs(num(s.s) - 1) < 1e-9);
  assert.equal(num(sums.find((s) => s.scenario === "before")!.t), 160);
  // 1 km bins: 111 km -> bin 111
  const bins = await rows(`SELECT bin_idx, bin_start_km, bin_end_km FROM v_trip_length WHERE scenario='before' ORDER BY bin_idx`);
  assert.ok(bins.every((b) => num(b.bin_end_km) - num(b.bin_start_km) === 1));
  const stats = await rows(`SELECT mean_km FROM v_trip_length_stats WHERE scenario='before'`);
  const d12 = haversineKm(0, 0, 1, 0), d13 = haversineKm(0, 0, 0, 1), d31 = haversineKm(0, 1, 0, 0);
  assert.ok(Math.abs(num(stats[0].mean_km) - (100 * d12 + 50 * d13 + 10 * d31) / 160) < 1e-6);
});

test("v_det_validation: aggregation, GEH, status", async () => {
  const r = await rows(`SELECT * FROM v_det_validation ORDER BY detector_id`);
  assert.deepEqual(r.map((x) => x.detector_id), ["D1", "D2", "D3", "D4"]); // D5 partial, D6 unmatched
  const d = (id: string) => r.find((x) => x.detector_id === id)!;
  assert.equal(num(d("D1").sim_flow_h), 1100);
  assert.equal(num(d("D1").obs_flow_h), 1000);
  assert.ok(Math.abs(num(d("D1").geh) - geh(1100, 1000)) < 1e-9);
  assert.equal(d("D1").status, "pass");
  assert.equal(num(d("D1").oid), 11);
  assert.ok(Math.abs(num(d("D1").rel_error) - 0.1) < 1e-12);
  assert.equal(d("D2").status, "fail");
  assert.ok(Math.abs(num(d("D2").geh) - geh(500, 1000)) < 1e-9);
  assert.equal(num(d("D3").geh), 0);
  assert.equal(d("D3").status, "pass");
  assert.equal(d("D4").rel_error, null);
  assert.ok(Math.abs(num(d("D4").geh) - geh(100, 0)) < 1e-9);
  assert.equal(d("D4").status, "fail");
});

test("v_det_summary equals the TS twin", async () => {
  const [s] = await rows(`SELECT * FROM v_det_summary`);
  const obs = [1000, 1000, 0, 0];
  const sim = [1100, 500, 0, 100];
  const t = regressionStats(obs, sim);
  assert.equal(num(s.n), 4);
  for (const [sql, ts] of [
    ["rmse", t.rmse], ["mae", t.mae], ["bias", t.bias], ["r2", t.r2], ["slope", t.slope],
    ["intercept", t.intercept], ["r2_identity", t.r2Identity], ["pct_geh_lt5", t.pctGehLt5],
  ] as const) {
    assert.ok(Math.abs(num(s[sql]) - (ts as number)) < 1e-9, `${sql}: ${s[sql]} vs ${ts}`);
  }
  assert.equal(num(s.n_pass), 2);
  assert.equal(num(s.n_fail), 2);
  assert.equal(num(s.n_warn), 0);
});

test("buildViewsSql parameters: 30-min bucket, partial buckets allowed", async () => {
  await runScript(buildViewsSql({ ...COUNT_OPTS, bucketMinutes: 30, requireFullBuckets: false, binKm: 10 }));
  const r = await rows(`SELECT detector_id, bucket_start_min FROM v_det_validation WHERE detector_id='D1' ORDER BY bucket_start_min`);
  assert.deepEqual(r.map((x) => num(x.bucket_start_min)), [0, 30]);
  const d5 = await rows(`SELECT * FROM v_det_validation WHERE detector_id='D5'`);
  assert.equal(d5.length, 1); // obs covers 30 of 60 min but partial buckets allowed (hourly rate used)
  assert.throws(() => buildViewsSql({ bucketMinutes: 0 }));
  assert.throws(() => buildViewsSql({ binKm: -1 }));
  assert.throws(() => buildViewsSql({ simFlowKind: "volume" as never }));
  assert.throws(() => buildViewsSql({ simRelation: "x; DROP TABLE y" }));
  await runScript(COUNT_SQL);
});

test("default flowKind is rate: duration-weighted mean, not sum*60/sum(dur)", async () => {
  await runScript(`
    CREATE TABLE r_sim(oid INTEGER, eid VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    CREATE TABLE r_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    -- R1: sim rates 1000,1200,800,1000 on 15-min intervals -> mean 1000 veh/h
    INSERT INTO r_sim VALUES (21,'R1',0,15,1000),(21,'R1',15,15,1200),(21,'R1',30,15,800),(21,'R1',45,15,1000);
    -- R1 obs: 12 five-minute intervals, all 900 veh/h -> 900
    INSERT INTO r_obs SELECT 'R1', i * 5, 5, 900 FROM range(0, 12) t(i);
    -- R2: unequal durations, 45 min @ 400 + 15 min @ 1200 -> (45*400 + 15*1200) / 60 = 600
    -- (a count-style sum*60/sum(dur) would give (400+1200)*60/60 = 1600)
    INSERT INTO r_sim VALUES (22,'R2',0,45,400),(22,'R2',45,15,1200);
    INSERT INTO r_obs VALUES ('R2',0,60,600);
  `);
  await runScript(buildViewsSql({ only: ["det"], simRelation: "r_sim", obsRelation: "r_obs" }));
  const r = await rows(`SELECT * FROM v_det_validation ORDER BY detector_id`);
  assert.equal(r.length, 2);
  assert.equal(num(r[0].sim_flow_h), 1000);
  assert.equal(num(r[0].obs_flow_h), 900);
  assert.ok(Math.abs(num(r[0].geh) - geh(1000, 900)) < 1e-9); // sqrt(2*100^2/1900) = 3.2444
  assert.ok(Math.abs(num(r[0].geh) - 3.2444284) < 1e-6);
  assert.equal(num(r[1].sim_flow_h), 600);
  assert.equal(num(r[1].geh), 0);
  assert.equal(hourlyFlowOver([{ flow: 400, durMin: 45 }, { flow: 1200, durMin: 15 }]), 600);
  assert.equal(hourlyFlowOver([{ flow: 400, durMin: 45 }, { flow: 1200, durMin: 15 }], "count"), 1600);
  // mixed kinds: simulated rate vs observed counts (4 x 15 min, 250 each = 1000 veh/h)
  await runScript(`
    CREATE TABLE m_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    INSERT INTO m_obs VALUES ('R1',0,15,250),('R1',15,15,250),('R1',30,15,250),('R1',45,15,250);
  `);
  await runScript(buildViewsSql({ only: ["det"], simRelation: "r_sim", obsRelation: "m_obs", obsFlowKind: "count" }));
  const m = await rows(`SELECT sim_flow_h, obs_flow_h FROM v_det_validation`);
  assert.deepEqual(m.map((x) => [num(x.sim_flow_h), num(x.obs_flow_h)]), [[1000, 1000]]);
  await runScript(COUNT_SQL);
});
