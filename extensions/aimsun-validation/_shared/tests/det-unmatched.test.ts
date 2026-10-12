// Simulated detectors with NULL / empty eid: excluded from v_det_validation, listed in v_det_unmatched_sim.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql, VIEW_NAMES } from "../src/sql/views.sql.ts";
import { geh, haversineKm } from "../src/metrics.ts";
import { haversineKm as haversineSql } from "../src/sql/od-adapter.sql.ts";

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
    -- E1: a normal detector
    INSERT INTO detectors_sim VALUES (1,'E1',0,60,600);
    INSERT INTO detectors_obs VALUES ('E1',0,60,500);
    -- three oids WITHOUT eid (two NULL, one empty/blank): they must NOT be pooled into one row
    INSERT INTO detectors_sim VALUES (2,NULL,0,60,300),(3,NULL,0,60,0),(4,'  ',0,60,100),(5,NULL,0,60,NULL);
    -- an observed detector with NULL id never matches either
    INSERT INTO detectors_obs VALUES (NULL,0,60,300);
  `);
  await run(buildViewsSql({ only: ["det"] }));
});
after(() => conn.closeSync());

test("v_det_validation excludes NULL/empty-eid sim detectors (no collapsed 'NULL' row)", async () => {
  const r = await rows("SELECT * FROM v_det_validation");
  assert.equal(r.length, 1);
  assert.equal(r[0].detector_id, "E1");
  assert.equal(num(r[0].oid), 1);
  assert.ok(Math.abs(num(r[0].geh) - geh(600, 500)) < 1e-12);
});

test("v_det_unmatched_sim lists one row per eid-less oid with its flow; summary counts them", async () => {
  const r = await rows("SELECT * FROM v_det_unmatched_sim ORDER BY oid");
  assert.deepEqual(r.map((x) => [num(x.oid), x.flow === null ? null : num(x.flow), num(x.n_intervals)]), [[2, 300, 1], [3, 0, 1], [4, 100, 1], [5, null, 0]]);
  const [s] = await rows("SELECT * FROM v_det_unmatched_sim_summary");
  assert.equal(num(s.n_oids), 4);
  assert.equal(num(s.n_with_flow), 2); // flow > 0: oids 2 and 4
  assert.ok((VIEW_NAMES as readonly string[]).includes("v_det_unmatched_sim"));
});

test("count flowKind: unmatched flow is the hourly rate of the counts", async () => {
  await run(`
    CREATE TABLE c_sim(oid INTEGER, eid VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    CREATE TABLE c_obs(detector_id VARCHAR, t_start_min INTEGER, dur_min INTEGER, flow DOUBLE);
    INSERT INTO c_sim VALUES (9,NULL,0,15,50),(9,NULL,15,15,50);
  `);
  await run(buildViewsSql({ only: ["det"], simRelation: "c_sim", obsRelation: "c_obs", simFlowKind: "count" }));
  const [r] = await rows("SELECT * FROM v_det_unmatched_sim");
  assert.equal(num(r.flow), 200); // 100 veh in 30 min
  await run(buildViewsSql({ only: ["det"] }));
});

test("haversine: SQL builder, TS twin and a known value agree (1 degree of latitude = 111.195 km)", async () => {
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.1949) < 1e-3);
  const [r] = await rows(`SELECT ${haversineSql("a.lat", "a.lon", "b.lat", "b.lon")} AS d FROM (SELECT 0.0 AS lat, 0.0 AS lon) a, (SELECT 1.0 AS lat, 0.0 AS lon) b`);
  assert.ok(Math.abs(num(r.d) - 111.1949) < 1e-3);
  const [r2] = await rows(`SELECT ${haversineSql("a.lat", "a.lon", "b.lat", "b.lon")} AS d FROM (SELECT 24.45 AS lat, 54.37 AS lon) a, (SELECT 25.2 AS lat, 55.27 AS lon) b`);
  assert.ok(Math.abs(num(r2.d) - haversineKm(24.45, 54.37, 25.2, 55.27)) < 1e-9);
});
