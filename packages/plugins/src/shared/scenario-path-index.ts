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

/** Resolve path declarations using the same root/envelope and legacy-field precedence as the path parser. */
export function resolvePathIndexDeclaration(
  raw: unknown,
  scenarioId?: string | number,
): string | null {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const envelope = root.__geolibrePackage && typeof root.__geolibrePackage === "object"
    ? root.__geolibrePackage as Record<string, unknown>
    : {};
  const indices = (root.path_indices ?? root.pathIndicesByScid ?? envelope.pathIndicesByScid ?? null) as Record<string, unknown> | null;
  const scenarioIndex = scenarioId === undefined ? null : selectScenarioPathIndex(indices, scenarioId);
  const pathIndex = scenarioIndex ?? root.path_index ?? selectScenarioPathIndex(indices);
  return typeof pathIndex === "string" && pathIndex.length > 0 ? pathIndex : null;
}
