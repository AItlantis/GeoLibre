// C8: several simulated oids can share one eid. They are pooled per (eid, interval) with the MEAN of
// their flow rates; temporal coverage is the UNION of the covered intervals (never summed over oids);
// each eid counts once in every statistic.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql } from "../src/sql/views.sql.ts";
import { geh } from "../src/metrics.ts";

let conn: DuckDBConnection;
const stmts = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const run = async (sql: string) => { for (const s of stmts(sql)) await conn.run(s); };
const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, any>>;
const num = (v: unknown) => Number(v);

before(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await run(`
    CREATE TABLE detectors_sim(oid INTEGER, eid VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    CREATE TABLE detectors_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    -- H: two oids cover the SAME half hour 07:00-07:30 (6 five-minute intervals each); observed covers the whole hour
    INSERT INTO detectors_sim SELECT o, 'H', 420 + 5 * i, 5, 500.0 FROM (VALUES (1), (2)) a(o), range(0, 6) t(i);
    INSERT INTO detectors_obs SELECT 'H', 420 + 5 * i, 5, 500.0 FROM range(0, 12) t(i);
    -- J (J383_A-like): three oids over the same full hour with rates 149 / 136 / 130
    INSERT INTO detectors_sim SELECT o, 'J', 420 + 5 * i, 5, r FROM (VALUES (10, 149.0), (11, 136.0), (12, 130.0)) a(o, r), range(0, 12) t(i);
    INSERT INTO detectors_obs SELECT 'J', 420 + 5 * i, 5, 140.0 FROM range(0, 12) t(i);
    -- U: two oids with complementary halves of the hour (union = full hour); rates 100 then 200 (flow is a rate, one oid per interval)
    INSERT INTO detectors_sim SELECT 20, 'U', 420 + 5 * i, 5, 100.0 FROM range(0, 6) t(i);
    INSERT INTO detectors_sim SELECT 21, 'U', 450 + 5 * i, 5, 200.0 FROM range(0, 6) t(i);
    INSERT INTO detectors_obs SELECT 'U', 420 + 5 * i, 5, 150.0 FROM range(0, 12) t(i);
    -- S: a single oid, plain
    INSERT INTO detectors_sim SELECT 30, 'S', 420 + 5 * i, 5, 300.0 FROM range(0, 12) t(i);
    INSERT INTO detectors_obs SELECT 'S', 420 + 5 * i, 5, 330.0 FROM range(0, 12) t(i);
  `);
});
after(() => conn.closeSync());

test("two oids covering the SAME half hour do not satisfy a full-hour coverage check (summed durations were the bug)", async () => {
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 60 }));
  const r = await rows("SELECT * FROM v_det_validation WHERE detector_id = 'H'");
  assert.equal(r.length, 0, "30 minutes of data must not become a full hour by adding the oids' durations");
  // with a 30-minute bucket the half hour IS fully covered, and is covered once
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 30 }));
  const half = await rows("SELECT * FROM v_det_validation WHERE detector_id = 'H' ORDER BY bucket_start_min");
  assert.deepEqual(half.map((x) => [num(x.bucket_start_min), num(x.sim_flow_h), num(x.n_sim_oids)]), [[420, 500, 2]]);
});

test("J383_A-like: three oids (149 / 136 / 130) pool as the MEAN of the oids per interval, one eid, 60 min coverage", async () => {
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 60 }));
  const [j] = await rows("SELECT * FROM v_det_validation WHERE detector_id = 'J'");
  assert.ok(Math.abs(num(j.sim_flow_h) - (149 + 136 + 130) / 3) < 1e-9, "mean over the oids (138.33), not a duration-weighted sum over 180 minutes");
  assert.equal(num(j.obs_flow_h), 140);
  assert.equal(num(j.n_sim_oids), 3);
  assert.equal(num(j.oid), 10, "MIN(oid) stays the render id");
  assert.ok(Math.abs(num(j.geh) - geh((149 + 136 + 130) / 3, 140)) < 1e-9);
});

test("temporal coverage is the UNION of the intervals of the oids", async () => {
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 60 }));
  const [u] = await rows("SELECT * FROM v_det_validation WHERE detector_id = 'U'");
  assert.ok(u, "complementary halves of two oids cover the hour");
  assert.equal(num(u.sim_flow_h), 150); // duration-weighted mean of 6 x 100 and 6 x 200
  assert.equal(num(u.n_sim_oids), 2);
});

test("validation statistics count each eid once", async () => {
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 60 }));
  const ids = (await rows("SELECT detector_id FROM v_det_validation ORDER BY detector_id")).map((x) => x.detector_id);
  assert.deepEqual(ids, ["J", "S", "U"]); // H is not covered for a full hour; J has 3 oids but one row
  const [s] = await rows("SELECT n FROM v_det_summary");
  assert.equal(num(s.n), 3);
});

test("count flowKind pools by the mean of the oids' counts as well", async () => {
  await run(`
    CREATE TABLE c_sim(oid INTEGER, eid VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    CREATE TABLE c_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    INSERT INTO c_sim VALUES (1,'C',0,30,40),(2,'C',0,30,60),(1,'C',30,30,50),(2,'C',30,30,50);
    INSERT INTO c_obs VALUES ('C',0,60,100);
  `);
  await run(buildViewsSql({ only: ["det"], bucketMinutes: 60, simRelation: "c_sim", obsRelation: "c_obs", simFlowKind: "count", obsFlowKind: "count" }));
  const [c] = await rows("SELECT * FROM v_det_validation WHERE detector_id = 'C'");
  assert.equal(num(c.sim_flow_h), 100); // (mean 50 + mean 50) vehicles in 60 min
  assert.equal(num(c.n_sim_oids), 2);
});
