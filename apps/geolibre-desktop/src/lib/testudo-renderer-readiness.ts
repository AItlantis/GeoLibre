import type { MapEngine } from "@geolibre/map";
import type { MapViewState } from "@geolibre/core";
import type { TestudoNativeActionDetail } from "./testudo-protocol";

export type TestudoRenderer = "maplibre" | "cesium";

export interface TestudoRendererReadiness {
  renderer: TestudoRenderer;
  epoch: number;
  ready: boolean;
  error: string | null;
}

export interface TestudoRendererReadinessRef { current: TestudoRendererReadiness }
export type TestudoNativeAction = "annotations" | "record-tour" | "record-video";

export interface TestudoTViewIdentity {
  tviewId: string;
  generation: number;
}

export type TestudoTViewIdentityRef = {
  current: (() => TestudoTViewIdentity | null) | null;
};

/** Read the live MapLibre camera before replacing it with the Cesium renderer. */
export function mapViewFromMapLibre(map: {
  getCenter(): { lng: number; lat: number } | null | undefined;
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getBounds?(): { toArray(): [[number, number], [number, number]] } | null | undefined;
} | null | undefined): MapViewState | null {
  if (!map) return null;
  const center = map.getCenter();
  const zoom = map.getZoom();
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  if (!center || ![center.lng, center.lat, zoom, bearing, pitch].every(Number.isFinite)) return null;
  const bounds = map.getBounds?.()?.toArray();
  const bbox = bounds?.flat();
  return {
    center: [center.lng, center.lat],
    zoom,
    bearing,
    pitch,
    ...(bbox?.length === 4 && bbox.every(Number.isFinite)
      ? { bbox: bbox as [number, number, number, number] }
      : {}),
  };
}

/** Ensure a native action still targets the live TView generation after waiting for renderer startup. */
export function isCurrentTestudoNativeAction(
  action: Pick<TestudoNativeActionDetail, "tviewId" | "generation">,
  getCurrent: TestudoTViewIdentityRef["current"],
): boolean {
  if (!getCurrent) return false;
  const current = getCurrent();
  return current?.tviewId === action.tviewId && current.generation === action.generation;
}


/** Wait only within the renderer epoch that accepted the native action. */
export async function waitForTestudoRenderer(
  readiness: TestudoRendererReadinessRef,
  expected: Pick<TestudoRendererReadiness, "renderer" | "epoch">,
  signal: AbortSignal,
  timeoutMs = 2_500,
): Promise<TestudoRendererReadiness> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal.aborted) throw new Error("The map action was cancelled while the renderer was starting.");
    const current = readiness.current;
    if (current.renderer !== expected.renderer || current.epoch !== expected.epoch) {
      throw new Error("The map renderer changed before the action could start. Try again after it finishes switching.");
    }
    if (current.ready) return current;
    if (current.error) throw new Error(`${current.renderer === "cesium" ? "Cesium" : "MapLibre"} failed to start: ${current.error}`);
    if (Date.now() >= deadline) {
      throw new Error(`${current.renderer === "cesium" ? "Cesium" : "MapLibre"} did not become ready in time. Try switching back to MapLibre.`);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(new Error("The map action was cancelled while the renderer was starting.")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 40);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Describe renderer-specific limitations before opening an action dialog. */
export function testudoActionUnavailableReason(action: TestudoNativeAction, engine: MapEngine): string | null {
  if (action === "annotations" && !engine.capabilities.nativeMapInstance) {
    return "Annotations currently require MapLibre. Switch to MapLibre to use this tool.";
  }
  if (action === "record-tour" && (!engine.readView || !engine.flyTo)) {
    return "Map tour recording is not supported by the active renderer.";
  }
  if (action === "record-video" && !engine.getRenderSurface()) {
    return "Video recording is not supported until the active renderer has a capture surface.";
  }
  return null;
}
