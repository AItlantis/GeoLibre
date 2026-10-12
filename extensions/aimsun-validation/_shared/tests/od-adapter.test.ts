// OD adapter + query builders: hand-computed synthetic data, then the REAL AMPK_3 parquet (skipped when absent).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildViewsSql } from "../src/sql/views.sql.ts";
import {
  ALL_GROUP, NO_GROUP, buildOdAdapterSql, buildOdCellSql, centroidNetSql, centroidsFromGeoJsonSql, deviationBandsSql, groupMatrixSql,
  groupSizesSql, intLit, listGroupingsSql, lit, parquetViewSql, pickDefaultGrouping, scatterPointsSql, scatterStatsSql, selectionPredicate,
  selectionStatsSql, topDiffSql, topPairsSql, totalsSql, tripLengthSql, type GroupingInfo,
} from "../src/sql/od-adapter.sql.ts";

const stmts = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const mk = async (): Promise<DuckDBConnection> => (await (await DuckDBInstance.create(":memory:")).connect());
const run = async (c: DuckDBConnection, sql: string) => { for (const s of stmts(sql)) await c.run(s); };
const rows = async (c: DuckDBConnection, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, any>>;
const n = (v: unknown) => Number(v);
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---- synthetic: centroids 1,2,3 (3 has no group), 4 only in grouping "G2".
// before: 1>2 100, 1>3 50, 2>1 10, 1>1 5 (intrazonal), 2>3 0.5
// after : 1>2 150, 2>1 0 (dropped), 3>1 20 (new flow), 1>1 5, 2>3 0.5
let c: DuckDBConnection;
before(async () => {
  c = await mk();
  await run(c, `
    CREATE TABLE od_before_raw(origin_id BIGINT, origin_name VARCHAR, destination_id BIGINT, destination_name VARCHAR, value DOUBLE);
    INSERT INTO od_before_raw VALUES (1,'a',2,'b',100),(1,'a',3,'c',50),(2,'b',1,'a',10),(1,'a',1,'a',5),(2,'b',3,'c',0.5);
    CREATE TABLE od_after_raw AS SELECT * FROM od_before_raw WHERE false;
    INSERT INTO od_after_raw VALUES (1,'a',2,'b',150),(3,'c',1,'a',20),(1,'a',1,'a',5),(2,'b',3,'c',0.5);
    CREATE TABLE centroids_geo(id BIGINT, name VARCHAR, external_id VARCHAR, lon DOUBLE, lat DOUBLE);
    INSERT INTO centroids_geo VALUES (1,'a','1',54.0,24.0),(2,'b','2',54.1,24.0),(3,'c','3',54.0,24.1),(4,'d','4',55.0,25.0);
    CREATE TABLE groupings_raw(grouping_id BIGINT, grouping_name VARCHAR, filter_type VARCHAR, group_id BIGINT, group_name VARCHAR,
      group_external_id VARCHAR, membership_policy VARCHAR, member_id BIGINT, member_external_id VARCHAR, member_name VARCHAR);
    INSERT INTO groupings_raw VALUES
     (10,'G1','GKCentroid',100,'North',NULL,'disjoint',1,'1','a'),(10,'G1','GKCentroid',101,'South',NULL,'disjoint',2,'2','b'),
     (11,'G2','GKCentroid',110,'One',NULL,'disjoint',1,'1','a'),(11,'G2','GKCentroid',110,'One',NULL,'disjoint',2,'2','b'),(11,'G2','GKCentroid',111,'Two',NULL,'disjoint',4,'4','d'),
     (12,'Regions','GKCentroid',NULL,NULL,NULL,'ungrouped',NULL,NULL,NULL),
     (13,'Det','GKDetectorStation',130,'X',NULL,'disjoint',1,'1','a');
  `);
  await run(c, buildOdAdapterSql({ grouping: "G1" }));
  await run(c, buildOdCellSql());
});

test("adapter: centroids_norm uses the selected grouping, unknown members are (none)", async () => {
  const r = await rows(c, "SELECT id, grp FROM v_centroids_norm ORDER BY id");
  assert.deepEqual(r.map((x) => [n(x.id), x.grp]), [[1, "North"], [2, "South"], [3, NO_GROUP], [4, NO_GROUP]]);
  await run(c, buildOdAdapterSql({ grouping: null }));
  assert.deepEqual((await rows(c, "SELECT DISTINCT grp FROM v_centroids_norm")).map((x) => x.grp), [ALL_GROUP]);
  await run(c, buildOdAdapterSql({ grouping: "G1" }));
});

test("groupings: listing ignores non-centroid families and empty groupings; default picks fewest sensible", async () => {
  const l = await rows(c, listGroupingsSql());
  assert.deepEqual(l.map((x) => [x.name, n(x.n_groups), n(x.n_members), n(x.max_group)]), [["G1", 2, 2, 1], ["G2", 2, 3, 2]]);
  assert.deepEqual((await rows(c, groupSizesSql("G2"))).map((x) => [x.name, n(x.n)]), [["One", 2], ["Two", 1]]);
  const g = (name: string, nGroups: number, nMembers: number, maxGroup: number): GroupingInfo => ({ name, nGroups, nMembers, maxGroup });
  assert.equal(pickDefaultGrouping([g("a", 5, 100, 99), g("b", 7, 100, 36), g("c", 21, 100, 20)]), "b"); // 5 groups but 99% in one
  assert.equal(pickDefaultGrouping([g("a", 5, 100, 50), g("b", 7, 100, 36)]), "a");
  assert.equal(pickDefaultGrouping([g("a", 5, 100, 99), g("b", 3, 100, 95)]), "b"); // none sensible: most balanced
  assert.equal(pickDefaultGrouping([g("only", 1, 10, 10)]), "only");
  assert.equal(pickDefaultGrouping([]), null);
});

test("existing shared views work on the adapter (contract names) and agree with the integer-keyed queries", async () => {
  await run(c, buildViewsSql({ only: ["od", "trip"] }));
  const d = await rows(c, "SELECT origin, destination, before, after, delta, deviation_ratio, is_new_flow FROM v_od_diff ORDER BY origin, destination");
  const cells = await rows(c, "SELECT o, d, before, after FROM od_cell ORDER BY o, d");
  assert.equal(d.length, cells.length);
  assert.equal(d.length, 6);
  const m = (r: any[], o: number, dd: number) => r.find((x) => n(x.origin ?? x.o) === o && n(x.destination ?? x.d) === dd)!;
  assert.equal(n(m(cells, 3, 1).before), 0);
  assert.equal(m(d, 3, 1).is_new_flow, true);
  assert.equal(m(d, 3, 1).deviation_ratio, null); // zero denominator, after > 0
  near(n(m(d, 2, 1).deviation_ratio), -1);
  near(n(m(d, 1, 1).deviation_ratio), 0);
  // group matrix equals v_od_group_agg
  const gm = await rows(c, groupMatrixSql());
  const va = await rows(c, "SELECT origin_group AS og, destination_group AS dg, before, after, delta FROM v_od_group_agg ORDER BY 1, 2");
  assert.equal(gm.length, va.length);
  for (const r of va) {
    const x = gm.find((y) => y.og === r.og && y.dg === r.dg)!;
    near(n(x.before), n(r.before)); near(n(x.after), n(r.after)); near(n(x.delta), n(r.delta));
  }
  near(gm.reduce((s, x) => s + n(x.before), 0), 165.5);
  near(gm.reduce((s, x) => s + n(x.after), 0), 175.5);
});

test("totals, top gains/losses, bands, new flows", async () => {
  const t = (await rows(c, totalsSql()))[0];
  near(n(t.before), 165.5); near(n(t.after), 175.5); near(n(t.pct), 10 / 165.5);
  assert.equal(n(t.n_cells), 6); assert.equal(n(t.n_new_flow), 1); assert.equal(n(t.n_dropped), 2);
  const gain = await rows(c, topDiffSql({ dir: "gain", limit: 2 }));
  assert.deepEqual(gain.map((x) => [x.origin, x.destination, n(x.delta)]), [["1", "2", 50], ["3", "1", 20]]);
  assert.equal(gain[1].is_new_flow, true);
  assert.equal(gain[1].deviation_ratio, null);
  const loss = await rows(c, topDiffSql({ dir: "loss", limit: 5 }));
  assert.deepEqual(loss.map((x) => [x.origin, x.destination, n(x.delta)]), [["1", "3", -50], ["2", "1", -10]]);
  // intrazonal excluded by default: 1>1 absent from both even with minTrips 0
  assert.equal((await rows(c, topDiffSql({ dir: "gain", limit: 50, excludeIntrazonal: false }))).length, 2);
  // bands over |ratio| with before > 0: 1>2 0.5 -> band 4; 1>3 1.0 -> 4; 2>1 1.0 -> 4; 1>1 0 -> 0; 2>3 0 -> 0 ; new flow row band -1
  const b = await rows(c, deviationBandsSql({ excludeIntrazonal: false }));
  const by = Object.fromEntries(b.map((x) => [n(x.band), x]));
  assert.equal(n(by[0].cells), 2); assert.equal(n(by[4].cells), 3); assert.equal(n(by[-1].cells), 1); near(n(by[-1].after), 20);
  const b2 = await rows(c, deviationBandsSql({}));
  assert.equal(n(Object.fromEntries(b2.map((x) => [n(x.band), x]))[0].cells), 1); // intrazonal dropped
});

test("selection predicates (all / group / centroid) and injection safety", async () => {
  const tp = await rows(c, topPairsSql({ side: "before", origin: { kind: "group", value: "North" } }));
  assert.deepEqual(tp.map((x) => [x.origin, x.destination, n(x.trips)]), [["1", "2", 100], ["1", "3", 50]]); // 1>1 excluded
  assert.ok(Math.abs(n(tp[0].dist_km) - 10.16) < 0.1); // 0.1 deg lon at 24N
  const dst = await rows(c, topPairsSql({ side: "after", destination: { kind: "centroid", value: "1" }, minTrips: 10 }));
  assert.deepEqual(dst.map((x) => [x.origin, n(x.trips)]), [["3", 20]]);
  assert.throws(() => intLit("1; DROP TABLE x"));
  assert.throws(() => selectionPredicate({ kind: "centroid", value: "1 OR 1=1" }, "origin"));
  assert.equal(lit("a'b"), "'a''b'");
  const evil = await rows(c, topPairsSql({ side: "before", origin: { kind: "group", value: "x' OR '1'='1" } }));
  assert.equal(evil.length, 0);
  const st = (await rows(c, selectionStatsSql({ side: "before", excludeIntrazonal: false })))[0];
  near(n(st.trips), 165.5); assert.equal(n(st.n_cells), 5);
});

test("trip length histogram equals v_trip_length for the full selection", async () => {
  const mine = await rows(c, tripLengthSql({ side: "after", binKm: 5 }));
  await run(c, buildViewsSql({ only: ["od", "trip"], binKm: 5 }));
  const ref = await rows(c, "SELECT bin_idx, trips, share FROM v_trip_length WHERE scenario = 'after' ORDER BY 1");
  assert.equal(mine.length, ref.length);
  mine.forEach((x, i) => { assert.equal(n(x.bin_idx), n(ref[i].bin_idx)); near(n(x.trips), n(ref[i].trips)); near(n(x.share), n(ref[i].share)); });
});

test("scatter levels, OLS stats, centroid net production", async () => {
  const s = (await rows(c, scatterStatsSql("cell")))[0];
  assert.equal(n(s.n), 6);
  const pts = await rows(c, scatterPointsSql("cell", 3));
  assert.equal(pts.length, 3);
  assert.equal(pts[0].label, "1 > 2");
  const g = (await rows(c, scatterStatsSql("group")))[0];
  assert.ok(n(g.n) >= 2);
  near(n(g.before), 165.5);
  const net = await rows(c, centroidNetSql());
  const c1 = net.find((x) => x.id === "1")!;
  near(n(c1.prod_before), 155); near(n(c1.prod_after), 155); near(n(c1.prod_delta), 0);
  near(n(c1.attr_before), 15); near(n(c1.attr_after), 25); near(n(c1.attr_delta), 10);
  assert.equal(net.find((x) => x.id === "4"), undefined);
});

// ---- real data ------------------------------------------------------------------------------
const ROOT = process.env.AIMSUN_DATA_DIR; // no default: unset -> the real-data test skips
const RUN = "AMPK_3";
const have = !!ROOT && ["od_before.parquet", "od_after.parquet", "groupings.parquet", "centroids.geojson"].every((f) => existsSync(join(ROOT, RUN, f)));
const P = (f: string) => join(ROOT ?? "", RUN, f).replace(/\\/g, "/");

test(`real ${RUN}: totals, groupings, adapter views and aggregations`, { skip: !have && `AIMSUN_DATA_DIR unset or no data in it`, timeout: 300_000 }, async () => {
  const r = await mk();
  await run(r, parquetViewSql("od_before_raw", P("od_before.parquet")) + parquetViewSql("od_after_raw", P("od_after.parquet")) + parquetViewSql("groupings_raw", P("groupings.parquet")));
  await run(r, centroidsFromGeoJsonSql(P("centroids.geojson")));
  const cen = (await rows(r, "SELECT count(*) n, count(lon) nl FROM centroids_geo"))[0];
  assert.equal(n(cen.n), 4528); assert.equal(n(cen.nl), 4528);
  // groupings: centroid families only
  const gs = await rows(r, listGroupingsSql());
  const info = gs.map((x): GroupingInfo => ({ name: x.name, nGroups: n(x.n_groups), nMembers: n(x.n_members), maxGroup: n(x.max_group) }));
  assert.deepEqual(info.map((x) => x.name).sort(), ["Centroids (Abu Dhabi Island)", "Centroids (GCC)"]);
  assert.equal(pickDefaultGrouping(info), "Centroids (Abu Dhabi Island)");
  assert.equal((await rows(r, groupSizesSql("Centroids (Abu Dhabi Island)"))).length, 7);
  await run(r, buildOdAdapterSql({ grouping: "Centroids (Abu Dhabi Island)" }));
  // every OD id has a centroid with coordinates
  const orphan = (await rows(r, `SELECT count(*) n FROM (SELECT origin id FROM v_od_before_norm UNION SELECT destination FROM v_od_after_norm) x LEFT JOIN v_centroids_norm c ON c.id = x.id WHERE c.lon IS NULL`))[0];
  assert.equal(n(orphan.n), 0);
  const t0 = Date.now();
  await run(r, buildOdCellSql());
  const tCell = Date.now() - t0;
  const t = (await rows(r, totalsSql()))[0];
  near(n(t.before), 411_942.63, 1); near(n(t.after), 334_560.38, 1);
  console.log(`# real ${RUN}: od_cell ${tCell} ms, cells ${t.n_cells}, new flows ${t.n_new_flow}, dropped ${t.n_dropped}`);
  // group matrix conserves totals
  const gm = await rows(r, groupMatrixSql());
  near(gm.reduce((s, x) => s + n(x.before), 0), n(t.before), 0.01);
  near(gm.reduce((s, x) => s + n(x.after), 0), n(t.after), 0.01);
  assert.ok(gm.length <= 64);
  // sample: the same group matrix straight from the shared view on a SLICE (origin in the first 200 ids) equals the od_cell result on that slice
  const sl = `origin <= (SELECT quantile_disc(origin, 0.05) FROM v_od_before_norm)`;
  await run(r, `CREATE TABLE sb AS SELECT * FROM v_od_before_norm WHERE ${sl}; CREATE TABLE sa AS SELECT * FROM v_od_after_norm WHERE origin IN (SELECT origin FROM sb)`);
  const sliceCells = (await rows(r, `SELECT SUM(before) b, SUM(after) a FROM od_cell WHERE o IN (SELECT origin FROM sb)`))[0];
  near(n(sliceCells.b), n((await rows(r, "SELECT SUM(trips) s FROM sb"))[0].s), 1e-6);
  near(n(sliceCells.a), n((await rows(r, "SELECT SUM(trips) s FROM sa"))[0].s), 1e-6);
  // top pairs / trip length / stats on streaming views
  const tp = await rows(r, topPairsSql({ side: "before", limit: 20 }));
  assert.equal(tp.length, 20); assert.ok(n(tp[0].trips) >= n(tp[19].trips)); assert.ok(tp.every((x) => x.o_lon !== null && x.dist_km !== null));
  const hist = await rows(r, tripLengthSql({ side: "after", binKm: 2 }));
  near(hist.reduce((s, x) => s + n(x.share), 0), 1, 1e-9);
  const st = (await rows(r, selectionStatsSql({ side: "after", excludeIntrazonal: false })))[0];
  near(n(st.trips), 334_560.38, 1);
  assert.ok(n(st.mean_km) > 1 && n(st.mean_km) < 200, `mean km ${st.mean_km}`);
  // deviation bands add up
  const bands = await rows(r, deviationBandsSql({ excludeIntrazonal: false }));
  assert.equal(bands.filter((x) => n(x.band) >= 0).reduce((s, x) => s + n(x.cells), 0), n(t.n_cells) - n(t.n_new_flow));
  assert.equal(n(bands.find((x) => n(x.band) === -1)!.cells), n(t.n_new_flow));
  // scatter + net production
  const ss = (await rows(r, scatterStatsSql("zone-group")))[0];
  assert.ok(n(ss.r2) > 0.5 && n(ss.r2) <= 1, `r2 ${ss.r2}`);
  const net = await rows(r, centroidNetSql());
  near(net.reduce((s, x) => s + n(x.prod_after), 0), n(t.after), 0.01);
  near(net.reduce((s, x) => s + n(x.attr_after), 0), n(t.after), 0.01);
});
