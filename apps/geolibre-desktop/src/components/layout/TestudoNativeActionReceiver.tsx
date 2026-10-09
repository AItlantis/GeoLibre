import { useEffect, useState } from "react";
import { useAppStore } from "@geolibre/core";
import { ANNOTATIONS_PLUGIN_ID } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import { isTestudoNativeActionEvent, TESTUDO_NATIVE_ACTION_EVENT, type TestudoNativeActionResult } from "../../lib/testudo-protocol";
import { isCurrentTestudoNativeAction, testudoActionUnavailableReason, waitForTestudoRenderer, waitForTestudoRendererEpoch, type TestudoRendererReadinessRef, type TestudoTViewIdentityRef } from "../../lib/testudo-renderer-readiness";
import { RecordTourDialog } from "./RecordTourDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";

interface TestudoNativeActionReceiverProps {
  appApi: ReturnType<typeof createAppAPI> | null;
  mapControllerRef: React.RefObject<MapEngine | null>;
  rendererReadinessRef: TestudoRendererReadinessRef;
  currentTViewRef: TestudoTViewIdentityRef;
}

/**
 * Owns Testudo-only camera actions and their dialogs. It is mounted by
 * DesktopShell even when the embed hides TopToolbar; standalone toolbar actions
 * remain owned by TopToolbar. Actions wait briefly for the active renderer and
 * are cancelled when that renderer epoch changes.
 */
export function TestudoNativeActionReceiver({ appApi, mapControllerRef, rendererReadinessRef, currentTViewRef }: TestudoNativeActionReceiverProps) {
  const { isActive, toggle } = usePluginRegistry();
  const [recordTourOpen, setRecordTourOpen] = useState(false);
  const [recordVideoOpen, setRecordVideoOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const pending = new Set<AbortController>();
    const onNativeAction = (event: Event) => {
      if (!isTestudoNativeActionEvent(event)) return;
      const { detail } = event;
      const actionController = new AbortController();
      pending.add(actionController);
      let timedOut = false;
      const respond = (result: TestudoNativeActionResult) => {
        try { detail.respond(result); } catch { /* The bridge request may already have timed out. */ }
      };
      const deadline = window.setTimeout(() => {
        timedOut = true;
        actionController.abort();
        respond({ ok: false, error: "The requested map action could not finish before its deadline." });
      }, 12_000);
      const assertCurrent = () => {
        if (disposed || actionController.signal.aborted) throw new Error("The map action was cancelled.");
        if (!isCurrentTestudoNativeAction(detail, currentTViewRef.current)) {
          throw new Error("The package changed before this action could start. Try again after it finishes loading.");
        }
      };
      void (async () => {
        try {
          const expected = rendererReadinessRef.current;
          const initialReadiness = await waitForTestudoRenderer(rendererReadinessRef, expected, actionController.signal, 2_500);
          assertCurrent();
          let engine = mapControllerRef.current;
          if (!engine) throw new Error(initialReadiness.error ?? "The active map renderer reported ready without publishing its engine.");

          if (detail.action === "annotations" && initialReadiness.renderer === "cesium") {
            const capturedView = engine.readView();
            assertCurrent();
            const targetEpoch = expected.epoch + 1;
            useAppStore.getState().setMapView(capturedView);
            useAppStore.getState().setPrimaryRenderer("maplibre");
            await waitForTestudoRendererEpoch(rendererReadinessRef, "maplibre", targetEpoch, actionController.signal, 10_000);
            assertCurrent();
            const mapLibreEngine = mapControllerRef.current;
            if (!mapLibreEngine || mapLibreEngine.kind !== "maplibre" || !mapLibreEngine.capabilities.nativeMapInstance) {
              throw new Error("MapLibre became ready without publishing its annotation-capable map controller.");
            }
            await mapLibreEngine.applyView(capturedView);
            assertCurrent();
            const restoredReadiness = rendererReadinessRef.current;
            if (restoredReadiness.renderer !== "maplibre" || restoredReadiness.epoch !== targetEpoch || !restoredReadiness.ready
              || mapControllerRef.current !== mapLibreEngine) {
              throw new Error("The renderer changed before the camera view could be restored. Try the annotation action again.");
            }
            engine = mapLibreEngine;
          } else {
            if (rendererReadinessRef.current.epoch !== expected.epoch || rendererReadinessRef.current.renderer !== expected.renderer) {
              throw new Error("The map renderer changed before the action could start. Try again after it finishes switching.");
            }
          }

          assertCurrent();
          const unavailable = testudoActionUnavailableReason(detail.action, engine);
          if (unavailable) throw new Error(unavailable);
          // Revalidate immediately before opening dialogs or activating a plugin.
          assertCurrent();
          if (detail.action === "annotations" && (rendererReadinessRef.current.renderer !== "maplibre" || mapControllerRef.current !== engine)) {
            throw new Error("MapLibre is no longer active. Try the annotation action again after the renderer settles.");
          }
          switch (detail.action) {
            case "record-tour":
              setRecordTourOpen(true);
              break;
            case "record-video":
              setRecordVideoOpen(true);
              break;
            case "annotations":
              if (!isActive(ANNOTATIONS_PLUGIN_ID)) toggle(ANNOTATIONS_PLUGIN_ID, appApi ?? createAppAPI(mapControllerRef));
              if (!isActive(ANNOTATIONS_PLUGIN_ID)) throw new Error("The annotations tool could not be activated.");
              break;
          }
          assertCurrent();
          respond({ ok: true });
        } catch (error) {
          if (!disposed && !timedOut && !actionController.signal.aborted) {
            respond({ ok: false, error: error instanceof Error ? error.message : "The requested map action failed." });
          }
        } finally {
          window.clearTimeout(deadline);
          pending.delete(actionController);
        }
      })();
    };
    window.addEventListener(TESTUDO_NATIVE_ACTION_EVENT, onNativeAction);
    return () => {
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear();
      window.removeEventListener(TESTUDO_NATIVE_ACTION_EVENT, onNativeAction);
    };
  }, [appApi, currentTViewRef, isActive, mapControllerRef, rendererReadinessRef, toggle]);

  return (
    <>
      <RecordTourDialog open={recordTourOpen} onOpenChange={setRecordTourOpen} mapControllerRef={mapControllerRef} />
      <RecordVideoDialog open={recordVideoOpen} onOpenChange={setRecordVideoOpen} mapControllerRef={mapControllerRef} />
    </>
  );
}
