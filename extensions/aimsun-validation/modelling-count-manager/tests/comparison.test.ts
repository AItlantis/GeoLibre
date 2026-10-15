import test from "node:test";
import assert from "node:assert/strict";
import { joinComparison } from "../src/common/comparison.ts";

test("comparison join classifies improved, unchanged, degraded and counts detectors present in only one run", () => {
  const result = joinComparison([{ id: "better", geh: 12 }, { id: "same", geh: 5 }, { id: "worse", geh: 2 }, { id: "A-only", geh: 7 }],
    [{ id: "better", geh: 3 }, { id: "same", geh: 5 }, { id: "worse", geh: 9 }, { id: "B-only", geh: 4 }]);
  assert.deepEqual([result.both, result.onlyA, result.onlyB, result.improved, result.unchanged, result.degraded], [3, 1, 1, 1, 1, 1]);
  assert.equal(result.rows.find((r) => r.id === "better")?.status, "improved");
  assert.equal(result.rows.find((r) => r.id === "worse")?.status, "degraded");
  assert.equal(result.rows.find((r) => r.id === "same")?.status, "unchanged");
  assert.equal(result.rows.find((r) => r.id === "A-only")?.status, "only-a");
  assert.equal(result.rows.find((r) => r.id === "B-only")?.status, "only-b");
});
