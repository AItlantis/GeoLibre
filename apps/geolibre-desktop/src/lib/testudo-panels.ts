import { useSyncExternalStore } from "react";

/** Side panels the Testudo shell shows. Default (command never sent) is everything hidden, as before. */
export interface TestudoPanelsState {
  layers: boolean;
  plugins: boolean;
  comments: boolean;
  /** Results dashboard is a dedicated lateral panel, separate from plugin UI. */
  results: boolean;
  /** Layers is shown as a collapsed rail entry (never hidden by collapsing). */
  layersCollapsed: boolean;
  /** The host drives GeoAI, so the in-iframe "Ask GeoAI" overlay is hidden. */
  hostGeoAi: boolean;
}

export const TESTUDO_PANELS_DEFAULT: TestudoPanelsState = Object.freeze({
  layers: false, plugins: false, comments: false, results: false, layersCollapsed: true, hostGeoAi: false,
});

let current: TestudoPanelsState = TESTUDO_PANELS_DEFAULT;
const listeners = new Set<() => void>();

export function getTestudoPanels(): TestudoPanelsState { return current; }

export function setTestudoPanels(next: TestudoPanelsState): TestudoPanelsState {
  const same = (Object.keys(next) as Array<keyof TestudoPanelsState>).every(key => next[key] === current[key]);
  if (!same) { current = { ...next }; listeners.forEach(listener => listener()); }
  return current;
}

export function resetTestudoPanels(): TestudoPanelsState { return setTestudoPanels(TESTUDO_PANELS_DEFAULT); }

/** Validate a testudoSetPanels payload (already shape-checked by the protocol) into a full state; latest call wins. */
export function testudoPanelsFromPayload(payload: { layers: boolean; plugins: boolean; comments: boolean; results?: boolean; layersCollapsed?: boolean; hostGeoAi?: boolean }): TestudoPanelsState {
  return {
    layers: payload.layers, plugins: payload.plugins, comments: payload.comments, results: payload.results ?? false,
    layersCollapsed: payload.layersCollapsed ?? true, hostGeoAi: payload.hostGeoAi ?? false,
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTestudoPanels(): TestudoPanelsState {
  return useSyncExternalStore(subscribe, getTestudoPanels, getTestudoPanels);
}
