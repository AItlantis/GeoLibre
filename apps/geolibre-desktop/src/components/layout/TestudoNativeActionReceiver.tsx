import { useEffect, useState } from "react";
import { ANNOTATIONS_PLUGIN_ID } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import { isTestudoNativeActionEvent, TESTUDO_NATIVE_ACTION_EVENT, type TestudoNativeActionResult } from "../../lib/testudo-protocol";
import { isCurrentTestudoNativeAction, testudoActionUnavailableReason, waitForTestudoRenderer, type TestudoRendererReadinessRef, type TestudoTViewIdentityRef } from "../../lib/testudo-renderer-readiness";
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
      const respond = (result: TestudoNativeActionResult) => {
        try { detail.respond(result); } catch { /* The bridge request may already have timed out. */ }
      };
      void (async () => {
        try {
          const expected = rendererReadinessRef.current;
          const readiness = await waitForTestudoRenderer(rendererReadinessRef, expected, actionController.signal);
          if (disposed || actionController.signal.aborted) return;
          const engine = mapControllerRef.current;
          if (!engine) {
            throw new Error(readiness.error ?? "The active map renderer reported ready without publishing its engine.");
          }
          if (rendererReadinessRef.current.epoch !== expected.epoch
            || rendererReadinessRef.current.renderer !== expected.renderer) {
            throw new Error("The map renderer changed before the action could start. Try again after it finishes switching.");
          }
          const unavailable = testudoActionUnavailableReason(detail.action, engine);
          if (unavailable) throw new Error(unavailable);
          if (!isCurrentTestudoNativeAction(detail, currentTViewRef.current)) {
            throw new Error("The package changed before this action could start. Try again after it finishes loading.");
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
          respond({ ok: true });
        } catch (error) {
          if (!disposed && !actionController.signal.aborted) {
            respond({ ok: false, error: error instanceof Error ? error.message : "The requested map action failed." });
          }
        } finally {
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
