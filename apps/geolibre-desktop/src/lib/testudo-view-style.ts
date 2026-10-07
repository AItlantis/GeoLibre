import type { TestudoDemoMode, TestudoSelectablePluginId, TestudoStyle } from "@geolibre/embed";

export function pluginForTestudoMode(mode: TestudoDemoMode): TestudoSelectablePluginId {
  const plugins: Record<TestudoDemoMode, TestudoSelectablePluginId> = {
    animation: "vehicle-playback", results: "network-kpi", flow: "network-kpi", density: "network-kpi",
    comparison: "scenario-comparison", environment: "emissions-h3", paths: "path-analysis",
  };
  return plugins[mode];
}

/** Resolve shell scenario ids as well as historical zero-based indexes. */
export function resolveComparisonScenarioIndex(value: unknown, scenarios: readonly { id?: string | number; scid?: string | number }[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < scenarios.length) return value;
  const index = scenarios.findIndex((scenario) => String(scenario.id ?? scenario.scid) === String(value));
  if (index >= 0) return index;
  throw new Error(`Comparison scenario ${String(value)} is not available.`);
}

export function availableModesForScenario(baseModes: readonly TestudoDemoMode[], environmentAvailable: boolean): TestudoDemoMode[] {
  return baseModes.filter(mode => mode !== "environment" || environmentAvailable);
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
  style: TestudoStyle,
  scenarios: readonly { id?: string | number; scid?: string | number }[],
  showDifference: boolean,
): TestudoStyle {
  const toId = (value: string | number | undefined): string | number | undefined => {
    if (value === undefined) return undefined;
    const index = resolveComparisonScenarioIndex(value, scenarios);
    const scenario = scenarios[index!];
    return scenario.id ?? scenario.scid ?? value;
  };
  return {
    ...style,
    ...(style.scenarioA !== undefined ? { scenarioA: toId(style.scenarioA) } : {}),
    ...(style.scenarioB !== undefined ? { scenarioB: toId(style.scenarioB) } : {}),
    showDifference,
  };
}

export type ValidatedTestudoStyle = Omit<TestudoStyle, "scenarioA" | "scenarioB"> & { scenarioA?: number; scenarioB?: number };

export function validateTestudoStyle(candidate: unknown, mode: TestudoDemoMode | undefined, scenarioCount: number, scenarios?: readonly { id?: string | number; scid?: string | number }[]): ValidatedTestudoStyle {
  if (!candidate || typeof candidate !== "object") throw new Error("Style settings are invalid.");
  const style = candidate as Record<string, unknown>;
  const { display, metric, interval, maxHeightM, scenarioA, scenarioB, showDifference } = style;
  if ((display !== "ramp" && display !== "extrusion") || typeof metric !== "string" || !metric.trim() || metric.length > 64
    || !Number.isSafeInteger(interval) || Number(interval) < 0 || !Number.isFinite(maxHeightM) || Number(maxHeightM) <= 0 || Number(maxHeightM) > 10000) throw new Error("Style settings are invalid.");
  const aliases: Record<string, string> = { dtime: "delay", nstops: "noise" };
  const normalizedMetric = metric.endsWith("_delta")
    ? `${aliases[metric.slice(0, -6)] ?? metric.slice(0, -6)}_delta`
    : aliases[metric] ?? metric;
  const metrics = mode === "comparison" ? ["flow", "speed", "density", "delay", "flow_delta", "speed_delta", "density_delta", "delay_delta"]
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
