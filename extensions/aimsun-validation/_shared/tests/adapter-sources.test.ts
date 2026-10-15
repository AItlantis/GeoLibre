// Observation contract v2 (C7) in the adapter: per-source / per-row duration_s and units, dedupe by
// (detector_id, ts, source_id), profile-only sources kept out of v_obs_norm, legacy untouched.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildAdapterSql, type ObsSourceSpec } from "../src/sql/adapter.sql.ts";

let conn: DuckDBConnection;
const stmts = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const run = async (sql: string) => { for (const s of stmts(sql)) await conn.run(s); };
const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, any>>;
const num = (v: unknown) => Number(v);

const COLS = ["detector_id", "ts", "flow", "source_file", "duration_s", "source_id", "units", "unit_confidence", "flow_min", "flow_max", "oid", "eligibility"];
const spec = (o: Partial<ObsSourceSpec> & { sourceId: string }): ObsSourceSpec => ({
  durationSeconds: 900, units: "veh/h", unitConfidence: "declared", eligibility: "comparable", referenceDay: "2020-01-01", tsLabel: "end", ...o,
});

before(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await run(`
    CREATE TABLE sim_raw(did BIGINT, run VARCHAR, oid BIGINT, eid VARCHAR, ent INTEGER, sid INTEGER, interval_start_s INTEGER, duration_s INTEGER, flow DOUBLE, volume DOUBLE);
    INSERT INTO sim_raw VALUES (1,'M',1,'A',1,0,25200,300,600,50);
    CREATE TABLE obs_raw(detector_id VARCHAR, ts TIMESTAMP, flow DOUBLE, source_file VARCHAR, duration_s INTEGER, source_id VARCHAR, units VARCHAR,
      unit_confidence VARCHAR, flow_min DOUBLE, flow_max DOUBLE, oid BIGINT, eligibility VARCHAR);
    -- pat: 15-minute veh/h pattern on 2020-01-01, END labelled; one duplicate row (same detector, ts, source)
    INSERT INTO obs_raw SELECT 'A', TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), 400.0 + i, 'pattern_rds_4.csv', 900, 'pat', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable' FROM range(0, 4) t(i);
    INSERT INTO obs_raw VALUES ('A', TIMESTAMP '2020-01-01 07:15:00', 400.0, 'pattern_rds_4.csv', 900, 'pat', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable');
    -- cnt: vehicle counts per 15 minutes, units declared -> converted with the row duration (x 4)
    INSERT INTO obs_raw SELECT 'B', TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), 100.0, 'counts.csv', 900, 'cnt', 'veh', 'declared', NULL, NULL, NULL, 'comparable' FROM range(0, 4) t(i);
    -- inf: counts per 30 minutes (row duration wins over the source's 900 s), units inferred
    INSERT INTO obs_raw VALUES ('C', TIMESTAMP '2020-01-01 07:30:00', 300.0, 'half.csv', 1800, 'inf', 'veh', 'inferred', NULL, NULL, NULL, 'comparable');
    -- unk: units unknown, interval unknown: profile-only point
    INSERT INTO obs_raw VALUES ('A', TIMESTAMP '2020-01-01 07:00:00', 77.0, 'traffic_survey_rds.csv', NULL, 'unk', 'unknown', 'unknown', NULL, NULL, NULL, 'profile-only');
    -- unkveh: veh with UNKNOWN confidence, interval known
    INSERT INTO obs_raw VALUES ('D', TIMESTAMP '2020-01-01 07:15:00', 50.0, 'x.csv', 900, 'unkveh', 'veh', 'unknown', NULL, NULL, NULL, NULL);
    -- typ: a typical day stamped on another date, no reference day: time of day only (end labelled)
    INSERT INTO obs_raw VALUES ('E', TIMESTAMP '1999-12-31 07:15:00', 900.0, 'typ.csv', 900, 'typ', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable');
    -- ov1/ov2: the same detector and stamp in two homogeneous sources (validation preferred = first in the list)
    INSERT INTO obs_raw VALUES ('F', TIMESTAMP '2020-01-01 07:15:00', 111.0, 'v.csv', 900, 'ov1', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable');
    INSERT INTO obs_raw VALUES ('F', TIMESTAMP '2020-01-01 07:15:00', 999.0, 'c.csv', 900, 'ov2', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable');
    INSERT INTO obs_raw VALUES ('F', TIMESTAMP '2020-01-01 07:30:00', 222.0, 'c.csv', 900, 'ov2', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable');
  `);
});
after(() => conn.closeSync());

const apply = async (specs: ObsSourceSpec[], obsColumns: readonly string[] = COLS) =>
  run(buildAdapterSql({ rawSimTable: "sim_raw", rawObsTable: "obs_raw", obsSources: specs, obsColumns }));

test("end-labelled 15-minute veh/h pattern on its reference day, duplicates collapsed per (detector, ts, source)", async () => {
  await apply([spec({ sourceId: "pat" })]);
  const r = await rows("SELECT * FROM v_obs_norm ORDER BY t_start_min");
  assert.deepEqual(r.map((x) => [x.detector_id, num(x.t_start_min), num(x.dur_min), num(x.flow)]), [["A", 420, 15, 400], ["A", 435, 15, 401], ["A", 450, 15, 402], ["A", 465, 15, 403]]);
});

test("'veh' counts convert to veh/h with the row duration when units are declared or inferred", async () => {
  await apply([spec({ sourceId: "cnt", units: "veh" }), spec({ sourceId: "inf", units: "veh", unitConfidence: "inferred" })]);
  const b = await rows("SELECT * FROM v_obs_norm WHERE detector_id = 'B' ORDER BY t_start_min");
  assert.deepEqual(b.map((x) => num(x.flow)), [400, 400, 400, 400]); // 100 veh / 15 min
  const c = await rows("SELECT * FROM v_obs_norm WHERE detector_id = 'C'");
  assert.deepEqual(c.map((x) => [num(x.t_start_min), num(x.dur_min), num(x.flow)]), [[420, 30, 600]]); // 07:30 end -> start 07:00, 30 min, 300 veh / 0.5 h
});

test("unknown units / unknown interval / 'veh' without declared or inferred confidence never reach v_obs_norm (profile only)", async () => {
  await apply([spec({ sourceId: "unk", durationSeconds: null, units: "unknown", unitConfidence: "unknown", eligibility: "profile-only" }), spec({ sourceId: "unkveh", units: "veh", unitConfidence: "unknown" })]);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm"))[0].n), 0);
  const p = await rows("SELECT * FROM v_obs_profile ORDER BY source_id");
  assert.deepEqual(p.map((x) => [x.source_id, x.detector_id, num(x.t_start_min), num(x.dur_min), num(x.flow), x.comparable]), [
    ["unk", "A", 420, 0, 77, false], // point observation: no shift, no duration, value as given
    ["unkveh", "D", 420, 15, 50, false],
  ]);
});

test("a profile-only source selected next to a comparable one stays out of the comparable view", async () => {
  await apply([spec({ sourceId: "pat" }), spec({ sourceId: "unk", durationSeconds: null, units: "unknown", unitConfidence: "unknown", eligibility: "profile-only" })]);
  const n = await rows("SELECT source_id, count(*) n FROM v_obs_profile GROUP BY 1 ORDER BY 1");
  assert.deepEqual(n.map((x) => [x.source_id, num(x.n)]), [["pat", 4], ["unk", 1]]);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm"))[0].n), 4);
});

test("typical day without a reference day: time of day only, whatever the stamped date", async () => {
  await apply([spec({ sourceId: "typ", referenceDay: null })]);
  const r = await rows("SELECT * FROM v_obs_norm");
  assert.deepEqual(r.map((x) => [num(x.t_start_min), num(x.dur_min), num(x.flow)]), [[420, 15, 900]]); // 07:15 end - 15 min
  await apply([spec({ sourceId: "typ", referenceDay: "2020-01-01" })]);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm"))[0].n), 0, "with a declared reference day the stamp is on another day: dropped");
});

test("overlapping homogeneous sources keep the preferred one per (detector, interval): no double counting", async () => {
  await apply([spec({ sourceId: "ov1" }), spec({ sourceId: "ov2" })]);
  const r = await rows("SELECT * FROM v_obs_norm WHERE detector_id = 'F' ORDER BY t_start_min");
  assert.deepEqual(r.map((x) => [num(x.t_start_min), num(x.flow)]), [[420, 111], [435, 222]]);
  await apply([spec({ sourceId: "ov2" }), spec({ sourceId: "ov1" })]);
  assert.equal(num((await rows("SELECT flow FROM v_obs_norm WHERE detector_id = 'F' AND t_start_min = 420"))[0].flow), 999);
});

test("selecting one source ignores the others", async () => {
  await apply([spec({ sourceId: "ov2" })]);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm"))[0].n), 2);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm WHERE detector_id = 'A'"))[0].n), 0);
});

test("legacy columns only (no duration_s / units / source_id): source_file is the source id, the source's own interval applies", async () => {
  await run(`CREATE TABLE legacy_obs(detector_id VARCHAR, ts TIMESTAMP, flow DOUBLE, source_file VARCHAR);
    INSERT INTO legacy_obs SELECT 'A', TIMESTAMP '2025-01-01 07:00:00' + to_minutes(5 * (i + 1)), 900.0, 'validation' FROM range(0, 12) t(i);`);
  await run(buildAdapterSql({ rawSimTable: "sim_raw", rawObsTable: "legacy_obs", obsSources: [spec({ sourceId: "validation", durationSeconds: 300, referenceDay: "2025-01-01" })], obsColumns: ["detector_id", "ts", "flow", "source_file"] }));
  const r = await rows("SELECT * FROM v_obs_norm ORDER BY t_start_min");
  assert.equal(r.length, 12);
  assert.deepEqual([num(r[0].t_start_min), num(r[0].dur_min), num(r[11].t_start_min)], [420, 5, 475]);
});

test("the legacy adapter (no obsSources) is unchanged and defines no extended views", async () => {
  const sql = buildAdapterSql({ rawSimTable: "sim_raw", rawObsTable: "legacy_obs" });
  assert.doesNotMatch(sql, /v_obs_src|v_obs_ext|v_obs_profile/);
  assert.match(sql, /TIMESTAMP '2025-01-01 00:00:00'/);
  assert.match(sql, /5 AS dur_min/);
});

test("extended mode validates its input and escapes source ids", async () => {
  assert.throws(() => buildAdapterSql({ obsSources: [spec({ sourceId: "x", referenceDay: "01/01/2020" })] }), /referenceDay/);
  assert.throws(() => buildAdapterSql({ obsSources: [spec({ sourceId: "x", units: "kph" as never })] }), /units/);
  assert.throws(() => buildAdapterSql({ obsSources: [spec({ sourceId: "x", durationSeconds: 0 })] }), /durationSeconds/);
  assert.doesNotThrow(() => buildAdapterSql({ obsSources: [spec({ sourceId: "it's" })] }));
  await apply([]);
  assert.equal(num((await rows("SELECT count(*) n FROM v_obs_norm"))[0].n), 0);
  await apply([spec({ sourceId: "x' OR '1'='1" })]);
  assert.equal(num((await rows("SELECT count(*) n FROM obs_raw"))[0].n) > 0, true);
});
