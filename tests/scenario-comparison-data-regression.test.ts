import assert from "node:assert/strict";
import test from "node:test";
import { buildScenarioComparisonRows } from "../packages/plugins/src/plugins/scenario-comparison-data";

test("aligned scenario KPIs use compared-minus-reference deltas and normalized section IDs", () => {
  const [row] = buildScenarioComparisonRows(
    [{ key: 4102, flow: 120, density: 30, speed: 42, delay: 8 }],
    [{ key: "4102", flow: 90, density: 24, speed: 36, delay: 11 }],
  );

  assert.equal(row.hasReference, true);
  assert.equal(row.hasCompared, true);
  assert.equal(row.flow_delta, -30);
  assert.equal(row.density_delta, -6);
  assert.equal(row.speed_delta, -6);
  assert.equal(row.delay_delta, 3);
  assert.equal(row.flow_pct_delta, -25);
  assert.equal(row.density_pct_delta, -20);
  assert.equal(row.cmp_flow_sign, "negative");
  assert.equal(row.cmp_flow_density_quadrant, "less_flow_less_density");
});

test("identical scenario rows produce zero deltas and zero-flow classification", () => {
  const [row] = buildScenarioComparisonRows(
    [{ key: 7, flow: 50, density: 12, speed: 38, delay: 4 }],
    [{ key: 7, flow: 50, density: 12, speed: 38, delay: 4 }],
  );

  assert.deepEqual(
    [row.flow_delta, row.density_delta, row.speed_delta, row.delay_delta,
      row.flow_pct_delta, row.density_pct_delta, row.cmp_flow_sign],
    [0, 0, 0, 0, 0, 0, "zero"],
  );
});

test("sections found on one side only retain unknown classifications and null deltas", () => {
  const rows = buildScenarioComparisonRows(
    [{ key: 8, flow: 10, density: 5, speed: 20, delay: 2 }],
    [{ key: 9, flow: 30, density: 7, speed: 25, delay: 1 }],
  );

  assert.deepEqual(rows.map((row) => ({
    key: row.key,
    hasReference: row.hasReference,
    hasCompared: row.hasCompared,
    deltas: [row.flow_delta, row.density_delta, row.speed_delta, row.delay_delta],
    flowSign: row.cmp_flow_sign,
    quadrant: row.cmp_flow_density_quadrant,
  })), [
    { key: 8, hasReference: true, hasCompared: false, deltas: [null, null, null, null], flowSign: "unknown", quadrant: "unknown" },
    { key: 9, hasReference: false, hasCompared: true, deltas: [null, null, null, null], flowSign: "unknown", quadrant: "unknown" },
  ]);
});

test("zero reference values retain raw deltas and omit non-finite percentage deltas", () => {
  const [row] = buildScenarioComparisonRows(
    [{ key: 1, flow: 0, density: 0 }],
    [{ key: 1, flow: 15, density: 2 }],
  );

  assert.equal(row.flow_delta, 15);
  assert.equal(row.density_delta, 2);
  assert.equal(row.flow_pct_delta, null);
  assert.equal(row.density_pct_delta, null);
});
