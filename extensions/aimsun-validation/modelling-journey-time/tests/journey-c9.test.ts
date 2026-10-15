// C9 (contracts_v5): Jumeira-like extended observed contract: verified oid, supplied bounds, time-only typical-day rows,
// NB/SB as own directions, unmatched/ambiguous reporting. Legacy five-column rows keep behaving as before.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql.ts";
import { buildMatching, normDirection, obsKey, pairKey, type SubpathRef } from "../src/match.ts";
import { manifestSimReason, subpathRefs } from "../src/pkg.ts";
import { colourScale, comparisonMode, declaredWindow, overlayFeatures, profileOf, toObsRows, valuesAtBucket, type ObsRow } from "../src/profile.ts";
import { memConn, rows, runScript, type DuckDBConnection } from "./helpers.ts";

const SRC = "journeytime.csv";
const EXT_COLUMNS = ["route", "direction_norm", "ts", "seconds", "source", "subpath_oid", "match_method", "seconds_min", "seconds_max", "window_start_s", "window_end_s", "dateKind", "source_id"];
const LEGACY_COLUMNS = ["route", "direction_norm", "ts", "seconds", "source"];

const R01 = "Route 01 - Jumeirah St NB";
const R02 = "Route 02 - Jumeirah St SB";
const R03 = "Route 03 - Al Wasl Rd NB";
const R04 = "Route 04 - Al Wasl Rd SB";
const R05 = "Route 05 - Umm Suqeim St NB";
const R06 = "Route 06 - Umm Suqeim St SB";

/** Stage A subpaths of the Jumeira model (oid -> exact name == journeytime.csv route name). */
const SUBPATHS: SubpathRef[] = [
  { id: 294383, name: R01, group: "JT Routes", exists: null },
  { id: 294384, name: R02, group: "JT Routes", exists: null },
  { id: 294382, name: R03, group: "JT Routes", exists: null },
  { id: 294380, name: R04, group: "JT Routes", exists: null },
  { id: 294385, name: R05, group: "JT Routes", exists: null },
  { id: 294386, name: R06, group: "JT Routes", exists: null },
];

let conn: DuckDBConnection;
let obs: ObsRow[];

const row = (route: string, dir: string, hhmm: string, mid: number, lo: number, hi: number, extra = "NULL, NULL, NULL, NULL"): string =>
  `('${route}','${dir}',TIMESTAMP '1970-01-01 ${hhmm}:00',${mid},'${SRC}',${extra.split(", ")[0]},${extra.split(", ")[1]},${lo},${hi},${extra.split(", ")[2]},${extra.split(", ")[3]},'typical','jt1')`;

before(async () => {
  conn = await memConn();
  await runScript(
    conn,
    `CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR,
       subpath_oid VARCHAR, match_method VARCHAR, seconds_min DOUBLE, seconds_max DOUBLE, window_start_s DOUBLE, window_end_s DOUBLE,
       dateKind VARCHAR, source_id VARCHAR);
     INSERT INTO subpath_obs_jt VALUES
       ${row(R01, "NB", "09:00", 780, 720, 840)}, ${row(R01, "NB", "18:00", 960, 900, 1020)},
       ${row(R02, "SB", "09:00", 700, 650, 760)}, ${row(R02, "SB", "18:00", 820, 780, 880)},
       ${row(R03, "", "09:00", 500, 450, 560)}, ${row(R03, "", "18:00", 540, 500, 600)},
       ${row(R04, "SB", "18:00", 610, 580, 650)},
       ${row("Renamed JT 05", "NB", "09:00", 400, 380, 430, "'294385', 'rds-oid', NULL, NULL")}, ${row("Renamed JT 05", "NB", "18:00", 450, 420, 480, "'294385', 'rds-oid', NULL, NULL")},
       ${row(R06, "SB", "09:00", 300, 280, 330)},
       ${row("Route 99 - Unknown St NB", "NB", "09:00", 200, 190, 210)};`,
  );
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15, columns: EXT_COLUMNS }));
  obs = toObsRows(await rows(conn, "SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
});

test("supplied bounds stay distinct from the across-day band (720/780/840 does not collapse to 780/780/780)", () => {
  const r = obs.find((x) => x.route === R01 && x.bucket_start_min === 540)!;
  assert.equal(r.mean_s, 780);
  assert.equal(r.sup_min_s, 720);
  assert.equal(r.sup_max_s, 840);
  assert.deepEqual([r.min_s, r.max_s], [780, 780]); // across-day band: one typical day, degenerate
  const p = profileOf(obs, R01, "NB", SRC);
  assert.equal(p.hasSupplied, true);
  assert.deepEqual(p.suppliedBand.map((b) => [b.x, b.lo, b.hi]), [[540, 720, 840], [1080, 900, 1020]]);
  assert.deepEqual(p.band.map((b) => [b.lo, b.hi]), [[780, 780], [960, 960]]);
  assert.equal(p.dateKind, "typical");
});

test("identity columns are carried by the views: oid, match_method, source_id, dateKind", () => {
  const r = obs.find((x) => x.route === "Renamed JT 05" && x.bucket_start_min === 540)!;
  assert.deepEqual([r.subpath_oid, r.match_method, r.source_id, r.date_kind], ["294385", "rds-oid", "jt1", "typical"]);
  const legacyId = obs.find((x) => x.route === R01)!;
  assert.deepEqual([legacyId.subpath_oid, legacyId.match_method], [null, null]);
});

test("time-only rows give an observed day profile at 09:00 and 18:00; a PM-only route has no AM value", () => {
  const am = valuesAtBucket(obs, 540, "mean", "seconds");
  const pm = valuesAtBucket(obs, 1080, "mean", "seconds");
  assert.equal(am.size, 6); // R01 R02 R03 + Renamed 05 + R06 + R99
  assert.equal(pm.size, 5); // R01 R02 R03 R04 + Renamed 05
  assert.ok(!am.has(obsKey(R04, "SB")));
  assert.equal(pm.get(obsKey(R04, "SB"))!.seconds, 610);
  assert.deepEqual(profileOf(obs, R04, "SB", SRC).mean.map((x) => x.x), [1080]);
});

test("NB/SB are their own directions and are never equated with IB/OB", () => {
  assert.equal(normDirection("NB"), "NB");
  assert.equal(normDirection("sb"), "SB");
  assert.notEqual(pairKey("Jumeirah St", "NB"), pairKey("Jumeirah St", "IB"));
  assert.notEqual(pairKey("Jumeirah St", "SB"), pairKey("Jumeirah St", "OB"));
  // the observed full name with its own direction token keys like the same route without a direction
  assert.equal(pairKey(R02, "SB"), pairKey(R02, ""));
  const m = buildMatching([{ route: "Jumeirah St", direction: "NB" }], [{ id: 1, name: "Jumeirah St_IB", group: null, exists: null }, { id: 2, name: "Jumeirah St_OB", group: null, exists: null }]);
  assert.equal(m.counts.obsMatched, 0);
  assert.equal(m.unmatchedObs[0].reason, "no-subpath");
  const same = buildMatching([{ route: "Jumeirah St", direction: "NB" }], [{ id: 1, name: "Jumeirah St_NB", group: null, exists: null }]);
  assert.equal(same.counts.obsMatched, 1);
  assert.equal(same.matchedObs[0].matches[0].method, "name-direction");
});

test("matching: exact names and a verified oid match; oid wins over the name; unmatched route is reported with a reason", () => {
  const pairs = [...new Map(obs.map((r) => [`${r.route}|${r.direction_norm}|${r.subpath_oid}`, { route: r.route, direction: r.direction_norm, source: r.source, subpath_oid: r.subpath_oid, match_method: r.match_method, source_id: r.source_id }])).values()];
  const m = buildMatching(pairs, SUBPATHS);
  assert.equal(m.counts.obsTotal, 7);
  assert.equal(m.counts.obsMatched, 6);
  assert.deepEqual(m.unmatchedObs.map((r) => [r.route, r.reason]), [["Route 99 - Unknown St NB", "no-subpath"]]);
  assert.equal(m.ambiguousObs.length, 0);
  const byRoute = new Map(m.matchedObs.map((r) => [r.route, r]));
  assert.equal(byRoute.get(R02)!.matches[0].subpath.id, 294384); // 'Route 02 - Jumeirah St SB' -> its own Stage A subpath
  assert.equal(byRoute.get(R02)!.matches[0].method, "exact-name");
  assert.equal(byRoute.get(R03)!.matches[0].subpath.id, 294382); // direction column empty: exact name still matches
  const renamed = byRoute.get("Renamed JT 05")!;
  assert.equal(renamed.matches[0].subpath.id, 294385);
  assert.equal(renamed.matches[0].method, "oid");
  assert.match(renamed.matches[0].via, /294385/);
  assert.equal(m.counts.subpathsMatched, 6);
  assert.equal(m.counts.subpathsUnmatched, 0);
});

test("a verified oid that is not in the model falls back to the exact name, else is reported", () => {
  const fallback = buildMatching([{ route: R01, direction: "NB", subpath_oid: "999", match_method: "crosswalk" }], SUBPATHS);
  assert.equal(fallback.matchedObs[0].matches[0].subpath.id, 294383);
  assert.equal(fallback.matchedObs[0].matches[0].method, "exact-name");
  const lost = buildMatching([{ route: "No such route", direction: "", subpath_oid: "999" }], SUBPATHS);
  assert.equal(lost.unmatchedObs[0].reason, "oid-not-in-model");
  assert.equal(lost.counts.subpathsUnmatched, 6); // nothing observed for them: listed, not dropped
});

test("two subpaths with the same exact name (no preferred group) are AMBIGUOUS: listed on both sides, none drawn", () => {
  const dup: SubpathRef[] = [
    { id: 1, name: R01, group: "A", exists: null },
    { id: 2, name: R01, group: "B", exists: null },
    { id: 3, name: R02, group: "A", exists: null },
  ];
  const m = buildMatching([{ route: R01, direction: "NB" }, { route: R02, direction: "SB" }], dup);
  assert.deepEqual(m.matchedObs.map((r) => r.route), [R02]);
  assert.deepEqual(m.ambiguousObs.map((r) => [r.route, r.reason, r.candidates.map((c) => c.subpath.id)]), [[R01, "ambiguous", [1, 2]]]);
  assert.equal(m.unmatchedObs.length, 1); // ambiguous rows are part of the unmatched list (counted once)
  assert.deepEqual(m.unmatchedSubpaths.map((u) => [u.subpath.id, u.reason]), [[1, "ambiguous-observed"], [2, "ambiguous-observed"]]);
  // a verified oid resolves the same ambiguity
  const resolved = buildMatching([{ route: R01, direction: "NB", subpath_oid: 2 }], dup);
  assert.equal(resolved.matchedObs[0].matches[0].subpath.id, 2);
});

test("overlay features carry subpath_oid, match_method and the supplied bounds; keys line up for oid and exact-name rows", () => {
  const geo = {
    type: "FeatureCollection" as const,
    features: SUBPATHS.map((s, i) => ({ type: "Feature" as const, id: s.id, geometry: { type: "LineString", coordinates: [[55 + i, 25], [55.1 + i, 25.1]] }, properties: { id: s.id, oid: s.id, name: s.name, group_label: s.group } })),
  };
  const refs = subpathRefs(geo);
  assert.equal(refs[0].oid, 294383);
  const pairs = [...new Map(obs.map((r) => [`${r.route}|${r.direction_norm}|${r.subpath_oid}`, { route: r.route, direction: r.direction_norm, source: r.source, subpath_oid: r.subpath_oid, source_id: r.source_id }])).values()];
  const match = buildMatching(pairs, refs);
  const values = valuesAtBucket(obs, 540, "mean", "seconds");
  const fc = overlayFeatures({ geo, match, values, source: SRC, bucket: 540, scale: colourScale([...values.values()].map((v) => v.value)) });
  assert.equal(fc.features.length, 6);
  const f05 = fc.features.find((f) => f.id === 294385)!;
  assert.equal(f05.properties!.subpath_oid, "294385");
  assert.equal(f05.properties!.match_method, "rds-oid");
  assert.equal(f05.properties!.source_id, "jt1");
  assert.equal(f05.properties!.jt_s, 400);
  assert.equal(f05.properties!.sup_min_s, 380);
  assert.equal(f05.properties!.sup_max_s, 430);
  const f01 = fc.features.find((f) => f.id === 294383)!;
  assert.equal(f01.properties!.jt_s, 780); // exact-name row (no oid, no direction suffix in the key path) still gets its value
  assert.equal(f01.properties!.match_method, "exact-name");
  assert.equal(f01.properties!.sup_max_s, 840);
  const f04 = fc.features.find((f) => f.id === 294380)!; // R04 is matched but has no 09:00 observation: drawn grey, null value
  assert.equal(f04.properties!.jt_s, null);
  assert.equal(f04.properties!.stroke, "#9ca3af");
});

test("typical-day rows compare with a simulated run only when a window is declared in the data", () => {
  assert.deepEqual(comparisonMode(obs).mode, "profile-only");
  assert.match(comparisonMode(obs).reason ?? "", /window/);
  assert.equal(declaredWindow(obs), null);
  const windowed: ObsRow[] = obs.map((r) => ({ ...r, window_start_s: 32400, window_end_s: 39600 }));
  assert.deepEqual(declaredWindow(windowed), { from: 540, to: 660 });
  assert.equal(comparisonMode(windowed).mode, "compare");
  assert.deepEqual(profileOf(windowed, R01, "NB", SRC).window, { from: 540, to: 660 });
  // rows with real dates (legacy) keep comparing as before
  assert.equal(comparisonMode(obs.map((r) => ({ ...r, date_kind: "actual" }))).mode, "compare");
});

test("the declared window travels through the SQL views (window_start_s/window_end_s)", async () => {
  const c = await memConn();
  await runScript(c, `CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR, window_start_s DOUBLE, window_end_s DOUBLE, dateKind VARCHAR);
    INSERT INTO subpath_obs_jt VALUES ('R','NB',TIMESTAMP '1970-01-01 09:00:00',100,'s',32400,39600,'typical');`);
  await runScript(c, buildSubpathSql({ columns: ["route", "direction_norm", "ts", "seconds", "source", "window_start_s", "window_end_s", "dateKind"] }));
  const r = toObsRows(await rows(c, "SELECT * FROM v_sp_obs"))[0];
  assert.deepEqual([r.window_start_s, r.window_end_s, r.sup_min_s, r.sup_max_s, r.date_kind], [32400, 39600, null, null, "typical"]);
});

test("legacy rows (route, direction_norm, ts, seconds, source) behave exactly as before, with or without the column list", async () => {
  const c = await memConn();
  await runScript(c, `CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR);
    INSERT INTO subpath_obs_jt VALUES ('R','IB',TIMESTAMP '2025-02-03 07:00:00',60,'monthly_15min'),('R','IB',TIMESTAMP '2025-02-04 07:00:00',80,'monthly_15min');`);
  await runScript(c, buildSubpathSql());
  const plain = await rows(c, "SELECT * FROM v_sp_obs");
  assert.deepEqual(Object.keys(plain[0]), ["route", "direction_norm", "source", "bucket_start_min", "n_days", "mean_s", "median_s", "min_s", "max_s"]);
  await runScript(c, buildSubpathSql({ columns: LEGACY_COLUMNS }));
  const ext = toObsRows(await rows(c, "SELECT * FROM v_sp_obs"))[0];
  assert.deepEqual([ext.mean_s, ext.min_s, ext.max_s, ext.n_days, ext.sup_min_s, ext.sup_max_s, ext.subpath_oid, ext.date_kind], [70, 60, 80, 2, null, null, null, null]);
  const p = profileOf([ext], "R", "IB", "monthly_15min");
  assert.equal(p.hasSupplied, false);
  assert.equal(p.dateKind, "actual");
  assert.equal(comparisonMode([ext]).mode, "compare");
  const m = buildMatching([{ route: "R", direction: "IB" }], [{ id: 1, name: "R_In", group: null, exists: null }]);
  assert.equal(m.matchedObs[0].matches[0].method, "name-direction");
  assert.equal(m.matchedObs[0].valueKey, "r|IB");
});

test("manifest capability reason for the absent simulated side", () => {
  const m = (x: Record<string, unknown>) => ({ schema_version: 1 as const, files: [], ...x });
  assert.equal(manifestSimReason(undefined), null);
  assert.equal(manifestSimReason(m({ capabilities: { "analysis-journey-time": { available: false, reason: "no simulated subpath table for static runs" } } })), "no simulated subpath table for static runs");
  assert.equal(manifestSimReason(m({ capabilities: { "analysis-journey-time": { available: true } } })), null);
  assert.equal(manifestSimReason(m({ capabilities: { "analysis-journey-time": false }, reason: "no MISUBPATH rows" })), "no MISUBPATH rows");
});
