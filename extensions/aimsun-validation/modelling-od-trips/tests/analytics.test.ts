import assert from "node:assert/strict";
import test from "node:test";
import { balanceRows, conservationChecks, cumulativeBins, distributionStats, flowMatrix, jenksBreaks, joinComparisons, volumeOpacity } from "../src/analytics.ts";
import { classifyValue, type LegendConfig } from "../src/_od/map-logic.ts";

test("Jenks handles empty, tied, low-cardinality, and sampled values", () => {
  assert.deepEqual(jenksBreaks([], 5), []);
  assert.deepEqual(jenksBreaks([4, 4, 4], 5), []);
  assert.deepEqual(jenksBreaks([1, 1, 2, 2], 8), [2]);
  const cuts = jenksBreaks([1, 2, 3, 50, 51, 52], 3);
  assert.equal(cuts.length, 2);
  assert.ok(cuts[0] >= 3 && cuts[0] <= 50);
});

test("Jenks classification and volume opacity are bounded", () => {
  const legend: LegendConfig = { neutral: 0.1, decrease: 10, increase: 10, scheme: "RdBu", classification: "jenks", breaks: [], classes: 4 };
  assert.equal(classifyValue(80, legend, [1, 2, 3, 50, 80]), 3);
  assert.equal(volumeOpacity(5, 0, 10), 0.55);
  assert.equal(volumeOpacity(5, 5, 5), 0.2);
});

test("balance and conservation calculations retain trip totals and tolerance", () => {
  assert.deepEqual(balanceRows([{ id: "x", productions: 10, attractions: 4 }])[0], { id: "x", productions: 10, attractions: 4, net: 6, ratio: 2.5 });
  const checks = conservationChecks({ before: 100, after: 90, rowSum: 90, columnSum: 90, grand: 90, grouped: 89.8, newFlows: 0, droppedFlows: 0, unknownTrips: 0, invalidValues: 0 });
  assert.ok(checks.every(c => c.pass));
  const warning = conservationChecks({ before: 100, after: 90, rowSum: 91, columnSum: 90, grand: 90, grouped: 80, ungroupedTrips: 0, newFlows: 1, droppedFlows: 0, unknownTrips: 4, invalidValues: 1 });
  assert.ok(warning.some(c => !c.pass));
});

test("trip length stats compute median, p90, cumulative shares and empty values", () => {
  const bins = [{ start: 0, end: 2, trips: 5 }, { start: 2, end: 4, trips: 5 }];
  const s = distributionStats(bins);
  assert.equal(s.median, 2);
  assert.equal(s.p90, 3.6);
  assert.equal(s.under5Share, 1);
  assert.deepEqual(cumulativeBins(bins).map(b => b.trips), [.5, 1]);
  assert.equal(distributionStats([]).median, null);
});

test("flow matrix folds tail groups into Other and conserves before and after", () => {
  const m = flowMatrix([{ origin: "A", destination: "A", before: 5, after: 3 }, { origin: "B", destination: "C", before: 2, after: 7 }], 1);
  assert.deepEqual(m.groups, ["A", "Other"]);
  assert.equal(m.rows.reduce((s, r) => s + r.before, 0), 7);
  assert.equal(m.rows.reduce((s, r) => s + r.after, 0), 10);
  assert.equal(m.rows.find(r => r.origin === "Other")?.deltaPct, 2.5);
});

test("comparison join marks selected baseline", () => {
  assert.deepEqual(joinComparisons([{ run: "A", n: 2 }, { run: "B", n: 3 }], "A"), [{ run: "A", n: 2, baseline: true }, { run: "B", n: 3, baseline: false }]);
});
