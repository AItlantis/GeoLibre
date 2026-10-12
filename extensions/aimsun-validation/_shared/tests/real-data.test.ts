// Runs the adapter + det views + v_sp_obs against the REAL extractor output (parquet) using the
// native DuckDB node API. Skipped when the data folder is absent.
// Data root: $AIMSUN_DATA_DIR (layout <root>/<RUN>/*.parquet); NO default - the tests skip when it is unset.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql } from "../src/sql/views.sql.ts";
import { buildAdapterSql, ADAPTED_RELATIONS } from "../src/sql/adapter.sql.ts";
import { buildSubpathSql } from "../src/sql/subpath.sql.ts";
import { geh } from "../src/metrics.ts";

const ROOT = process.env.AIMSUN_DATA_DIR;
const have = (run: string) => !!ROOT && existsSync(join(ROOT, run, "detectors_sim.parquet")) && existsSync(join(ROOT, run, "detectors_obs.parquet"));
const NODATA = "AIMSUN_DATA_DIR unset or data not found";

const stmts = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

async function open(run: string): Promise<DuckDBConnection> {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const p = (f: string) => join(ROOT!, run, f).replace(/\\/g, "/").replace(/'/g, "''");
  await conn.run(`CREATE TABLE detectors_sim_raw AS SELECT * FROM read_parquet('${p("detectors_sim.parquet")}')`);
  await conn.run(`CREATE TABLE detectors_obs_raw AS SELECT * FROM read_parquet('${p("detectors_obs.parquet")}')`);
  if (existsSync(join(ROOT!, run, "subpath_obs_jt.parquet"))) {
    await conn.run(`CREATE TABLE subpath_obs_jt AS SELECT * FROM read_parquet('${p("subpath_obs_jt.parquet")}')`);
  }
  for (const s of stmts(buildAdapterSql())) await conn.run(s);
  for (const s of stmts(buildViewsSql({ only: ["det"], ...ADAPTED_RELATIONS }))) await conn.run(s);
  return conn;
}

const one = async (c: DuckDBConnection, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson()[0] as Record<string, any>;
const all = async (c: DuckDBConnection, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, any>>;

for (const [run, startMin] of [["AMPK_3", 420], ["PMPK_3", 1020]] as const) {
  test(`real ${run}: adapter + v_det_summary over ${startMin / 60}:00-${startMin / 60 + 1}:00`, { skip: !have(run) && NODATA }, async () => {
    const c = await open(run);
    // adapter: sid = 0 only, one row per detector oid, obs de-duplicated, 5-min grid
    const sim = await one(c, `SELECT count(*) n, count(DISTINCT oid) n_oid, min(t_start_min) t0, max(dur_min) dur FROM v_sim_norm`);
    assert.equal(Number(sim.n), Number(sim.n_oid));
    assert.equal(Number(sim.t0), startMin);
    assert.equal(Number(sim.dur), 60);
    const dup = await one(c, `SELECT count(*) n FROM (SELECT detector_id, t_start_min FROM v_obs_norm GROUP BY ALL HAVING count(*) > 1)`);
    assert.equal(Number(dup.n), 0);
    const obsGrid = await one(c, `SELECT min(t_start_min) lo, max(t_start_min) hi, min(dur_min) d FROM v_obs_norm`);
    assert.equal(Number(obsGrid.lo), 0);
    assert.equal(Number(obsGrid.hi), 1435);
    assert.equal(Number(obsGrid.d), 5);

    const matched = await one(c, `SELECT count(DISTINCT detector_id) n, count(*) n_rows, min(bucket_start_min) b0, max(bucket_start_min) b1 FROM v_det_validation`);
    const sum = await one(c, `SELECT * FROM v_det_summary`);
    console.log(`${run} v_det_validation: matched detectors=${matched.n} rows=${matched.n_rows} bucket=${matched.b0}..${matched.b1}`);
    console.log(`${run} v_det_summary: ${JSON.stringify(sum)}`);

    assert.equal(Number(matched.b0), startMin);
    assert.equal(Number(matched.b1), startMin);
    const n = Number(matched.n);
    assert.ok(n >= 450 && n <= 560, `matched detectors ${n} not near 509`);
    assert.equal(Number(sum.n), Number(matched.n_rows));
    const pct = Number(sum.pct_geh_lt5);
    assert.ok(pct > 0 && pct < 100, `pct_geh_lt5 ${pct}`);
    assert.ok(Number.isFinite(Number(sum.rmse)) && Number(sum.rmse) > 0);
    assert.ok(Number.isFinite(Number(sum.mae)) && Number.isFinite(Number(sum.bias)));
    // the rate contract: simulated and observed hourly flows must be the same order of magnitude
    const ratio = await one(c, `SELECT median(sim_flow_h / obs_flow_h) r FROM v_det_validation WHERE obs_flow_h > 50`);
    assert.ok(Number(ratio.r) > 0.3 && Number(ratio.r) < 3, `median sim/obs ${ratio.r}`);

    // source selectable: validation-only is a subset of both
    for (const s of stmts(buildAdapterSql({ obsSource: "validation" }))) await c.run(s);
    const v = await one(c, `SELECT count(DISTINCT detector_id) n FROM v_det_validation`);
    assert.ok(Number(v.n) <= n && Number(v.n) >= 400, `validation-only matched ${v.n}`);
    c.closeSync();
  });
}

test("real AMPK_3: v_sp_obs profile", { skip: !(ROOT && existsSync(join(ROOT, "AMPK_3", "subpath_obs_jt.parquet"))) && NODATA }, async () => {
  const c = await open("AMPK_3");
  for (const s of stmts(buildSubpathSql({ bucketMinutes: 60 }))) await c.run(s);
  const r = await all(c, `SELECT * FROM v_sp_obs WHERE route = 'Al Ain Road' AND source = 'monthly_15min' AND direction_norm = 'IB' ORDER BY bucket_start_min`);
  assert.equal(r.length, 24);
  const h7 = r.find((x) => Number(x.bucket_start_min) === 420)!;
  assert.ok(Number(h7.n_days) > 20, `n_days ${h7.n_days}`);
  assert.ok(Number(h7.median_s) > 20 && Number(h7.median_s) < 600);
  console.log(`Al Ain Road IB 07:00 monthly: n_days=${h7.n_days} mean=${Number(h7.mean_s).toFixed(1)} median=${Number(h7.median_s).toFixed(1)}`);
  c.closeSync();
});

// ---- independent checks of the validation maths against the real tables --------------------------------------
for (const [run, startMin] of [["AMPK_3", 420], ["PMPK_3", 1020]] as const) {
  test(`real ${run}: GEH on hourly rates (m = sim, c = obs), %GEH<5, partial buckets, obs end-label, validation/calibration dedup`, { skip: !have(run) && NODATA }, async () => {
    const c = await open(run);
    const raw = (f: string) => join(ROOT!, run, f).replace(/\\/g, "/").replace(/'/g, "''");

    // GEH recomputed in JS from the view's hourly flows; m = sim_flow_h, c = obs_flow_h, GEH = sqrt(2 (m-c)^2 / (m+c))
    const v = await all(c, `SELECT detector_id, oid, sim_flow_h m, obs_flow_h c, diff, rel_error, geh, status FROM v_det_validation`);
    assert.ok(v.length > 400);
    let lt5 = 0;
    for (const r of v) {
      const m = Number(r.m), cc = Number(r.c);
      assert.ok(Math.abs(Number(r.geh) - geh(m, cc)) < 1e-9, `geh ${r.detector_id}`);
      assert.ok(Math.abs(Number(r.diff) - (m - cc)) < 1e-9, "diff = sim - obs");
      if (cc !== 0) assert.ok(Math.abs(Number(r.rel_error) - (m - cc) / cc) < 1e-9);
      else assert.equal(r.rel_error, null);
      assert.equal(r.status, geh(m, cc) < 5 ? "pass" : geh(m, cc) <= 10 ? "warn" : "fail");
      if (geh(m, cc) < 5) lt5++;
    }
    const sum = await one(c, `SELECT pct_geh_lt5, n FROM v_det_summary`);
    assert.equal(Number(sum.n), v.length);
    assert.ok(Math.abs(Number(sum.pct_geh_lt5) - (100 * lt5) / v.length) < 1e-9, "%GEH<5 = share of rows with GEH < 5");
    // rates: a one-row 60-minute simulated rate is passed through unchanged (not multiplied/divided)
    const o1 = await one(c, `SELECT oid FROM v_det_validation ORDER BY oid LIMIT 1`);
    const sim1 = await one(c, `SELECT flow AS f FROM v_sim_norm WHERE oid = ${Number(o1.oid)}`);
    const v1 = await one(c, `SELECT sim_flow_h FROM v_det_validation WHERE oid = ${Number(o1.oid)}`);
    assert.ok(Math.abs(Number(sim1.f) - Number(v1.sim_flow_h)) < 1e-9, "one 60-min rate row -> the same veh/h");

    // observed hourly flow of one detector straight from the RAW parquet: mean of the 12 five-minute rates labelled (h:05 .. h+1:00]
    const d = await one(c, `SELECT detector_id FROM v_det_validation WHERE obs_flow_h > 0 ORDER BY detector_id LIMIT 1`);
    const id = String(d.detector_id).replace(/'/g, "''");
    const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
    const hh1 = String(Math.floor(startMin / 60) + 1).padStart(2, "0");
    const direct = await one(c, `
      WITH r AS (SELECT ts, flow, ROW_NUMBER() OVER (PARTITION BY detector_id, ts ORDER BY CASE source_file WHEN 'validation' THEN 0 ELSE 1 END) rn
                 FROM read_parquet('${raw("detectors_obs.parquet")}') WHERE detector_id = '${id}' AND flow IS NOT NULL)
      SELECT avg(flow) f, count(*) n FROM r WHERE rn = 1 AND ts >= TIMESTAMP '2025-01-01 ${hh}:05:00' AND ts <= TIMESTAMP '2025-01-01 ${hh1}:00:00'`);
    const viaView = await one(c, `SELECT obs_flow_h FROM v_det_validation WHERE detector_id = '${id}'`);
    assert.equal(Number(direct.n), 12, "12 five-minute intervals labelled (h:05 .. h+1:00]");
    assert.ok(Math.abs(Number(direct.f) - Number(viaView.obs_flow_h)) < 1e-9, "end-labelled ts: (h:00, h+1:00] belongs to hour h");
    // the stamp 00:00 of the NEXT day is the last interval of day one (t_start 1435), never the first of day two
    const last = await one(c, `SELECT max(t_start_min) AS m FROM v_obs_norm`);
    assert.equal(Number(last.m), 1435);

    // partial buckets: every validated row is backed by FULL 60-minute coverage on both sides
    const cov = await one(c, `
      SELECT min(s.cov) AS smin, min(o.cov) AS omin FROM v_det_validation v
      JOIN (SELECT CAST(eid AS VARCHAR) AS eid, CAST(floor(t_start_min / 60) AS INTEGER) * 60 AS b, SUM(dur_min) AS cov FROM v_sim_norm GROUP BY 1, 2) s ON s.eid = v.detector_id AND s.b = v.bucket_start_min
      JOIN (SELECT CAST(detector_id AS VARCHAR) AS eid, CAST(floor(t_start_min / 60) AS INTEGER) * 60 AS b, SUM(dur_min) AS cov FROM v_obs_norm GROUP BY 1, 2) o ON o.eid = v.detector_id AND o.b = v.bucket_start_min`);
    assert.ok(Number(cov.smin) >= 60 && Number(cov.omin) >= 60);
    const full = await one(c, `SELECT count(*) n FROM v_det_validation`);
    for (const s of stmts(buildViewsSql({ only: ["det"], requireFullBuckets: false, ...ADAPTED_RELATIONS }))) await c.run(s);
    const part = await one(c, `SELECT count(*) n FROM v_det_validation`);
    assert.ok(Number(part.n) >= Number(full.n), `partial buckets can only add rows (${part.n} >= ${full.n})`);
    for (const s of stmts(buildViewsSql({ only: ["det"], ...ADAPTED_RELATIONS }))) await c.run(s);

    // validation/calibration overlap: de-duplicated by (detector_id, ts); report whether overlapping stamps carry equal flows
    const ov = await one(c, `
      SELECT count(*) AS n, count(*) FILTER (WHERE abs(a.flow - b.flow) > 1e-9) AS n_diff
      FROM read_parquet('${raw("detectors_obs.parquet")}') a JOIN read_parquet('${raw("detectors_obs.parquet")}') b
        ON a.detector_id = b.detector_id AND a.ts = b.ts AND a.source_file = 'validation' AND b.source_file = 'calibration'`);
    console.log(`${run} validation/calibration overlap: ${ov.n} stamps, ${ov.n_diff} with different flow`);
    assert.ok(Number(ov.n) > 0, "the two files overlap");
    const rawN = await one(c, `SELECT count(*) n, count(DISTINCT (detector_id, ts)) AS nd FROM read_parquet('${raw("detectors_obs.parquet")}') WHERE flow IS NOT NULL`);
    assert.ok(Number(rawN.nd) < Number(rawN.n), "duplicates exist in the raw files");
    const adapted = await one(c, `SELECT count(*) AS n FROM v_obs_norm`);
    assert.ok(Number(adapted.n) <= Number(rawN.nd), "one row per distinct (detector_id, ts)");
    c.closeSync();
  });

  test(`real ${run}: eid-less simulated detectors are excluded and reported, no eid is shared by two oids`, { skip: !have(run) && NODATA }, async () => {
    const c = await open(run);
    const shared = await one(c, `SELECT count(*) AS n FROM (SELECT eid FROM v_sim_norm WHERE eid IS NOT NULL AND trim(eid) <> '' GROUP BY eid HAVING count(DISTINCT oid) > 1)`);
    assert.equal(Number(shared.n), 0, "no eid is shared by two oids");
    const u = await one(c, `SELECT * FROM v_det_unmatched_sim_summary`);
    assert.equal(Number(u.n_oids), 53);
    assert.ok(Number(u.n_with_flow) >= 51 && Number(u.n_with_flow) <= 53, `n_with_flow ${u.n_with_flow}`);
    const inVal = await one(c, `SELECT count(*) AS n FROM v_det_validation WHERE detector_id IS NULL OR trim(detector_id) = '' OR oid IN (SELECT oid FROM v_det_unmatched_sim)`);
    assert.equal(Number(inVal.n), 0, "eid-less detectors never reach the validation");
    const dup = await one(c, `SELECT count(*) AS n FROM (SELECT detector_id, bucket_start_min FROM v_det_validation GROUP BY ALL HAVING count(*) > 1)`);
    assert.equal(Number(dup.n), 0, "one validation row per detector and bucket");
    console.log(`${run} unmatched sim detectors: ${u.n_oids} oids, ${u.n_with_flow} with flow`);
    c.closeSync();
  });
}
