import test from "node:test";
import assert from "node:assert/strict";
import { bucketOptions, detViewScript, intArg, isObsSource, rawTableNames, windowQuery } from "../src/common/sql.ts";

test("windowQuery builds an integer-only half-open bucket filter", () => {
  assert.match(windowQuery(420, 480), /bucket_start_min >= 420 AND bucket_start_min < 480/);
});

test("windowQuery rejects anything that is not an integer (no SQL text reaches the query)", () => {
  assert.throws(() => windowQuery("0; DROP TABLE x" as unknown as number, 10), /integer/);
  assert.throws(() => windowQuery(1.5, 10), /integer/);
  assert.throws(() => windowQuery(0, Number.NaN), /integer/);
  assert.throws(() => intArg(null, "x"), /integer/);
});

test("rawTableNames validates the prefix", () => {
  assert.deepEqual(rawTableNames("dc_"), { sim: "dc_sim_raw", obs: "dc_obs_raw" });
  assert.throws(() => rawTableNames("x; drop"), /invalid table prefix/);
  assert.throws(() => rawTableNames("1abc"), /invalid table prefix/);
});

test("detViewScript wires the adapter + det views to private raw tables", () => {
  const s = detViewScript({ prefix: "dc_", obsSource: "validation", bucketMinutes: 60 });
  assert.match(s, /FROM dc_sim_raw/);
  assert.match(s, /FROM dc_obs_raw/);
  assert.match(s, /source_file = 'validation'/);
  assert.match(s, /CREATE OR REPLACE VIEW v_det_validation/);
  assert.match(s, /FROM v_sim_norm/);
  assert.doesNotMatch(s, /od_before|v_od_diff/); // only the det group
  assert.doesNotMatch(detViewScript({ prefix: "dc_", obsSource: "both", bucketMinutes: 60 }), /source_file = '/);
});

test("detViewScript rejects bad config", () => {
  assert.throws(() => detViewScript({ prefix: "dc_", obsSource: "x" as never, bucketMinutes: 60 }), /obsSource/);
  assert.throws(() => detViewScript({ prefix: "dc_", obsSource: "both", bucketMinutes: 0 }), /bucketMinutes/);
  assert.throws(() => detViewScript({ prefix: "dc_", obsSource: "both", bucketMinutes: 7.5 }), /integer/);
  assert.equal(isObsSource("calibration"), true);
  assert.equal(isObsSource("nope"), false);
});

test("bucketOptions: only whole multiples of the simulated interval that fit and align", () => {
  assert.deepEqual(bucketOptions(60, 420, 480), [60]);
  assert.deepEqual(bucketOptions(60, 360, 600), [60, 120, 180]); // span 240; 360 is a multiple of 120 and 180, not of 240
});
test("bucketOptions general", () => {
  assert.deepEqual(bucketOptions(60, 0, 240), [60, 120, 180, 240]);
  assert.deepEqual(bucketOptions(60, 420, 660), [60]); // 420 % 120 != 0, % 180 != 0, % 240 != 0
  assert.deepEqual(bucketOptions(0, 0, 0), [60]);
});
