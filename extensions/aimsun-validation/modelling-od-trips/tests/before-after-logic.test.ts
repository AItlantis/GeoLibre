import test from "node:test";
import assert from "node:assert/strict";
import { orderGroups, sumBy, type MatrixRow } from "../src/views/before-after.ts";

const row = (og: string, dg: string, before: number, after: number): MatrixRow => ({ og, dg, before, after, delta: after - before, deviation_ratio: before ? (after - before) / before : null, n_cells: 1 });

test("orderGroups keeps the grouping order, appends unknown groups alphabetically, drops absent ones", () => {
  assert.deepEqual(orderGroups(["B", "A", "C"], ["(none)", "A", "B", "Z"]), ["B", "A", "(none)", "Z"]);
  assert.deepEqual(orderGroups([], []), []);
});

test("sumBy aggregates rows per origin or destination group and conserves the totals", () => {
  const rows = [row("N", "N", 10, 8), row("N", "S", 5, 7), row("S", "N", 2, 2), row("S", "S", 1, 0)];
  const o = sumBy(rows, "og");
  assert.deepEqual(o.get("N"), { before: 15, after: 15 });
  assert.deepEqual(o.get("S"), { before: 3, after: 2 });
  const d = sumBy(rows, "dg");
  assert.deepEqual(d.get("N"), { before: 12, after: 10 });
  const tot = (m: Map<string, { before: number; after: number }>) => [...m.values()].reduce((s, x) => s + x.before, 0);
  assert.equal(tot(o), 18);
  assert.equal(tot(d), 18);
});
