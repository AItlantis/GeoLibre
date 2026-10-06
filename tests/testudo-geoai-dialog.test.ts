import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildGeoAIRequestDetail, clampDialogPosition, classifyGeoAIReply, INITIAL_GEOAI_DIALOG,
  readDialogPreferences, transitionGeoAIDialog, validateGeoAIAction, writeDialogPreferences,
} from "../apps/geolibre-desktop/src/lib/testudo-geoai-dialog";

test("dialog state transitions open, collapse, close and reopen", () => {
  let state = transitionGeoAIDialog(INITIAL_GEOAI_DIALOG, { type: "open" });
  assert.equal(state.open, true);
  state = transitionGeoAIDialog(state, { type: "collapse" });
  assert.equal(state.collapsed, true);
  state = transitionGeoAIDialog(state, { type: "expand" });
  assert.equal(state.collapsed, false);
  state = transitionGeoAIDialog(state, { type: "close" });
  assert.equal(state.open, false);
  assert.equal(transitionGeoAIDialog(state, { type: "open" }).open, true);
});

test("pending cancel invalidates id and late reply is ignored", () => {
  const pending = transitionGeoAIDialog(INITIAL_GEOAI_DIALOG, { type: "pending", requestId: "req-1" });
  const cancelled = transitionGeoAIDialog(pending, { type: "cancel" });
  assert.equal(cancelled.requestId, null);
  assert.equal(transitionGeoAIDialog(cancelled, { type: "reply", requestId: "req-1", kind: "answered" }), cancelled);
});

test("clarification, unavailable and valid answer replies are distinct", () => {
  assert.equal(classifyGeoAIReply({ error: "Please clarify the request. No answer was generated." }), "clarification-needed");
  assert.equal(classifyGeoAIReply({ error: "Ollama is unavailable." }), "unavailable");
  assert.equal(classifyGeoAIReply({ content: "The selected scenario has three runs." }), "answered");
  assert.equal(classifyGeoAIReply({ error: "This request is invalid." }), "error");
});

test("dialog position clamps to viewport bounds", () => {
  assert.deepEqual(clampDialogPosition({ x: 900, y: 900 }, { width: 800, height: 600 }, { width: 400, height: 450 }), { x: 392, y: 142 });
  assert.deepEqual(clampDialogPosition({ x: -10, y: -40 }, { width: 800, height: 600 }, { width: 400, height: 450 }), { x: 8, y: 8 });
});

test("action allowlist accepts supported viewer commands and rejects arbitrary actions", () => {
  assert.deepEqual(validateGeoAIAction({ type: "plugin", value: "vehicle-playback", label: "Show vehicles" }), {
    type: "plugin", value: "vehicle-playback", label: "Show vehicles",
  });
  assert.equal(validateGeoAIAction({ type: "plugin", value: "shell", label: "Run shell" }), null);
  assert.equal(validateGeoAIAction({ type: "mapControl", controlId: "network-filter", value: true, label: "Toggle" }), null);
  assert.equal(validateGeoAIAction({ type: "camera", value: { center: [181, 0], zoom: 4 }, label: "Fly" }), null);
  assert.deepEqual(validateGeoAIAction({ type: "seek", value: 12, label: "Go to tick 12" }), { type: "seek", value: 12, label: "Go to tick 12" });
});

test("session preference storage failures are tolerated", () => {
  const failingGet = { getItem() { throw new Error("blocked"); } } as unknown as Storage;
  const failingSet = { setItem() { throw new Error("quota"); } } as unknown as Storage;
  assert.deepEqual(readDialogPreferences(failingGet), {});
  assert.doesNotThrow(() => writeDialogPreferences(failingSet, { position: { x: 10, y: 20 }, collapsed: true }));
  let saved = "";
  writeDialogPreferences({ setItem(_key, value) { saved = value; } }, { position: { x: 10, y: 20 }, collapsed: true });
  assert.deepEqual(JSON.parse(saved), { position: { x: 10, y: 20 }, collapsed: true });
});

test("emitted request is bounded and contains no credential-like fields; dialog has no fetch path", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls += 1; throw new Error("unexpected network call"); }) as typeof fetch;
  try {
    const detail = buildGeoAIRequestDetail({ localRequestId: "local-1", tviewId: "view-1", question: "Explain this.",
      scenarioId: "baseline", messages: [{ role: "user", content: "Explain this." }] });
    const encoded = JSON.stringify(detail);
    assert.doesNotMatch(encoded, /token|secret|credential|password|authorization/i);
    assert.equal(fetchCalls, 0);
    const component = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoGeoAIDialog.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(component, /\bfetch\s*\(/);
  } finally { globalThis.fetch = originalFetch; }
});
