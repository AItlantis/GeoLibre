import type { TestudoMapHandle } from "./shared/testudo-feature-session";

export const RENDERING_OUTPUTS_LOCAL_IDS = [
  "rendering-outputs.source", "rendering-outputs.line", "rendering-outputs.extrusion-source",
  "rendering-outputs.extrusion-fill", "rendering-outputs.selection-source", "rendering-outputs.selection",
  "rendering-outputs.lane.source", "rendering-outputs.lane", "rendering-outputs.lane.extrusion-source",
  "rendering-outputs.lane.extrusion-fill", "rendering-outputs.turn.source", "rendering-outputs.turn",
] as const;

export type TestudoOwnedMode = "animation" | "results" | "comparison" | "paths";
export const TESTUDO_MODE_OWNERS: Readonly<Record<TestudoOwnedMode, readonly string[]>> = Object.freeze({
  animation: ["positions", "positions-layer"],
  results: ["source", "layer", "selection-source", "selection"],
  comparison: ["source", "layer"],
  paths: ["source", "layer"],
});

const token = (namespace: string) => namespace.replace(/^testudo-/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
export function testudoNetworkOwnedIds(namespace: string): string[] {
  const key = token(namespace);
  return RENDERING_OUTPUTS_LOCAL_IDS.map((local) => local.replace("rendering-outputs.", `rendering-outputs.${key}.`));
}
export function testudoModeOwnedIds(namespace: string, mode: TestudoOwnedMode): string[] {
  const key = token(namespace);
  const prefix = mode === "animation" ? "testudo-vehicle" : mode === "results" ? "testudo-results" : mode === "paths" ? "testudo-path" : "testudo-comparison";
  return TESTUDO_MODE_OWNERS[mode].map((local) => `${prefix}-${key}-${local}`);
}
export function testudoOwnedIds(namespace: string, mode: TestudoOwnedMode): string[] {
  return [...testudoNetworkOwnedIds(namespace), ...testudoModeOwnedIds(namespace, mode)];
}

/** Idempotently remove only the old mode's IDs; permanent network IDs survive. */
export function switchTestudoModeLayers(
  map: TestudoMapHandle | null,
  namespace: string,
  previous: TestudoOwnedMode,
  next: TestudoOwnedMode,
): string[] {
  if (previous === next) return testudoOwnedIds(namespace, next);
  const oldIds = testudoModeOwnedIds(namespace, previous);
  for (const candidate of [...oldIds].reverse()) {
    if (map?.getLayer(candidate)) map.removeLayer(candidate);
    if (map?.getSource(candidate)) map.removeSource(candidate);
    if (map?.getLayer(`${candidate}-layer`)) map.removeLayer(`${candidate}-layer`);
    if (map?.getSource(`${candidate}-source`)) map.removeSource(`${candidate}-source`);
  }
  return testudoOwnedIds(namespace, next);
}
