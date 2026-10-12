import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql.ts";
import { toObsRows, type ObsRow } from "../src/profile.ts";
import { buildSimSql, classifyTsType, missingSimColumns } from "../src/simtable.ts";
import { kpis, pairObsSim, perRoute, points, type SimRow } from "../src/validation.ts";
import { memConn, rows, runScript, type DuckDBConnection } from "./helpers.ts";

const near = (a: number | null, b: number, eps = 1e-9): void => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} != ${b}`);

const ob = (route: string, dir: string, bucket: number, mean: number, median = mean, source = "monthly_15min"): ObsRow => ({
  route, direction_norm: dir, source, bucket_start_min: bucket, n_days: 3, mean_s: mean, median_s: median, min_s: mean - 1, max_s: mean + 1,
});
const sm = (route: string, dir: string, bucket: number, sim_s: number): SimRow => ({ route, direction_norm: dir, bucket_start_min: bucket, sim_s, n: 1 });

test("kpis: hand-computed (obs 10/20/30 vs sim 11/18/36, tolerance 15%)", () => {
  const k = kpis([10, 20, 30], [11, 18, 36], 15);
  assert.equal(k.count, 3);
  near(k.bias, 5 / 3);
  near(k.rmse, Math.sqrt(41 / 3));
  near(k.mae, 3);
  near(k.pctWithin, 200 / 3); // 10%, 10%, 20%
  near(k.meanRatio, (1.1 + 0.9 + 1.2) / 3);
  // OLS of sim on obs: slope = Sxy/Sxx = (-10*-6.667... ) computed independently
  const mx = 20, my = 65 / 3;
  const sxy = (10 - mx) * (11 - my) + 0 + (30 - mx) * (36 - my);
  near(k.slope, sxy / 200);
  near(k.intercept, my - (sxy / 200) * mx);
  assert.equal(kpis([10], [10], 15).pctWithin, 100);
  assert.equal(kpis([], [], 15).count, 0);
  assert.equal(kpis([], [], 15).pctWithin, null);
  // the tolerance boundary is inclusive
  assert.equal(kpis([100], [115], 15).pctWithin, 100);
  assert.equal(kpis([100], [115.5], 15).pctWithin, 0);
  // non-positive obs cannot define a ratio: excluded from %within and mean ratio
  assert.equal(kpis([0, 10], [1, 10], 15).pctWithin, 100);
});

test("pairObsSim: key normalisation (case/space/In-IB), window, statistic, orphans", () => {
  const obs = [
    ob("Route A", "IB", 420, 100, 90),
    ob("Route A", "IB", 435, 110, 95),
    ob("Route A", "IB", 450, 120, 99),
    ob("Route B", "OB", 420, 50),
    ob("Only Obs", "IB", 420, 70),
    ob("Route C", "IB", 600, 80),
  ];
  const sim = [
    sm("route  a", "In", 420, 105),
    sm("route  a", "In", 435, 115),
    sm("route  a", "In", 450, 125),
    sm("Route B", "Out", 420, 60),
    sm("Only Sim", "IB", 420, 33),
    sm("Route C", "IB", 420, 80), // same route but a different bucket than obs (600): no overlap
  ];
  const r = pairObsSim(obs, sim, "mean", null);
  assert.deepEqual(r.pairs.map((p) => [p.route, p.bucket, p.obs, p.sim]), [
    ["Route A", 420, 100, 105],
    ["Route A", 435, 110, 115],
    ["Route A", 450, 120, 125],
    ["Route B", 420, 50, 60],
  ]);
  assert.deepEqual(r.obsOnly, ["Only Obs - IB"]);
  assert.deepEqual(r.simOnly, ["Only Sim - IB"]);
  assert.deepEqual(r.noOverlap, ["Route C - IB"]);
  // median statistic
  assert.deepEqual(pairObsSim(obs, sim, "median", null).pairs.filter((p) => p.route === "Route A").map((p) => p.obs), [90, 95, 99]);
  // window [435, 450) keeps one bucket of route A and drops B
  const w = pairObsSim(obs, sim, "mean", { from: 435, to: 450 });
  assert.deepEqual(w.pairs.map((p) => p.bucket), [435]);
  assert.deepEqual(w.noOverlap.sort(), ["Route B - OB", "Route C - IB"]);
});

test("perRoute / points: means over paired buckets, ratio, level switch", () => {
  const pairs = [
    { key: "a|IB", route: "A", direction: "IB", bucket: 420, obs: 100, sim: 120 },
    { key: "a|IB", route: "A", direction: "IB", bucket: 435, obs: 200, sim: 180 },
    { key: "b|OB", route: "B", direction: "OB", bucket: 420, obs: 50, sim: 25 },
  ];
  const r = perRoute(pairs);
  assert.deepEqual(r.map((x) => [x.route, x.nBuckets, x.obs, x.sim, x.delta]), [["A", 2, 150, 150, 0], ["B", 1, 50, 25, -25]]);
  assert.equal(r[1].ratio, 0.5);
  assert.deepEqual(points(pairs, "route").obs, [150, 50]);
  assert.deepEqual(points(pairs, "bucket").sim, [120, 180, 25]);
});

test("simtable: ts type classification and column check", () => {
  assert.equal(classifyTsType("TIMESTAMP"), "temporal");
  assert.equal(classifyTsType("TIMESTAMP WITH TIME ZONE"), "temporal");
  assert.equal(classifyTsType("TIME"), "temporal");
  assert.equal(classifyTsType("INTEGER"), "numeric");
  assert.equal(classifyTsType("DOUBLE"), "numeric");
  assert.equal(classifyTsType("DECIMAL(9,2)"), "numeric");
  assert.equal(classifyTsType("VARCHAR"), "text");
  assert.equal(classifyTsType("BLOB"), null);
  assert.deepEqual(missingSimColumns(["Route", "direction_norm", "ts_bucket", "seconds"]), []);
  assert.deepEqual(missingSimColumns(["route", "seconds"]), ["direction_norm", "ts_bucket"]);
  assert.throws(() => buildSimSql(7, "temporal"), /divisor of 1440/);
});

// ---- SQL against native DuckDB (same SQL as duckdb-wasm) --------------------------------------
let conn: DuckDBConnection;
before(async () => {
  conn = await memConn();
});

test("v_sp_sim: temporal / numeric-minutes / text ts_bucket all give the same buckets; replications averaged", async () => {
  for (const [kind, type, a, b] of [
    ["temporal", "TIMESTAMP", "TIMESTAMP '2025-02-03 07:20:00'", "TIMESTAMP '2025-02-03 07:35:00'"],
    ["temporal", "TIME", "TIME '07:20:00'", "TIME '07:35:00'"],
    ["numeric", "INTEGER", "440", "455"], // minutes since midnight
    ["text", "VARCHAR", "'07:20'", "'2025-02-03 07:35:00'"],
  ] as const) {
    await runScript(
      conn,
      `DROP TABLE IF EXISTS subpath_sim_jt;
       CREATE TABLE subpath_sim_jt(route VARCHAR, direction_norm VARCHAR, ts_bucket ${type}, seconds DOUBLE);
       INSERT INTO subpath_sim_jt VALUES ('R','IB',${a},90),('R','IB',${a},110),('R','IB',${b},50),('R','IB',${a},0),('R','IB',${b},NULL);`,
    );
    await runScript(conn, buildSimSql(15, kind));
    const r = await rows(conn, "SELECT bucket_start_min, sim_s, n FROM v_sp_sim ORDER BY 1");
    assert.deepEqual(r.map((x) => [Number(x.bucket_start_min), Number(x.sim_s), Number(x.n)]), [[435, 100, 2], [450, 50, 1]], `${type}`); // 07:20 -> 07:15 bucket, 07:35 -> 07:30 bucket
  }
  // hourly buckets merge both: (90+110+50)/3
  await runScript(conn, buildSimSql(60, "text"));
  const h = await rows(conn, "SELECT bucket_start_min, sim_s, n FROM v_sp_sim");
  assert.deepEqual(h.map((x) => [Number(x.bucket_start_min), Number(x.n)]), [[420, 3]]);
  assert.ok(Math.abs(Number(h[0].sim_s) - 250 / 3) < 1e-9);
});

test("synthetic fixture package: end-to-end numbers equal the independently computed expectation", async () => {
  const dir = new URL("./fixtures/", import.meta.url);
  const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));
  const pkg = new URL("pkg/", dir).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  await runScript(
    conn,
    `DROP TABLE IF EXISTS subpath_obs_jt; DROP TABLE IF EXISTS subpath_sim_jt;
     CREATE TABLE subpath_obs_jt AS SELECT * FROM read_parquet('${pkg}subpath_obs_jt.parquet');
     CREATE TABLE subpath_sim_jt AS SELECT * FROM read_parquet('${pkg}subpath_sim_jt.parquet');`,
  );
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15 }));
  await runScript(conn, buildSimSql(15, "temporal"));
  const obs = toObsRows(await rows(conn, "SELECT * FROM v_sp_obs"));
  const sim: SimRow[] = (await rows(conn, "SELECT * FROM v_sp_sim")).map((r) => ({ route: String(r.route), direction_norm: String(r.direction_norm), bucket_start_min: Number(r.bucket_start_min), sim_s: Number(r.sim_s), n: Number(r.n) }));

  // sources never mixed: the 999 s subnetwork rows must not leak into the monthly pairing
  const monthly = obs.filter((r) => r.source === "monthly_15min");
  const res = pairObsSim(monthly, sim, "mean", null);
  assert.deepEqual(res.obsOnly, expected.obsOnly);
  assert.deepEqual(res.simOnly, expected.simOnly);
  assert.equal(res.pairs.length, 24);
  assert.ok(res.pairs.every((p) => p.obs < 500));

  const rr = perRoute(res.pairs);
  assert.deepEqual(rr.map((r) => `${r.route} - ${r.direction}`), expected.perRoute.map((r: { route: string; direction: string }) => `${r.route} - ${r.direction}`));
  rr.forEach((r, i) => {
    near(r.obs, expected.perRoute[i].obs);
    near(r.sim, expected.perRoute[i].sim);
    near(r.ratio, expected.perRoute[i].ratio);
  });
  for (const [level, exp] of [["route", expected.routeLevel], ["bucket", expected.bucketLevel]] as const) {
    const p = points(res.pairs, level);
    const k = kpis(p.obs, p.sim, expected.tolerancePct);
    assert.equal(k.count, exp.n);
    for (const f of ["rmse", "bias", "slope", "intercept", "r2", "pctWithin", "meanRatio"] as const) near(k[f] as number, exp[f], 1e-9);
  }
  // route-level headline: 1 of 3 routes within +-15% (Alpha +10%; Beta +50%, Gamma -20% are out)
  near(kpis(points(res.pairs, "route").obs, points(res.pairs, "route").sim, 15).pctWithin, 100 / 3);
  // a wider tolerance admits Gamma (|-20%|) but not Beta
  near(kpis(points(res.pairs, "route").obs, points(res.pairs, "route").sim, 25).pctWithin, 200 / 3);
});
