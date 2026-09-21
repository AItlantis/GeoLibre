import test from "node:test";
import assert from "node:assert/strict";
import { useScenarioReplicationSelector } from "./useScenarioReplicationSelector";

function args(overrides: Partial<Parameters<typeof useScenarioReplicationSelector>[0]> = {}) {
  return {
    scenarios: [],
    scenarioIndex: 0,
    replications: [],
    selectedDid: null,
    onScenarioChange: () => {},
    onReplicationChange: () => {},
    ...overrides,
  };
}

test("single-scenario package hides the scenario picker", () => {
  const result = useScenarioReplicationSelector(
    args({ scenarios: [{ index: 0, id: "a", label: "A" }] }),
  );
  assert.equal(result.showScenarioPicker, false);
});

test("multi-scenario package shows the scenario picker", () => {
  const result = useScenarioReplicationSelector(
    args({
      scenarios: [
        { index: 0, id: "a", label: "A" },
        { index: 1, id: "b", label: "B" },
      ],
    }),
  );
  assert.equal(result.showScenarioPicker, true);
});

test("no replications hides the replication picker", () => {
  const result = useScenarioReplicationSelector(args({ replications: [] }));
  assert.equal(result.showReplicationPicker, false);
  assert.equal(result.effectiveDid, undefined);
});

test("effectiveDid falls back to the first replication when none is selected", () => {
  const result = useScenarioReplicationSelector(
    args({ replications: [{ did: 7 }, { did: 8 }], selectedDid: null }),
  );
  assert.equal(result.showReplicationPicker, true);
  assert.equal(result.effectiveDid, 7);
});

test("effectiveDid honors an explicit selection over the fallback", () => {
  const result = useScenarioReplicationSelector(
    args({ replications: [{ did: 7 }, { did: 8 }], selectedDid: 8 }),
  );
  assert.equal(result.effectiveDid, 8);
});

test("is safely callable twice per panel with independent arguments (side A + side B)", () => {
  const sideA = useScenarioReplicationSelector(
    args({ replications: [{ did: 1 }], selectedDid: null }),
  );
  const sideB = useScenarioReplicationSelector(
    args({ replications: [{ did: 2 }], selectedDid: null }),
  );
  assert.equal(sideA.effectiveDid, 1);
  assert.equal(sideB.effectiveDid, 2);
});
