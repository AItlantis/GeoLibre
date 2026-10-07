import type { TestudoDemoMode, TestudoSelectablePluginId, TestudoStyle } from "@geolibre/embed";

export function pluginForTestudoMode(mode: TestudoDemoMode): TestudoSelectablePluginId {
  const plugins: Record<TestudoDemoMode, TestudoSelectablePluginId> = {
    animation: "vehicle-playback", results: "network-kpi", flow: "network-kpi", density: "network-kpi",
    comparison: "scenario-comparison", environment: "emissions-h3", paths: "path-analysis",
  };
  return plugins[mode];
}

export function validateTestudoStyle(candidate: unknown, mode: TestudoDemoMode | undefined, scenarioCount: number): TestudoStyle {
  if (!candidate || typeof candidate !== "object") throw new Error("Style settings are invalid.");
  const style = candidate as Record<string, unknown>;
  const { display, metric, interval, maxHeightM, scenarioA, scenarioB } = style;
  if ((display !== "ramp" && display !== "extrusion") || typeof metric !== "string" || !metric.trim() || metric.length > 64
    || !Number.isSafeInteger(interval) || Number(interval) < 0 || !Number.isFinite(maxHeightM) || Number(maxHeightM) <= 0 || Number(maxHeightM) > 10000) throw new Error("Style settings are invalid.");
  const validIndex = (value: unknown) => value === undefined || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < scenarioCount;
  if (!validIndex(scenarioA) || !validIndex(scenarioB)) throw new Error("Style scenario indexes are invalid.");
  const metrics = mode === "comparison" ? ["flow", "speed", "density", "delay", "flow_delta", "speed_delta", "density_delta", "delay_delta"]
    : mode === "environment" ? ["co2", "nox", "noise"] : ["flow", "speed", "density", "delay"];
  if (!metrics.includes(metric)) throw new Error("Style metric is unavailable for the selected mode.");
  return { display, metric, interval: Number(interval), maxHeightM: Number(maxHeightM), ...(scenarioA !== undefined ? { scenarioA: Number(scenarioA) } : {}), ...(scenarioB !== undefined ? { scenarioB: Number(scenarioB) } : {}) };
}
