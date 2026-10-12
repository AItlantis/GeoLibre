import type { TestudoDemoMode, TestudoSelectablePluginId, TestudoStyle } from "@geolibre/embed";

export function pluginForTestudoMode(mode: TestudoDemoMode): TestudoSelectablePluginId {
  const plugins: Record<TestudoDemoMode, TestudoSelectablePluginId> = {
    animation: "vehicle-playback", results: "network-kpi", flow: "network-kpi", density: "network-kpi",
    comparison: "scenario-comparison", environment: "emissions-h3", paths: "path-analysis",
  };
  return plugins[mode];
}

const modeForTestudoPlugin: Partial<Record<TestudoSelectablePluginId, TestudoDemoMode>> = {
  "vehicle-playback": "animation",
  "network-kpi": "results",
  "path-analysis": "paths",
  "emissions-h3": "environment",
  "scenario-comparison": "comparison",
};

/** Plugin tabs that represent viewer modes must use the same path as mode selection. */
export function routeTestudoPluginSelection<T>(
  pluginId: string,
  selectMode: (mode: TestudoDemoMode) => Promise<T>,
  selectCapability: (pluginId: string) => Promise<T>,
): Promise<T> {
  const mode = modeForTestudoPlugin[pluginId as TestudoSelectablePluginId];
  return mode ? selectMode(mode) : selectCapability(pluginId);
}

/** Select the first declared animation scenario when its mode has no active scenario yet. */
export async function initializeFirstAnimationScenarioIfNeeded(
  scenarioIndex: number,
  scenarioCount: number,
  setScenario: (index: number) => Promise<void>,
): Promise<boolean> {
  if (scenarioIndex >= 0 || scenarioCount === 0) return false;
  await setScenario(0);
  return true;
}

/** Run the final mode synchronization steps and return state after roster synchronization. */
export async function finalizeModeSelection<T>(steps: {
  syncScenarioRoster: () => void;
  synchronizeViewMode: () => Promise<void>;
  publishPlayback: () => void;
  assertCurrent: () => void;
  getCurrentState: () => T;
}): Promise<T> {
  steps.syncScenarioRoster();
  steps.assertCurrent();
  await steps.synchronizeViewMode();
  steps.assertCurrent();
  steps.publishPlayback();
  steps.assertCurrent();
  return steps.getCurrentState();
}

/** Select a destination plugin scenario by stable SCID before publishing its roster. */
export async function selectScenarioInRoster<T extends { scid?: string | number }>(
  scenarioId: string | number,
  scenarios: readonly T[],
  selectIndex: (index: number) => Promise<void>,
  assertCurrent: () => void,
): Promise<{ index: number; scenario: T }> {
  assertCurrent();
  const index = scenarios.findIndex(scenario => String(scenario.scid) === String(scenarioId));
  if (index < 0) throw new Error(`Scenario ${String(scenarioId)} is not available in the destination plugin.`);
  await selectIndex(index);
  assertCurrent();
  return { index, scenario: scenarios[index] };
}

/** Resolve shell scenario ids as well as historical zero-based indexes. */
export function resolveComparisonScenarioIndex(value: unknown, scenarios: readonly { id?: string | number; scid?: string | number }[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < scenarios.length) return value;
  const index = scenarios.findIndex((scenario) => String(scenario.id ?? scenario.scid) === String(value));
  if (index >= 0) return index;
  throw new Error(`Comparison scenario ${String(value)} is not available.`);
}

/** Stable host IDs take precedence over legacy numeric-index interpretation. */
export function resolveComparisonScenarioPairIds(
  scenarioAId: string,
  scenarioBId: string,
  scenarios: readonly { id?: string | number; scid?: string | number }[],
): { scenarioA: number; scenarioB: number } {
  const resolve = (id: string): number => {
    const index = scenarios.findIndex(scenario => String(scenario.id ?? scenario.scid) === id);
    if (index < 0) throw new Error(`Comparison scenario ${id} is not available.`);
    return index;
  };
  return { scenarioA: resolve(scenarioAId), scenarioB: resolve(scenarioBId) };
}

export function availableModesForScenario(baseModes: readonly TestudoDemoMode[], environmentAvailable: boolean): TestudoDemoMode[] {
  return baseModes.filter(mode => mode !== "environment" || environmentAvailable);
}

export interface TestudoEnvironmentCapability {
  id: string;
  available: boolean;
  reason?: string;
}

/** Results needs both an advertised capability and a parsed Results view descriptor. */
export function reconcileResultsCapability<T extends TestudoEnvironmentCapability>(
  capabilities: readonly T[],
  resultsDescriptorDeclared: boolean,
): { capabilities: T[]; available: boolean } {
  const advertised = capabilities.find(capability => capability.id === "network-kpi");
  const available = Boolean(advertised?.available && resultsDescriptorDeclared);
  const capabilitiesNext = capabilities.map(capability => {
    if (capability.id !== "network-kpi") return capability;
    if (available) return { ...capability, available: true, reason: undefined } as T;
    const reason = !capability.available && capability.reason
      ? capability.reason
      : "This package lacks a compatible Results view descriptor.";
    return { ...capability, available: false, reason } as T;
  });
  return { capabilities: capabilitiesNext, available };
}

/** Reconcile Environment availability without overriding a package's explicit disablement. */
export function reconcileEnvironmentCapability<T extends TestudoEnvironmentCapability>(
  capabilities: readonly T[],
  environmentMetadataDeclared: boolean,
  hasUsableEmissionsRows: boolean,
): { capabilities: T[]; available: boolean } {
  const advertised = capabilities.find(capability => capability.id === "emissions-h3");
  const available = Boolean(advertised?.available && environmentMetadataDeclared && hasUsableEmissionsRows);
  const capabilitiesNext = capabilities.map(capability => {
    if (capability.id !== "emissions-h3") return capability;
    if (available) return { ...capability, available: true, reason: undefined } as T;
    const reason = !capability.available && capability.reason
      ? capability.reason
      : !environmentMetadataDeclared
        ? "Environment is unavailable because this package does not declare Environment metadata."
        : "Environment is unavailable because this package has no usable emissions rows.";
    return { ...capability, available: false, reason } as T;
  });
  return { capabilities: capabilitiesNext, available };
}

/** Keep Paths capability publication aligned with the package's declared path index. */
export function reconcilePathCapability<T extends TestudoEnvironmentCapability>(
  capabilities: readonly T[],
  hasDeclaredIndex: boolean,
): { capabilities: T[]; available: boolean } {
  const advertised = capabilities.find(capability => capability.id === "path-analysis");
  const available = Boolean(advertised?.available && hasDeclaredIndex);
  const capabilitiesNext = capabilities.map(capability => {
    if (capability.id !== "path-analysis") return capability;
    if (available) return { ...capability, available: true, reason: undefined } as T;
    const reason = !capability.available && capability.reason
      ? capability.reason
      : "Paths is unavailable because this package does not declare a path index.";
    return { ...capability, available: false, reason } as T;
  });
  return { capabilities: capabilitiesNext, available };
}

/** Compute effective mode while retaining the user's preferred mode through temporary scenario gaps. */
export function modeForScenarioChange(
  baseModes: readonly TestudoDemoMode[],
  environmentAvailable: boolean,
  preferredMode: TestudoDemoMode | undefined,
  selectedMode: TestudoDemoMode | undefined,
): { availableModes: TestudoDemoMode[]; selectedMode: TestudoDemoMode | undefined } {
  const availableModes = availableModesForScenario(baseModes, environmentAvailable);
  const selected = selectedMode && availableModes.includes(selectedMode)
    ? selectedMode
    : ["results", "flow", "animation", "paths", "comparison", "density"].find(mode => availableModes.includes(mode as TestudoDemoMode)) as TestudoDemoMode | undefined;
  return {
    availableModes,
    selectedMode: environmentAvailable && preferredMode === "environment" && selectedMode !== "environment"
      ? "environment" : selected,
  };
}

export function comparisonStyleState(
  style: Omit<TestudoStyle, "scenarioA" | "scenarioB"> & { scenarioA?: string | number; scenarioB?: string | number },
  scenarios: readonly { id?: string | number; scid?: string | number }[],
  showDifference: boolean,
): TestudoStyle {
  const toId = (value: string | number | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const index = resolveComparisonScenarioIndex(value, scenarios);
    const scenario = scenarios[index!];
    return String(scenario.id ?? scenario.scid ?? value);
  };
  const state: TestudoStyle = { display: style.display, metric: style.metric, interval: style.interval, maxHeightM: style.maxHeightM, showDifference };
  const scenarioA = toId(style.scenarioA), scenarioB = toId(style.scenarioB);
  if (scenarioA !== undefined) state.scenarioA = scenarioA;
  if (scenarioB !== undefined) state.scenarioB = scenarioB;
  return state;
}

/** Project plugin style data onto the shell's exact ViewerStyle contract. */
export function testudoViewerStyleState(
  style: Omit<TestudoStyle, "scenarioA" | "scenarioB"> & { scenarioA?: string | number; scenarioB?: string | number },
  scenarios: readonly { id?: string | number; scid?: string | number }[] = [],
): TestudoStyle {
  const state: TestudoStyle = {
    display: style.display,
    metric: style.metric,
    interval: style.interval,
    maxHeightM: style.maxHeightM,
  };
  const toId = (value: string | number | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < scenarios.length) {
      return String(scenarios[value].id ?? scenarios[value].scid ?? value);
    }
    return String(value);
  };
  const scenarioA = toId(style.scenarioA);
  const scenarioB = toId(style.scenarioB);
  if (scenarioA !== undefined) state.scenarioA = scenarioA;
  if (scenarioB !== undefined) state.scenarioB = scenarioB;
  if (style.showDifference !== undefined) state.showDifference = style.showDifference;
  return state;
}

export type ValidatedTestudoStyle = Omit<TestudoStyle, "scenarioA" | "scenarioB"> & { scenarioA?: number; scenarioB?: number };

export function validateTestudoStyle(candidate: unknown, mode: TestudoDemoMode | undefined, scenarioCount: number, scenarios?: readonly { id?: string | number; scid?: string | number }[]): ValidatedTestudoStyle {
  if (!candidate || typeof candidate !== "object") throw new Error("Style settings are invalid.");
  const style = candidate as Record<string, unknown>;
  const { display, metric, interval, maxHeightM, scenarioA, scenarioB, showDifference } = style;
  if ((display !== "ramp" && display !== "extrusion") || typeof metric !== "string" || !metric.trim() || metric.length > 64
    || !Number.isSafeInteger(interval) || Number(interval) < 0 || !Number.isFinite(maxHeightM) || Number(maxHeightM) <= 0 || Number(maxHeightM) > 10000) throw new Error("Style settings are invalid.");
  const aliases: Record<string, string> = { dtime: "delay", nstops: "noise", volume: "trips" };
  const normalizedMetric = metric.endsWith("_delta")
    ? `${aliases[metric.slice(0, -6)] ?? metric.slice(0, -6)}_delta`
    : aliases[metric] ?? metric;
  const metrics = mode === "paths" ? ["percentage", "trips"]
    : mode === "comparison" ? ["flow", "speed", "density", "delay", "flow_delta", "speed_delta", "density_delta", "delay_delta"]
    : mode === "environment" ? ["co2", "nox", "noise"] : ["flow", "speed", "density", "delay"];
  const comparisonBase = normalizedMetric.endsWith("_delta") ? normalizedMetric.slice(0, -6) : null;
  if (!metrics.includes(normalizedMetric) && !(mode === "comparison" && ["flow", "speed", "density", "delay"].includes(comparisonBase ?? ""))) {
    throw new Error(`Style metric "${metric}" is unavailable for the selected mode.`);
  }
  if (showDifference !== undefined && typeof showDifference !== "boolean") throw new Error("Style settings are invalid.");
  const resolve = (value: unknown) => value === undefined ? undefined : scenarios
    ? resolveComparisonScenarioIndex(value, scenarios)
    : Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < scenarioCount ? Number(value) : (() => { throw new Error("Style scenario indexes are invalid."); })();
  const resolvedA = resolve(scenarioA);
  const resolvedB = resolve(scenarioB);
  return { display, metric: normalizedMetric, interval: Number(interval), maxHeightM: Number(maxHeightM), ...(resolvedA !== undefined ? { scenarioA: resolvedA } : {}), ...(resolvedB !== undefined ? { scenarioB: resolvedB } : {}), ...(showDifference !== undefined ? { showDifference } : {}) };
}

export function environmentAvailableForScenario(pairs: readonly { scid: string | number; did: string | number }[] | undefined, scenarioId: string | number): boolean {
  return Boolean(pairs?.some(pair => String(pair.scid) === String(scenarioId) && Number.isFinite(Number(pair.did))));
}
