import test from "node:test";
import assert from "node:assert/strict";
import { aggregateDetectors, computeKpis, gehBins, sortAggs, worstN, type ValRow } from "../src/common/aggregate.ts";

const row = (id: string, b: number, sim: number, obs: number, oid: number | null = 1): ValRow => ({
  detector_id: id,
  oid,
  bucket_start_min: b,
  sim_flow_h: sim,
  obs_flow_h: obs,
  geh: 0,
  status: "pass",
});

test("aggregateDetectors averages buckets per detector and recomputes GEH", () => {
  const a = aggregateDetectors([row("A", 0, 1000, 1000), row("A", 60, 1200, 1000), row("B", 0, 500, 1000, 7)]);
  assert.equal(a.length, 2);
  const A = a.find((x) => x.id === "A")!;
  assert.equal(A.buckets, 2);
  assert.equal(A.sim, 1100);
  assert.equal(A.obs, 1000);
  assert.equal(A.diff, 100);
  assert.ok(Math.abs(A.relErr! - 0.1) < 1e-12);
  assert.equal(A.status, "pass"); // GEH(1100,1000) = 3.09
  const B = a.find((x) => x.id === "B")!;
  assert.equal(B.oid, "7");
  assert.equal(B.status, "fail"); // GEH(500,1000) = 18.26
});

test("zero observed flow: relative error is null, GEH 0 when both zero", () => {
  const [a] = aggregateDetectors([row("Z", 0, 0, 0)]);
  assert.equal(a.relErr, null);
  assert.equal(a.geh, 0);
});

test("computeKpis on a hand-checked set", () => {
  // obs 100,200,300 ; sim 110,190,330 -> errors +10,-10,+30
  const k = computeKpis([row("a", 0, 110, 100), row("b", 0, 190, 200), row("c", 0, 330, 300)]);
  assert.equal(k.n, 3);
  assert.ok(Math.abs(k.bias! - 10) < 1e-9);
  assert.ok(Math.abs(k.mae! - 50 / 3) < 1e-9);
  assert.ok(Math.abs(k.rmse! - Math.sqrt(1100 / 3)) < 1e-9);
  assert.equal(k.pctGehLt5, 100);
  assert.equal(k.meetsTarget, true);
  assert.equal(k.nPass, 3);
  assert.ok(Math.abs(k.slope! - 1.1) < 1e-9);
  assert.ok(Math.abs(k.intercept! + 10) < 1e-9);
  assert.ok(Math.abs(k.r2! - (1 - 600 / 24800)) < 1e-9);
});

test("computeKpis flags a miss of the 85 % GEH target and handles empty input", () => {
  const rows = [row("a", 0, 100, 100), row("b", 0, 500, 1000), row("c", 0, 100, 400), row("d", 0, 1000, 1000)];
  const k = computeKpis(rows);
  assert.equal(k.pctGehLt5, 50);
  assert.equal(k.meetsTarget, false);
  assert.equal(k.nFail, 2);
  const e = computeKpis([]);
  assert.equal(e.n, 0);
  assert.equal(e.meetsTarget, null);
});

test("gehBins: width bins with an overflow bin", () => {
  const b = gehBins([0.2, 0.9, 1.5, 4.9, 9.99, 10, 55, Number.NaN], 1, 10);
  assert.equal(b.length, 11);
  assert.equal(b[0].value, 2);
  assert.equal(b[1].value, 1);
  assert.equal(b[4].value, 1);
  assert.equal(b[9].value, 1);
  assert.equal(b[10].value, 2); // 10 and 55
  assert.equal(b.reduce((s, x) => s + x.value, 0), 7);
});

test("worstN orders by GEH; sortAggs keeps nulls last in both directions", () => {
  // GEH: A 0, B 18.3, C 25.8 (obs 600, sim 100), D 24.5 (obs 0, sim 300)
  const a = aggregateDetectors([row("A", 0, 100, 100), row("B", 0, 500, 1000), row("C", 0, 100, 600), row("D", 0, 300, 0)]);
  assert.deepEqual(worstN(a, 2).map((x) => x.id), ["C", "D"]);
  assert.equal(worstN(a, 0).length, 0);
  const byRel = sortAggs(a, "relErr", "desc");
  assert.equal(byRel[byRel.length - 1].relErr, null);
  const byRelAsc = sortAggs(a, "relErr", "asc");
  assert.equal(byRelAsc[byRelAsc.length - 1].relErr, null);
  assert.deepEqual(sortAggs(a, "id", "asc").map((x) => x.id), ["A", "B", "C", "D"]);
});
