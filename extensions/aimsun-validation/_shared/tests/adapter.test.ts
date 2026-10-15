// Synthetic, hand-computed tests of the real-table adapter (v_sim_norm / v_obs_norm) and v_sp_obs.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql } from "../src/sql/views.sql.ts";
import { buildAdapterSql, ADAPTED_RELATIONS } from "../src/sql/adapter.sql.ts";
import { buildSubpathSql } from "../src/sql/subpath.sql.ts";
import { geh } from "../src/metrics.ts";

let conn: DuckDBConnection;
const stmts = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const run = async (sql: string) => { for (const s of stmts(sql)) await conn.run(s); };
const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, any>>;
const num = (v: unknown) => Number(v);

before(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await run(`
    CREATE TABLE detectors_sim_raw(did BIGINT, run VARCHAR, oid BIGINT, eid VARCHAR, ent INTEGER, sid INTEGER,
      interval_start_s INTEGER, duration_s INTEGER, flow DOUBLE, volume DOUBLE);
    -- A: sid 0 = 800 veh/h, sid 1 (a class) = 700 must be ignored. 07:00-08:00 -> t_start 420, dur 60
    INSERT INTO detectors_sim_raw VALUES (1,'T',101,'A',1,0,25200,3600,800,800),(1,'T',101,'A',1,1,25200,3600,700,700);
    INSERT INTO detectors_sim_raw VALUES (1,'T',102,'B',1,0,25200,3600,1000,1000);
    CREATE TABLE detectors_obs_raw(detector_id VARCHAR, ts TIMESTAMP, flow DOUBLE, source_file VARCHAR);
    -- A on 2025-01-01: ts labels the interval END, so 07:05..08:00 is the 07:00-08:00 hour.
    -- 12 intervals of 900 veh/h, present in both files (validation 900, calibration deliberately 999)
    INSERT INTO detectors_obs_raw SELECT 'A', TIMESTAMP '2025-01-01 07:00:00' + to_minutes(5 * (i + 1)), 900, 'validation' FROM range(0, 12) t(i);
    INSERT INTO detectors_obs_raw SELECT 'A', TIMESTAMP '2025-01-01 07:00:00' + to_minutes(5 * (i + 1)), 999, 'calibration' FROM range(0, 12) t(i);
    -- B only in calibration, 1000 veh/h
    INSERT INTO detectors_obs_raw SELECT 'B', TIMESTAMP '2025-01-01 07:00:00' + to_minutes(5 * (i + 1)), 1000, 'calibration' FROM range(0, 12) t(i);
    -- other day (2025-01-02 07:30) must be dropped; 2025-01-02 00:00 is the last interval of day 1
    INSERT INTO detectors_obs_raw VALUES ('A', TIMESTAMP '2025-01-02 07:30:00', 5, 'validation'), ('A', TIMESTAMP '2025-01-02 00:00:00', 5, 'validation');
    CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR);
    -- 3 days x 4 quarter-hours in hour 07: day values 60,70,80 (all quarters equal per day) + one extreme day
    INSERT INTO subpath_obs_jt SELECT 'R', 'IB', TIMESTAMP '2025-02-03 07:00:00' + to_days(d) + to_minutes(15 * q),
      60 + 10 * d, 'monthly_15min' FROM range(0, 3) t1(d), range(0, 4) t2(q);
    INSERT INTO subpath_obs_jt SELECT 'R', 'IB', TIMESTAMP '2025-02-06 07:00:00' + to_minutes(15 * q), 1000, 'monthly_15min' FROM range(0, 4) t(q);
    INSERT INTO subpath_obs_jt VALUES ('R', 'IB', TIMESTAMP '2025-05-05 07:15:00', 500, 'subnetwork_may2025');
  `);
  await run(buildAdapterSql());
  await run(buildSubpathSql({ bucketMinutes: 60 }));
});
after(() => conn.closeSync());

test("v_sim_norm keeps sid=0 only and converts to minutes", async () => {
  const r = await rows(`SELECT * FROM v_sim_norm ORDER BY eid`);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.eid, num(x.oid), num(x.t_start_min), num(x.dur_min), num(x.flow)]), [["A", 101, 420, 60, 800], ["B", 102, 420, 60, 1000]]);
});

test("v_obs_norm: end-labelled ts, dedup validation first, in-day only", async () => {
  const a = await rows(`SELECT * FROM v_obs_norm WHERE detector_id = 'A' ORDER BY t_start_min`);
  // 12 intervals in hour 07 + the 2025-01-02 00:00 stamp (= start 1435); 2025-01-02 07:30 dropped
  assert.equal(a.length, 13);
  assert.equal(num(a[0].t_start_min), 420);
  assert.equal(num(a[11].t_start_min), 475);
  assert.equal(num(a[12].t_start_min), 1435);
  assert.ok(a.every((x) => num(x.dur_min) === 5));
  assert.ok(a.slice(0, 12).every((x) => num(x.flow) === 900)); // validation preferred, not 999
  await run(buildAdapterSql({ obsPreference: ["calibration", "validation"] }));
  assert.equal(num((await rows(`SELECT flow FROM v_obs_norm WHERE detector_id='A' AND t_start_min=420`))[0].flow), 999);
  await run(buildAdapterSql({ obsSource: "validation" }));
  assert.equal(num((await rows(`SELECT count(*) n FROM v_obs_norm WHERE detector_id='B'`))[0].n), 0);
  await run(buildAdapterSql({ obsTsLabel: "start" }));
  assert.equal(num((await rows(`SELECT min(t_start_min) m FROM v_obs_norm WHERE detector_id='A' AND flow=900`))[0].m), 425);
  await run(buildAdapterSql());
});

test("adapted v_det_validation: rate contract, hand-computed GEH", async () => {
  await run(buildViewsSql({ only: ["det"], ...ADAPTED_RELATIONS }));
  const r = await rows(`SELECT * FROM v_det_validation ORDER BY detector_id`);
  assert.equal(r.length, 2);
  // A: sim 800 vs obs mean(12 x 900) = 900 -> GEH = sqrt(2*100^2/1700) = 3.4300
  assert.equal(num(r[0].sim_flow_h), 800);
  assert.equal(num(r[0].obs_flow_h), 900);
  assert.ok(Math.abs(num(r[0].geh) - geh(800, 900)) < 1e-12);
  assert.ok(Math.abs(num(r[0].geh) - 3.43) < 1e-3);
  assert.equal(num(r[1].geh), 0);
  const [s] = await rows(`SELECT * FROM v_det_summary`);
  assert.equal(num(s.n), 2);
  assert.equal(num(s.pct_geh_lt5), 100);
  assert.ok(Math.abs(num(s.rmse) - Math.sqrt(100 ** 2 / 2)) < 1e-9);
});

test("v_sp_obs: per-day hourly values, then mean/median across days; sources kept apart", async () => {
  const r = await rows(`SELECT * FROM v_sp_obs WHERE route='R' AND bucket_start_min=420 ORDER BY source`);
  assert.equal(r.length, 2);
  const m = r.find((x) => x.source === "monthly_15min")!;
  // day means 60, 70, 80, 1000 -> mean 302.5, median 75
  assert.equal(num(m.n_days), 4);
  assert.equal(num(m.mean_s), 302.5);
  assert.equal(num(m.median_s), 75);
  assert.equal(num(m.min_s), 60);
  assert.equal(num(m.max_s), 1000);
  const sn = r.find((x) => x.source === "subnetwork_may2025")!;
  assert.equal(num(sn.n_days), 1);
  assert.equal(num(sn.median_s), 500);
  await run(buildSubpathSql({ bucketMinutes: 15, source: "monthly_15min" }));
  const q = await rows(`SELECT bucket_start_min FROM v_sp_obs ORDER BY 1`);
  assert.deepEqual(q.map((x) => num(x.bucket_start_min)), [420, 435, 450, 465]);
  assert.throws(() => buildSubpathSql({ bucketMinutes: 7 }));
});

test("adapter options: observed reference day / grid / simDurationSeconds filter", () => {
  const s = buildAdapterSql({ obsRefDay: "2020-01-01", obsGridMin: 15, simDurationSeconds: 300 });
  assert.match(s, /TIMESTAMP '2020-01-01 00:00:00'/);
  assert.match(s, /AND duration_s = 300/);
  assert.match(s, /15 AS dur_min/);
  assert.doesNotMatch(buildAdapterSql(), /duration_s = /);
  assert.throws(() => buildAdapterSql({ simDurationSeconds: 0 }), /simDurationSeconds/);
});
