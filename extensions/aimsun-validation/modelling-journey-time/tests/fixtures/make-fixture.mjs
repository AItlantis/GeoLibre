// Generates the SYNTHETIC validation package in ./pkg (committed): proves the plugin end to end while the real
// delivery has no simulated journey time. Deterministic; expected KPIs are computed here with plain JS
// (independent of the plugin code) and written to expected.json.
//   node tests/fixtures/make-fixture.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "../../../_shared/node_modules/@duckdb/node-api/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "pkg");
mkdirSync(out, { recursive: true });

const K = 8; // 07:00 .. 08:45 in 15-min buckets
const DAYS = [-6, 0, 6]; // per-day offsets around the bucket mean (mean and median of the 3 days = bucket value)
const ts = (day, k) => `2025-02-0${3 + day} ${String(7 + Math.floor((k * 15) / 60)).padStart(2, "0")}:${String((k * 15) % 60).padStart(2, "0")}:00`;

// obs bucket value per route (the mean/median across the 3 days)
const routes = [
  { obsRoute: "Route Alpha", obsDir: "IB", base: (k) => 100 + 10 * k, simRoute: "route alpha", simDir: "In", factor: 1.1 }, // +10%: within 15%
  { obsRoute: "Route Beta", obsDir: "OB", base: (k) => 60 + 5 * k, simRoute: "Route  Beta", simDir: "OB", factor: 1.5 }, // +50%
  { obsRoute: "Route Gamma", obsDir: "IB", base: (k) => 200 - 5 * k, simRoute: "Route Gamma", simDir: "IB", factor: 0.8 }, // -20%
  { obsRoute: "Route Delta", obsDir: "IB", base: (k) => 40 + k, simRoute: null }, // observed only
];
const simOnly = { route: "Route Echo", dir: "IB" };

const obsRows = [];
for (const r of routes) for (let d = 0; d < 3; d++) for (let k = 0; k < K; k++) obsRows.push([r.obsRoute, r.obsDir, ts(d, k), r.base(k) + DAYS[d], "monthly_15min"]);
// another source for Route Alpha: must stay separate (999 s)
for (let k = 0; k < K; k++) obsRows.push(["Route Alpha", "IB", ts(1, k), 999, "subnetwork_may2025"]);

const simRows = []; // CURVES: intervals are explicit; two runs have different validation quality.
const runFactors = { JT_A: { alpha: 1.1, beta: 1.5, gamma: 0.8 }, JT_B: { alpha: 1.0, beta: 1.2, gamma: 0.95 } };
for (const [run, factors] of Object.entries(runFactors)) for (const r of routes) {
  if (!r.simRoute) continue;
  const factor = r.obsRoute.endsWith("Alpha") ? factors.alpha : r.obsRoute.endsWith("Beta") ? factors.beta : factors.gamma;
  for (let k = 0; k < K; k++) for (const e of [-2, 2]) simRows.push([r.simRoute, r.simDir, (420 + k * 15) * 60, 900, r.base(k) * factor + e, run]);
}
for (const run of ["JT_A"]) for (let k = 0; k < K; k++) simRows.push([simOnly.route, simOnly.dir, (420 + k * 15) * 60, 900, 50, run]);

const conn = await (await DuckDBInstance.create(":memory:")).connect();
await conn.run("CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR)");
await conn.run("CREATE TABLE subpath_sim_jt(route VARCHAR, direction_norm VARCHAR, interval_start_s DOUBLE, duration_s DOUBLE, seconds DOUBLE, run VARCHAR)");
const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
await conn.run(`INSERT INTO subpath_obs_jt VALUES ${obsRows.map((r) => `(${lit(r[0])},${lit(r[1])},TIMESTAMP ${lit(r[2])},${r[3]},${lit(r[4])})`).join(",")}`);
await conn.run(`INSERT INTO subpath_sim_jt VALUES ${simRows.map((r) => `(${lit(r[0])},${lit(r[1])},${r[2]},${r[3]},${r[4]},${lit(r[5])})`).join(",")}`);
const files = [];
for (const [table, rows] of [["subpath_obs_jt", obsRows.length], ["subpath_sim_jt", simRows.length]]) {
  const p = join(out, `${table}.parquet`);
  await conn.run(`COPY ${table} TO '${p.replace(/\\/g, "/")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  files.push({ table, path: `${table}.parquet`, format: "parquet", sha256: createHash("sha256").update(readFileSync(p)).digest("hex"), rows });
}
writeFileSync(join(out, "manifest.json"), JSON.stringify({ schema_version: 1, run: "SYNTHETIC_JT_FIXTURE", note: "synthetic fixture for the subpath validation plugin tests - NOT model data", files }, null, 2) + "\n");

// ---- malformed variant: subpath_sim_jt without ts_bucket (the panel must say what is missing) ----------------
{
  const bad = join(here, "pkg_badsim");
  mkdirSync(bad, { recursive: true });
  await conn.run("CREATE TABLE sim_bad AS SELECT route, direction_norm, seconds FROM subpath_sim_jt");
  const bp = join(bad, "subpath_sim_jt.parquet");
  await conn.run(`COPY sim_bad TO '${bp.replace(/\\/g, "/")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  // the observed table is required by the panel: ship a copy next to it
  writeFileSync(join(bad, "subpath_obs_jt.parquet"), readFileSync(join(out, "subpath_obs_jt.parquet")));
  const manifest = {
    schema_version: 1,
    run: "SYNTHETIC_BAD_SIM",
    files: [
      { table: "subpath_obs_jt", path: "subpath_obs_jt.parquet", format: "parquet" },
      { table: "subpath_sim_jt", path: "subpath_sim_jt.parquet", format: "parquet" },
    ],
  };
  writeFileSync(join(bad, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// ---- independent expected values -------------------------------------------------------------
const ols = (x, y) => {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
  const sxy = x.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0);
  const syy = y.reduce((a, v) => a + (v - my) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const resid = x.reduce((a, v, i) => a + (y[i] - (slope * v + intercept)) ** 2, 0);
  return { slope, intercept, r2: 1 - resid / syy };
};
const stats = (x, y, tol) => {
  const n = x.length;
  const err = y.map((v, i) => v - x[i]);
  return {
    n,
    rmse: Math.sqrt(err.reduce((a, b) => a + b * b, 0) / n),
    bias: err.reduce((a, b) => a + b, 0) / n,
    ...ols(x, y),
    pctWithin: (100 * x.filter((v, i) => Math.abs(y[i] - v) / v <= tol / 100 + 1e-12).length) / n,
    meanRatio: y.reduce((a, v, i) => a + v / x[i], 0) / n,
  };
};
const perRoute = routes.filter((r) => r.simRoute).map((r) => {
  const o = Array.from({ length: K }, (_, k) => r.base(k));
  const s = o.map((v) => v * r.factor);
  return { route: r.obsRoute, direction: r.obsDir, obs: o.reduce((a, b) => a + b, 0) / K, sim: s.reduce((a, b) => a + b, 0) / K, ratio: r.factor, nBuckets: K, o, s };
});
const expected = {
  tolerancePct: 15,
  routeLevel: stats(perRoute.map((r) => r.obs), perRoute.map((r) => r.sim), 15),
  bucketLevel: stats(perRoute.flatMap((r) => r.o), perRoute.flatMap((r) => r.s), 15),
  perRoute: perRoute.map(({ o, s, ...r }) => r),
  obsOnly: ["Route Delta - IB"],
  simOnly: ["Route Echo - IB"],
};
writeFileSync(join(here, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
console.log(`fixture written to ${out}`);
console.log(JSON.stringify(expected.routeLevel));
