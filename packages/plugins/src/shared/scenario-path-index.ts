/** Resolve a package path index while preserving the network-wide legacy default. */
export function selectScenarioPathIndex(
  indices: Record<string, unknown> | null,
  scenarioId?: string | number,
): string | null {
  if (!indices) return null;
  const scenarioEntry = scenarioId === undefined ? null : indices[String(scenarioId)];
  if (typeof scenarioEntry === "string" && scenarioEntry) return scenarioEntry;
  if (typeof indices["0"] === "string" && indices["0"]) return indices["0"];
  const keys = Object.keys(indices).filter(key => typeof indices[key] === "string" && indices[key]).sort();
  return keys.length ? indices[keys[0]] as string : null;
}
