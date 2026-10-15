import test, { before } from "node:test";
import assert from "node:assert/strict";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql.ts";
import { buildMatching } from "../src/match.ts";
import { subpathRefs } from "../src/pkg.ts";
import {
  bucketLabel,
  colourScale,
  legendUsable,
  featuresBounds,
  median,
  NO_DATA_COLOUR,
  overlayFeatures,
  profileOf,
  rampColour,
  toObsRows,
  valuesAtBucket,
  type ObsRow,
} from "../src/profile.ts";
import { memConn, rows, runScript, type DuckDBConnection } from "./helpers.ts";

let conn: DuckDBConnection;
let obs: ObsRow[];

before(async () => {
  conn = await memConn();
  await runScript(
    conn,
    `
    CREATE TABLE subpath_obs_jt(route VARCHAR, direction_norm VARCHAR, ts TIMESTAMP, seconds DOUBLE, source VARCHAR);
    -- Route R IB, monthly: day values at 07:00 = 60 (two raw rows 50 and 70 in the bucket), 70, 80 ; at 07:15 = 100, 100, 130
    INSERT INTO subpath_obs_jt VALUES
      ('R','IB',TIMESTAMP '2025-02-03 07:00:00',50,'monthly_15min'), ('R','IB',TIMESTAMP '2025-02-03 07:05:00',70,'monthly_15min'),
      ('R','IB',TIMESTAMP '2025-02-04 07:00:00',70,'monthly_15min'), ('R','IB',TIMESTAMP '2025-02-05 07:00:00',80,'monthly_15min'),
      ('R','IB',TIMESTAMP '2025-02-03 07:15:00',100,'monthly_15min'), ('R','IB',TIMESTAMP '2025-02-04 07:15:00',100,'monthly_15min'),
      ('R','IB',TIMESTAMP '2025-02-05 07:15:00',130,'monthly_15min'),
      -- zero/negative values are not observations
      ('R','IB',TIMESTAMP '2025-02-06 07:00:00',0,'monthly_15min'),
      -- a different source for the same route/direction must stay separate
      ('R','IB',TIMESTAMP '2025-05-05 07:15:00',500,'subnetwork_may2025'),
      ('S','OB',TIMESTAMP '2025-05-05 07:00:00',200,'subnetwork_may2025');
  `,
  );
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15 }));
  obs = toObsRows(await rows(conn, "SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
});

test("v_sp_obs -> ObsRow: statistics across days, sources kept apart", () => {
  assert.equal(obs.length, 4);
  const r0700 = obs.find((r) => r.source === "monthly_15min" && r.bucket_start_min === 420)!;
  assert.deepEqual([r0700.n_days, r0700.mean_s, r0700.median_s, r0700.min_s, r0700.max_s], [3, 70, 70, 60, 80]);
  const r0715 = obs.find((r) => r.source === "monthly_15min" && r.bucket_start_min === 435)!;
  assert.deepEqual([r0715.n_days, r0715.median_s, r0715.min_s, r0715.max_s], [3, 100, 100, 130]);
  assert.ok(Math.abs((r0715.mean_s as number) - 110) < 1e-9);
  assert.equal(obs.filter((r) => r.source === "subnetwork_may2025" && r.route === "R")[0].mean_s, 500);
});

test("profileOf: sorted by bucket, one source only", () => {
  const p = profileOf(obs, "R", "IB", "monthly_15min");
  assert.deepEqual(p.mean.map((x) => x.x), [420, 435]);
  assert.deepEqual(p.band.map((b) => [b.lo, b.hi]), [[60, 80], [100, 130]]);
  assert.equal(p.nDaysMax, 3);
  assert.deepEqual(profileOf(obs, "R", "OB", "monthly_15min").mean, []);
});

test("median / bucketLabel", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(bucketLabel(495), "08:15");
});

test("valuesAtBucket: seconds and ratio-to-day-median modes", () => {
  const monthly = obs.filter((r) => r.source === "monthly_15min");
  const s = valuesAtBucket(monthly, 420, "mean", "seconds").get("r|IB")!;
  assert.equal(s.seconds, 70);
  assert.equal(s.value, 70);
  // day median of the route's own mean profile: median(70, 110) = 90
  const ratio = valuesAtBucket(monthly, 420, "mean", "ratio").get("r|IB")!;
  assert.ok(Math.abs((ratio.value as number) - 70 / 90) < 1e-12);
  assert.equal(valuesAtBucket(monthly, 420, "median", "seconds").get("r|IB")!.value, 70);
  assert.equal(valuesAtBucket(monthly, 0, "mean", "seconds").size, 0); // nothing observed at midnight
});

test("colour ramp: endpoints, clamping, no-data grey, degenerate range", () => {
  assert.equal(rampColour(0), "#ffffb2");
  assert.equal(rampColour(1), "#bd0026");
  assert.equal(rampColour(-5), "#ffffb2");
  assert.equal(rampColour(7), "#bd0026");
  assert.match(rampColour(0.5), /^#[0-9a-f]{6}$/);
  const sc = colourScale([10, 20, null]);
  assert.deepEqual([sc.min, sc.max], [10, 20]);
  assert.equal(sc.colour(10), "#ffffb2");
  assert.equal(sc.colour(20), "#bd0026");
  assert.equal(sc.colour(null), NO_DATA_COLOUR);
  assert.match(colourScale([5, 5]).colour(5), /^#[0-9a-f]{6}$/);
});

test("overlayFeatures: matched subpaths coloured for the bucket; grey where the bucket has no data", () => {
  const geo = {
    type: "FeatureCollection" as const,
    features: [
      { type: "Feature" as const, id: 1, geometry: { type: "LineString", coordinates: [[54.3, 24.4], [54.4, 24.5]] }, properties: { id: 1, name: "R_In", group_label: "G1", exists_in_run_scenario: true } },
      { type: "Feature" as const, id: 2, geometry: { type: "LineString", coordinates: [[54.5, 24.6], [54.6, 24.7]] }, properties: { id: 2, name: "R_IB", group_label: "G2" } },
      { type: "Feature" as const, id: 3, geometry: { type: "LineString", coordinates: [[1, 1], [2, 2]] }, properties: { id: 3, name: "X_Out", group_label: "G1" } },
    ],
  };
  const monthly = obs.filter((r) => r.source === "monthly_15min");
  const match = buildMatching([{ route: "R", direction: "IB" }, { route: "Q", direction: "OB" }], subpathRefs(geo));
  const values = valuesAtBucket(monthly, 420, "mean", "seconds");
  const scale = colourScale([...values.values()].map((v) => v.value));
  const fc = overlayFeatures({ geo, match, values, source: "monthly_15min", bucket: 420, scale });
  assert.equal(fc.features.length, 2); // both R subpaths (two groups), not X_Out
  assert.deepEqual(fc.features.map((f) => f.properties!.name), ["R_In", "R_IB"]);
  assert.equal(fc.features[0].properties!.jt_s, 70);
  assert.equal(fc.features[0].properties!.bucket, "07:00");
  assert.match(String(fc.features[0].properties!.stroke), /^#[0-9a-f]{6}$/);
  assert.equal(fc.features[0].properties!["stroke-width"], 4);
  // bucket with no observation -> grey, null value
  const none = overlayFeatures({ geo, match, values: valuesAtBucket(monthly, 600, "mean", "seconds"), source: "monthly_15min", bucket: 600, scale });
  assert.equal(none.features[0].properties!.stroke, NO_DATA_COLOUR);
  assert.equal(none.features[0].properties!.jt_s, null);
  assert.deepEqual(featuresBounds(fc), [54.3, 24.4, 54.6, 24.7]);
  assert.equal(featuresBounds({ type: "FeatureCollection", features: [] }), null);
});

test("legendUsable: never a degenerate '0 s - 1 s' or single-value route legend", () => {
  assert.equal(legendUsable(colourScale([]), "seconds"), false);
  assert.equal(legendUsable(colourScale([42]), "seconds"), false);
  assert.equal(legendUsable(colourScale([42, 42]), "seconds"), false);
  assert.equal(legendUsable(colourScale([42, 42.5]), "seconds"), false);
  assert.equal(legendUsable(colourScale([42, 43]), "seconds"), true);
  assert.equal(legendUsable(colourScale([60, 300, null]), "seconds"), true);
  assert.equal(legendUsable(colourScale([1, 1]), "ratio"), false);
  assert.equal(legendUsable(colourScale([0.9, 1.3]), "ratio"), true);
});
