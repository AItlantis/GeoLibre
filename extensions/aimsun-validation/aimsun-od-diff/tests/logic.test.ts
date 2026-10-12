import test from "node:test";
import assert from "node:assert/strict";
import { toDiffRow } from "../src/view.ts";

test("toDiffRow maps SQL rows: is_new_flow from boolean/string, NULL ratio stays null, ids are strings", () => {
  const base = { origin: 5, destination: 6, before: "0", after: "20", delta: "20", deviation_ratio: null, o_lon: 54, o_lat: 24, d_lon: null, d_lat: null, dist_km: null };
  const a = toDiffRow({ ...base, is_new_flow: true });
  assert.equal(a.is_new_flow, true);
  assert.equal(a.deviation_ratio, null);
  assert.equal(a.origin, "5");
  assert.equal(a.delta, 20);
  assert.equal(a.d_lon, null);
  assert.equal(toDiffRow({ ...base, is_new_flow: "false", deviation_ratio: -0.25 }).is_new_flow, false);
  assert.equal(toDiffRow({ ...base, is_new_flow: "true" }).is_new_flow, true);
  assert.equal(toDiffRow({ ...base, is_new_flow: false, deviation_ratio: -0.25 }).deviation_ratio, -0.25);
});
