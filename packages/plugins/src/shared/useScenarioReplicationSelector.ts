export interface ScenarioLike {
  index: number;
  id: string;
  label: string;
}

export interface ReplicationLike {
  did: number;
  didname?: string;
  xname?: string;
}

export interface UseScenarioReplicationSelectorArgs {
  scenarios: readonly ScenarioLike[];
  scenarioIndex: number;
  replications: readonly ReplicationLike[];
  selectedDid: number | null;
  onScenarioChange: (index: number) => void;
  onReplicationChange: (did: number) => void;
}

export interface UseScenarioReplicationSelectorResult {
  /** Only a genuinely multi-scenario package gets a picker. */
  showScenarioPicker: boolean;
  /** Replication depends on which scenario is selected, so it only shows once one exists. */
  showReplicationPicker: boolean;
  /** The did that should be treated as selected — falls back to the first replication. */
  effectiveDid: number | undefined;
  scenarios: readonly ScenarioLike[];
  scenarioIndex: number;
  replications: readonly ReplicationLike[];
  onScenarioChange: (index: number) => void;
  onReplicationChange: (did: number) => void;
}

/**
 * Thin, stateless derivation shared by the scenario + replication pickers
 * repeated (in slightly different inline forms) across NetworkKpiPanel,
 * EmissionsH3Panel, VehiclePlaybackPanel and ScenarioComparisonPanel.
 *
 * Deliberately holds no `useState`/`useRef` of its own: it is a pure function
 * of its arguments, wrapped as a hook only for call-site symmetry with the
 * other panel hooks. That statelessness is also what makes it safe to call
 * TWICE in the same component — Scenario Comparison needs one instance per
 * side (A and B) — since there is no shared or hidden module/hook state that
 * two call sites could collide over.
 */
export function useScenarioReplicationSelector(
  args: UseScenarioReplicationSelectorArgs,
): UseScenarioReplicationSelectorResult {
  const { scenarios, scenarioIndex, replications, selectedDid, onScenarioChange, onReplicationChange } = args;
  return {
    showScenarioPicker: scenarios.length > 1,
    showReplicationPicker: replications.length > 0,
    effectiveDid: selectedDid ?? replications[0]?.did,
    scenarios,
    scenarioIndex,
    replications,
    onScenarioChange,
    onReplicationChange,
  };
}
