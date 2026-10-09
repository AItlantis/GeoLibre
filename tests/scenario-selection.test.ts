import assert from "node:assert/strict";
import test from "node:test";
import { assertScenarioSelectionSucceeded } from "../packages/plugins/src/shared/scenario-selection";

test("scenario selection rejects status errors even when the loader settled", () => {
  assert.throws(() => assertScenarioSelectionSucceeded({ loading: false, error: "Parquet read failed" }, "Network KPI"), /Parquet read failed/);
});
test("scenario selection rejects a loader that has not settled", () => {
  assert.throws(() => assertScenarioSelectionSucceeded({ loading: true, error: null }, "Emissions"), /still loading/);
});
test("scenario selection accepts a settled successful load", () => {
  assert.doesNotThrow(() => assertScenarioSelectionSucceeded({ loading: false, error: null }, "Comparison"));
});
