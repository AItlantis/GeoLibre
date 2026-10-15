// C11: period matching of time-only typical-day observations against a simulated run.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql.ts";
import { buildSimSql } from "../src/simtable.ts";
import {
  aggregates, bucketContains, DEFAULT_PERIOD_CONFIG, derivePeriod, divergingColour, matchPeriod, obsPointsOf, parsePeriodInfo, parseRunPeriod, periodAvailability,
  resolvePeriodConfig, routeRowsFromPairs, toValidationPairs, type PeriodConfig,
} from "../src/period.ts";
import { comparisonMode, toObsRows } from "../src/profile.ts";
import { DEFAULT_CRITERIA, type Criteria } from "../src/validation.ts";
import { memConn, rows, runScript, type DuckDBConnection } from "./helpers.ts";
import { H, JUMEIRA, SRC, SYNTH, jumeiraAm, obs, sim } from "./fixtures/c11c12.ts";

const AM = { start_s: 7 * H, end_s: 10 * H, interval_s: 300, day: null, source: "scenario" };
const cfg = (over: Partial<PeriodConfig> = {}): PeriodConfig => ({ ...DEFAULT_PERIOD_CONFIG, runPeriod: AM, ...over });
const near = (a: number | null, b: number, eps = 1e-9): void => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} != ${b}`);
const [R1, R2, R3, R4, R5, R6] = JUMEIRA;

test("Jumeira micro run, AM 07:00-10:00: 09:00 pairs with the bucket ENDING at 09:00, 18:00 is outside with the reason", () => {
  const { obs: o, sim: s } = jumeiraAm();
  const res = matchPeriod(obsPointsOf(o, SRC).points, s, cfg(), DEFAULT_CRITERIA, "AM");
  assert.equal(res.periodLabel, "07:00-10:00");
  assert.equal(res.pairs.length, 4); // R1, R2, R3, R6 at 09:00
  const byRoute = new Map(res.pairs.map((p) => [p.route, p]));
  // interval-end: (08:55, 09:00] is bucket index 23 -> base + 23
  near(byRoute.get(R1.route)!.sim, R1.base + 23);
  assert.equal(byRoute.get(R1.route)!.timeLabel, "09:00");
  assert.equal(byRoute.get(R1.route)!.status, "pass"); // inside supplied band
  assert.equal(byRoute.get(R1.route)!.inBand, true);
  assert.equal(byRoute.get(R2.route)!.status, "warn"); // +20 %, outside band
  near(byRoute.get(R2.route)!.errorPct, 20, 1e-6);
  assert.equal(byRoute.get(R2.route)!.inBand, false);
  assert.equal(byRoute.get(R3.route)!.status, "fail"); // +50 %
  assert.equal(byRoute.get(R6.route)!.status, "pass"); // no band, |err| < 15 %
  assert.equal(byRoute.get(R6.route)!.inBand, null);
  // unpaired: 18:00 x3 outside, Route 05 without simulation
  const outside = res.unpaired.filter((u) => u.code === "outside-period");
  assert.equal(outside.length, 3);
  assert.ok(outside.every((u) => u.timeLabel === "18:00" && u.reason === "outside the simulated period 07:00-10:00"));
  assert.deepEqual(res.unpaired.filter((u) => u.code === "no-sim-route").map((u) => u.route), [R5.route]);
  assert.deepEqual(res.obsOnlyRoutes, [`${R5.route} - ${R5.dir}`]);
  assert.deepEqual(res.simOnlyRoutes, []);
  // aggregates
  const a = aggregates(res.pairs);
  assert.equal(a.n, 4);
  assert.equal(a.nRoutes, 4);
  assert.equal(a.nBand, 3);
  near(a.bandHitRate, 100 / 3);
  assert.equal(a.nPass, 2);
  assert.equal(a.nWarn, 1);
  assert.equal(a.nFail, 1);
  const pcts = res.pairs.map((p) => p.errorPct!);
  near(a.mape, pcts.reduce((x, y) => x + Math.abs(y), 0) / 4);
  near(a.bias, res.pairs.reduce((x, p) => x + (p.sim - p.obs), 0) / 4);
  assert.deepEqual(periodAvailability({ hasSim: true, simReason: null, hasObs: true, result: res }), { enabled: true, reason: null });
  // per-route rows take the worst status; validation pairs keep the clock minute
  const vp = toValidationPairs(res.pairs);
  assert.ok(vp.every((p) => p.bucket === 540));
  assert.equal(routeRowsFromPairs(vp).find((r) => r.route === R3.route)!.status, "fail");
});

test("convention decides the boundary tie: interval-end -> (start, end], interval-start -> [start, end)", () => {
  assert.equal(bucketContains(100, 300, 400, "interval-end"), true);
  assert.equal(bucketContains(100, 300, 100, "interval-end"), false);
  assert.equal(bucketContains(100, 300, 100, "interval-start"), true);
  assert.equal(bucketContains(100, 300, 400, "interval-start"), false);
  const o = [obs({ spec: R1, tS: 9 * H, mean: 700 })];
  const s = sim(R1, 7 * H, 10 * H, "AM");
  assert.equal(matchPeriod(obsPointsOf(o, SRC).points, s, cfg({ convention: "interval-end" })).pairs[0].sim, R1.base + 23);
  assert.equal(matchPeriod(obsPointsOf(o, SRC).points, s, cfg({ convention: "interval-start" })).pairs[0].sim, R1.base + 24);
  // a time strictly inside a bucket gives the same bucket under both conventions
  const mid = [obs({ spec: R1, tS: 9 * H + 120, mean: 700 })];
  assert.equal(matchPeriod(obsPointsOf(mid, SRC).points, s, cfg({ convention: "interval-end" })).pairs[0].sim, R1.base + 24);
  assert.equal(matchPeriod(obsPointsOf(mid, SRC).points, s, cfg({ convention: "interval-start" })).pairs[0].sim, R1.base + 24);
  // the period edges follow the same rule: under interval-end the first instant (07:00) is outside, the last (10:00) inside
  const edge = [obs({ spec: R1, tS: 7 * H, mean: 700 }), obs({ spec: R1, tS: 10 * H, mean: 700 })];
  const end = matchPeriod(obsPointsOf(edge, SRC).points, s, cfg({ convention: "interval-end" }));
  assert.deepEqual(end.pairs.map((p) => p.timeLabel), ["10:00"]);
  const start = matchPeriod(obsPointsOf(edge, SRC).points, s, cfg({ convention: "interval-start" }));
  assert.deepEqual(start.pairs.map((p) => p.timeLabel), ["07:00"]);
});

test("without a manifest run_period the span is derived from the simulated buckets themselves", () => {
  const s = sim(R1, 8 * H, 10 * H, "AM");
  const p = derivePeriod(s)!;
  assert.deepEqual([p.start_s, p.end_s, p.interval_s, p.source], [8 * H, 10 * H, 300, "subpath_sim_jt"]);
  const o = [obs({ spec: R1, tS: 9 * H, mean: 700 }), obs({ spec: R1, tS: 18 * H, mean: 700 }), obs({ spec: R1, tS: 7 * H + 1800, mean: 700 })];
  const res = matchPeriod(obsPointsOf(o, SRC).points, s, { ...DEFAULT_PERIOD_CONFIG, runPeriod: null });
  assert.equal(res.periodLabel, "08:00-10:00");
  assert.deepEqual(res.pairs.map((x) => x.timeLabel), ["09:00"]);
  assert.deepEqual(res.unpaired.map((x) => x.reason), ["outside the simulated period 08:00-10:00", "outside the simulated period 08:00-10:00"]);
  assert.equal(derivePeriod([]), null);
});

test("activation: static run (no simulated rows), all observations outside the period, no route in common", () => {
  const { obs: o, sim: s } = jumeiraAm();
  const pts = obsPointsOf(o, SRC).points;
  assert.deepEqual(periodAvailability({ hasSim: false, simReason: "no simulated subpath table for static runs", hasObs: true, result: null }), { enabled: false, reason: "no simulated subpath table for static runs" });
  assert.equal(periodAvailability({ hasSim: false, simReason: null, hasObs: true, result: null }).reason, "no simulated subpath table for static runs");
  // only 09:00 and 18:00 observed, run 11:00-13:00 -> both outside
  const only = pts.filter((p) => p.route === R1.route);
  const late = matchPeriod(only, sim(R1, 11 * H, 13 * H, "PM"), { ...DEFAULT_PERIOD_CONFIG, runPeriod: null });
  assert.deepEqual(periodAvailability({ hasSim: true, simReason: null, hasObs: true, result: late }), { enabled: false, reason: "observations (09:00, 18:00) are outside the simulated period 11:00-13:00" });
  // the exact example of the contract
  const am = matchPeriod(pts.filter((p) => p.tS === 18 * H), s, cfg());
  assert.equal(periodAvailability({ hasSim: true, simReason: null, hasObs: true, result: am }).reason, "observations (18:00) are outside the simulated period 07:00-10:00");
  // a simulated table that shares no route with the observations
  const other = matchPeriod(pts, sim(SYNTH[0], 7 * H, 10 * H, "AM"), cfg());
  assert.equal(periodAvailability({ hasSim: true, simReason: null, hasObs: true, result: other }).reason, "no observed route matches a simulated route");
});

test("window observations compare with the mean of the simulated buckets inside the window; partial / outside windows are listed", () => {
  const s = sim(R1, 7 * H, 10 * H, "AM"); // value = 700 + k
  // window 08:00-09:00 covers buckets (starts 28800..32100): k = 12..23 -> mean 700 + 17.5
  const w = [obs({ spec: R1, tS: 8 * H + 1800, mean: 700, min: 690, max: 730, win: [8 * H, 9 * H] })];
  const res = matchPeriod(obsPointsOf(w, SRC).points, s, cfg());
  assert.equal(res.pairs.length, 1);
  assert.equal(res.pairs[0].kind, "window");
  assert.equal(res.pairs[0].nBuckets, 12);
  near(res.pairs[0].sim, 717.5);
  assert.equal(res.pairs[0].timeLabel, "08:00-09:00");
  assert.equal(res.pairs[0].inBand, true);
  // window that reaches beyond the period
  const out = matchPeriod(obsPointsOf([obs({ spec: R1, tS: 9 * H + 1800, mean: 700, win: [9 * H, 11 * H] })], SRC).points, s, cfg());
  assert.equal(out.pairs.length, 0);
  assert.equal(out.unpaired[0].reason, "window 09:00-11:00 is not inside the simulated period 07:00-10:00");
  // matchMode 'point' ignores the declared window; 'window' without a declared window is reported
  const asPoint = matchPeriod(obsPointsOf(w, SRC).points, s, cfg({ matchMode: "point" }));
  assert.equal(asPoint.pairs[0].kind, "point");
  const noWin = matchPeriod(obsPointsOf([obs({ spec: R1, tS: 9 * H, mean: 700 })], SRC).points, s, cfg({ matchMode: "window" }));
  assert.equal(noWin.unpaired[0].code, "window-missing");
  // a window shorter than a bucket has no bucket inside
  const tiny = matchPeriod(obsPointsOf([obs({ spec: R1, tS: 8 * H, mean: 700, win: [8 * H, 8 * H + 120] })], SRC).points, s, cfg());
  assert.equal(tiny.unpaired[0].code, "no-window-bucket");
});

test("tolerance_s widens the period test and lets a point in a gap use the nearest bucket", () => {
  const s = sim(R1, 8 * H, 9 * H, "AM").filter((r) => r.interval_start_s !== 8 * H + 1800); // gap (08:30, 08:35]
  const inGap = [obs({ spec: R1, tS: 8 * H + 1800 + 150, mean: 700 })];
  const strict = matchPeriod(obsPointsOf(inGap, SRC).points, s, cfg({ runPeriod: { ...AM, start_s: 8 * H, end_s: 9 * H } }));
  assert.equal(strict.unpaired[0].code, "no-bucket");
  const tol = matchPeriod(obsPointsOf(inGap, SRC).points, s, cfg({ runPeriod: { ...AM, start_s: 8 * H, end_s: 9 * H }, toleranceS: 200 }));
  assert.equal(tol.pairs.length, 1);
  const justOutside = [obs({ spec: R1, tS: 9 * H + 60, mean: 700 })];
  assert.equal(matchPeriod(obsPointsOf(justOutside, SRC).points, s, cfg({ runPeriod: { ...AM, start_s: 8 * H, end_s: 9 * H } })).pairs.length, 0);
  assert.equal(matchPeriod(obsPointsOf(justOutside, SRC).points, s, cfg({ runPeriod: { ...AM, start_s: 8 * H, end_s: 9 * H }, toleranceS: 120 })).pairs.length, 1);
});

test("a second synthetic model (different names, directions, clock times) pairs with no Jumeira dependence", () => {
  const [a, b] = SYNTH;
  const o = [obs({ spec: a, tS: 15 * H + 1800, mean: a.base + 4, min: a.base, max: a.base + 10 }), obs({ spec: b, tS: 15 * H + 1800, mean: 100 })];
  const s = [...sim(a, 15 * H, 16 * H, "PM"), ...sim(b, 15 * H, 16 * H, "PM")];
  const res = matchPeriod(obsPointsOf(o, SRC).points, s, { ...DEFAULT_PERIOD_CONFIG, runPeriod: null }, DEFAULT_CRITERIA, "PM");
  assert.equal(res.periodLabel, "15:00-16:00");
  const pa = res.pairs.find((p) => p.route === a.route)!;
  near(pa.sim, a.base + 5); // 15:30 -> bucket (15:25, 15:30] index 5
  assert.equal(pa.status, "pass");
  const pb = res.pairs.find((p) => p.route === b.route)!;
  assert.equal(pb.status, "fail"); // 340 + 5 vs 100
  assert.deepEqual(res.unpaired, []);
});

test("custom thresholds change the status (editable criteria): warn limit 60 % turns the +50 % route from fail to warn", () => {
  const { obs: o, sim: s } = jumeiraAm();
  const loose: Criteria = { ...DEFAULT_CRITERIA, failPct: 60 };
  const res = matchPeriod(obsPointsOf(o, SRC).points, s, cfg(), loose);
  assert.equal(res.pairs.find((p) => p.route === R3.route)!.status, "warn");
});

test("manifest: run_period, observed_sources (matchMode / convention / tolerance_s / declared) are read; defaults otherwise (old packages)", () => {
  assert.deepEqual(parsePeriodInfo({ schema_version: 1, files: [] }), { runPeriods: {}, defaultPeriod: null, sources: [] });
  assert.equal(parseRunPeriod({ start_s: 10, end_s: 5 }), null);
  const m = {
    schema_version: 1, files: [],
    run_period: { start_s: 25200, end_s: 36000, interval_s: 300, day: null, source: "sim_info" },
    runs: [{ run: "PM", run_period: { start_s: 54000, end_s: 61200, source: "scenario" } }],
    observed_sources: [
      { source_id: "jt1", file: "Resources/journeytime.csv", role: "journey_time", matchMode: "window", convention: "interval-start", tolerance_s: 60, declared: true },
      { source_id: "c1", file: "counts.csv", role: "counts", matchMode: "point" },
    ],
  };
  const info = parsePeriodInfo(m);
  assert.equal(info.defaultPeriod!.source, "sim_info");
  assert.equal(info.runPeriods.PM.start_s, 54000);
  assert.equal(info.sources.length, 1); // counts source ignored
  const c = resolvePeriodConfig(info, { source: "journeytime.csv", source_id: null }, "PM");
  assert.deepEqual([c.matchMode, c.convention, c.toleranceS, c.declared, c.runPeriod!.start_s], ["window", "interval-start", 60, true, 54000]);
  const d = resolvePeriodConfig(info, { source: "other.csv", source_id: "zzz" }, "AM");
  assert.deepEqual([d.matchMode, d.convention, d.toleranceS, d.declared, d.runPeriod!.start_s], ["auto", "interval-end", 0, false, 25200]);
  const old = resolvePeriodConfig(parsePeriodInfo({}), { source: SRC }, null);
  assert.deepEqual(old, DEFAULT_PERIOD_CONFIG);
});

test("diverging colour: white at 0, blue negative, red positive, grey without a value", () => {
  assert.equal(divergingColour(0), "#f7f7f7");
  assert.equal(divergingColour(50), "#b2182b");
  assert.equal(divergingColour(-50), "#2166ac");
  assert.equal(divergingColour(500), "#b2182b");
  assert.equal(divergingColour(null), "#9ca3af");
});

let conn: DuckDBConnection;
before(async () => {
  conn = await memConn();
});

test("end to end through DuckDB: v_sp_obs keeps the exact clock time (t_s), v_sp_sim keeps interval spans; legacy views are unchanged", async () => {
  await runScript(
    conn,
    `CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR, subpath_oid VARCHAR, match_method VARCHAR,
       seconds_min DOUBLE, seconds_max DOUBLE, window_start_s DOUBLE, window_end_s DOUBLE, dateKind VARCHAR, source_id VARCHAR);
     INSERT INTO subpath_obs_jt VALUES
       ('${R1.route}','NB',TIMESTAMP '2000-01-01 09:00:00',720,'${SRC}','${R1.oid}','exact-name',700,740,NULL,NULL,'typical','jt1'),
       ('${R1.route}','NB',TIMESTAMP '2000-01-01 18:00:00',800,'${SRC}','${R1.oid}','exact-name',780,820,NULL,NULL,'typical','jt1'),
       ('${R2.route}','SB',TIMESTAMP '2000-01-01 09:07:30',600,'${SRC}','${R2.oid}','exact-name',580,620,NULL,NULL,'typical','jt1');
     CREATE TABLE subpath_sim_jt(route VARCHAR, direction_norm VARCHAR, subpath_oid BIGINT, ts TIMESTAMP, ts_bucket TIMESTAMP, seconds DOUBLE, run VARCHAR, interval_start_s DOUBLE, duration_s DOUBLE);`,
  );
  const sims = [R1, R2].flatMap((r) => sim(r, 7 * H, 10 * H, "AM"));
  for (const r of sims) {
    await conn.run(`INSERT INTO subpath_sim_jt VALUES ('${r.route}','${r.direction_norm}',1,TIMESTAMP '2000-01-01 00:00:00' + to_seconds(${r.interval_start_s! + r.duration_s!}),TIMESTAMP '2000-01-01 00:00:00' + to_seconds(${r.interval_start_s! + r.duration_s!}),${r.sim_s},'AM',${r.interval_start_s},${r.duration_s})`);
  }
  const cols = ["route", "direction_norm", "ts", "seconds", "source", "subpath_oid", "match_method", "seconds_min", "seconds_max", "window_start_s", "window_end_s", "dateKind", "source_id"];
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15, columns: cols }));
  const obsRows = toObsRows(await rows(conn, "SELECT * FROM v_sp_obs ORDER BY route, bucket_start_min"));
  const r2 = obsRows.find((r) => r.route === R2.route)!;
  assert.equal(r2.bucket_start_min, 540); // 15-minute bucket 09:00
  assert.equal(r2.t_s, 9 * H + 450); // but the exact time survives
  assert.equal(obsRows.find((r) => r.route === R1.route && r.bucket_start_min === 1080)!.t_s, 18 * H);
  await runScript(conn, buildSimSql(15, "temporal", ["route", "direction_norm", "ts_bucket", "seconds", "run", "interval_start_s", "duration_s"]));
  const simRows = (await rows(conn, "SELECT route, direction_norm, bucket_start_min, interval_start_s, duration_s, sim_s, n, run FROM v_sp_sim")).map((r) => ({
    route: String(r.route), direction_norm: String(r.direction_norm), bucket_start_min: Number(r.bucket_start_min), sim_s: Number(r.sim_s), n: Number(r.n),
    interval_start_s: Number(r.interval_start_s), duration_s: Number(r.duration_s), run: String(r.run),
  }));
  const res = matchPeriod(obsPointsOf(obsRows, SRC).points, simRows, { ...DEFAULT_PERIOD_CONFIG, runPeriod: null }, DEFAULT_CRITERIA, "AM");
  assert.equal(res.periodLabel, "07:00-10:00");
  const p1 = res.pairs.find((p) => p.route === R1.route)!;
  near(p1.sim, R1.base + 23);
  near(p1.errorS, R1.base + 23 - 720);
  // 09:07:30 lies in the bucket (09:05, 09:10] = index 25
  near(res.pairs.find((p) => p.route === R2.route)!.sim, R2.base + 25);
  assert.equal(res.unpaired.length, 1);
  assert.equal(res.unpaired[0].reason, "outside the simulated period 07:00-10:00");
  // legacy five-column input: no extended view columns, comparison rule untouched
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15 }));
  const legacy = await rows(conn, "DESCRIBE v_sp_obs");
  assert.ok(!legacy.some((c) => c.column_name === "t_s"));
  assert.equal(comparisonMode([]).mode, "profile-only");
});
