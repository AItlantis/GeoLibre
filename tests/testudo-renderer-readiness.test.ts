import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentTestudoNativeAction, mapViewFromMapLibre, waitForTestudoRenderer, waitForTestudoRendererEpoch, type TestudoRendererReadinessRef } from "../apps/geolibre-desktop/src/lib/testudo-renderer-readiness";

test("renderer handoff captures the live MapLibre camera and visible bounds", () => {
  const view = mapViewFromMapLibre({
    getCenter: () => ({ lng: 54.379978, lat: 24.465657 }),
    getZoom: () => 15.3,
    getBearing: () => 8,
    getPitch: () => 51.1,
    getBounds: () => ({ toArray: () => [[54.36, 24.45], [54.40, 24.49]] }),
  });
  assert.deepEqual(view, { center: [54.379978, 24.465657], zoom: 15.3, bearing: 8, pitch: 51.1, bbox: [54.36, 24.45, 54.40, 24.49] });
});

test("renderer handoff leaves saved camera unchanged when MapLibre view is unavailable", () => {
  assert.equal(mapViewFromMapLibre(null), null);
  assert.equal(mapViewFromMapLibre({
    getCenter: () => ({ lng: Number.NaN, lat: 24 }), getZoom: () => 1,
    getBearing: () => 0, getPitch: () => 0,
  }), null);
});

test("stale native actions are rejected after the TView generation changes during startup", () => {
  let generation = 4;
  const current = () => ({ tviewId: "main", generation });
  const action = { tviewId: "main" as const, generation: 4 };
  assert.equal(isCurrentTestudoNativeAction(action, current), true);
  generation = 5;
  assert.equal(isCurrentTestudoNativeAction(action, current), false);
  assert.equal(isCurrentTestudoNativeAction({ tviewId: "other", generation: 5 }, current), false);
  assert.equal(isCurrentTestudoNativeAction(action, null), false);
});

test("renderer readiness waiter resolves after the matching epoch becomes ready", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "cesium", epoch: 7, ready: false, error: null } };
  const waiting = waitForTestudoRenderer(readiness, { renderer: "cesium", epoch: 7 }, new AbortController().signal, 500);
  setTimeout(() => { readiness.current = { ...readiness.current, ready: true }; }, 60);
  assert.deepEqual(await waiting, { renderer: "cesium", epoch: 7, ready: true, error: null });
});

test("renderer readiness waiter rejects when an epoch is superseded", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "cesium", epoch: 7, ready: false, error: null } };
  const waiting = waitForTestudoRenderer(readiness, { renderer: "cesium", epoch: 7 }, new AbortController().signal, 500);
  setTimeout(() => { readiness.current = { ...readiness.current, epoch: 8 }; }, 30);
  await assert.rejects(waiting, /renderer changed/i);
});

test("renderer readiness waiter rejects when cancelled", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "maplibre", epoch: 2, ready: false, error: null } };
  const controller = new AbortController();
  const waiting = waitForTestudoRenderer(readiness, { renderer: "maplibre", epoch: 2 }, controller.signal, 500);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, /cancelled/i);
});

test("renderer readiness waiter reports timeout and startup errors", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "maplibre", epoch: 2, ready: false, error: null } };
  await assert.rejects(waitForTestudoRenderer(readiness, { renderer: "maplibre", epoch: 2 }, new AbortController().signal, 20), /did not become ready/i);
  readiness.current = { ...readiness.current, error: "canvas unavailable" };
  await assert.rejects(waitForTestudoRenderer(readiness, { renderer: "maplibre", epoch: 2 }, new AbortController().signal, 500), /failed to start: canvas unavailable/i);
});


test("renderer handoff waiter accepts only the requested next epoch", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "cesium", epoch: 7, ready: true, error: null } };
  const waiting = waitForTestudoRendererEpoch(readiness, "maplibre", 8, new AbortController().signal, 500);
  setTimeout(() => { readiness.current = { renderer: "maplibre", epoch: 8, ready: false, error: null }; }, 20);
  setTimeout(() => { readiness.current = { renderer: "maplibre", epoch: 8, ready: true, error: null }; }, 50);
  assert.deepEqual(await waiting, { renderer: "maplibre", epoch: 8, ready: true, error: null });
});

test("renderer handoff waiter rejects supersession, error, abort, and timeout", async () => {
  const readiness: TestudoRendererReadinessRef = { current: { renderer: "cesium", epoch: 7, ready: true, error: null } };
  const superseded = waitForTestudoRendererEpoch(readiness, "maplibre", 8, new AbortController().signal, 300);
  setTimeout(() => { readiness.current = { renderer: "cesium", epoch: 9, ready: false, error: null }; }, 20);
  await assert.rejects(superseded, /superseded/i);
  readiness.current = { renderer: "cesium", epoch: 7, ready: true, error: null };
  const failed = waitForTestudoRendererEpoch(readiness, "maplibre", 8, new AbortController().signal, 300);
  setTimeout(() => { readiness.current = { renderer: "maplibre", epoch: 8, ready: false, error: "canvas failed" }; }, 20);
  await assert.rejects(failed, /failed to start: canvas failed/i);
  readiness.current = { renderer: "cesium", epoch: 7, ready: true, error: null };
  const controller = new AbortController();
  const aborted = waitForTestudoRendererEpoch(readiness, "maplibre", 8, controller.signal, 300);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(aborted, /cancelled/i);
  await assert.rejects(waitForTestudoRendererEpoch(readiness, "maplibre", 8, new AbortController().signal, 20), /did not become ready/i);
});
