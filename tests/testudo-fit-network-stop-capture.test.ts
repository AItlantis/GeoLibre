import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PackageFitter } from "../packages/plugins/src/shared/testudo-package-fit";
import { TESTUDO_COMMANDS, isTestudoCaptureKind } from "../apps/geolibre-desktop/src/lib/testudo-protocol";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("new commands are allow-listed and client methods are wired", () => {
  for (const c of ["testudoFitNetwork", "testudoStopCapture"]) assert.ok((TESTUDO_COMMANDS as readonly string[]).includes(c), c);
  const embed = read("../packages/embed/src/index.ts");
  assert.match(embed, /testudoFitNetwork\(payload[^\n]*TestudoCameraViewState \| null>/);
  assert.match(embed, /testudoStopCapture\(payload[^\n]*kind: "annotations" \| "record-tour" \| "record-video"[^\n]*stopped: boolean/);
  assert.match(embed, /testudoFitNetwork: \(payload\) => sendTestudo\("testudoFitNetwork"/);
  assert.match(embed, /testudoStopCapture: \(payload\) => sendTestudo\("testudoStopCapture"/);
});

test("capture kind validation", () => {
  for (const k of ["annotations", "record-tour", "record-video"]) assert.equal(isTestudoCaptureKind(k), true);
  for (const k of ["", "tour", null, 1, undefined]) assert.equal(isTestudoCaptureKind(k), false);
});

test("handlers read bounds at call time, check generation, and reuse the package fitter", () => {
  const src = read("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx");
  const fit = src.slice(src.indexOf('request.type === "testudoFitNetwork"'), src.indexOf('request.type === "testudoSetViewMode"'));
  assert.match(fit, /persistentNetwork\.getGeometryBounds\(\) \?\? packageManifestBounds/);
  assert.match(fit, /packageFitter\.fitNow\(/);
  assert.match(fit, /stale package generation/);
  assert.match(fit, /if \(!bounds\) return null/);
  assert.match(fit, /testudoStopCapture/);
  assert.match(fit, /isTestudoCaptureKind\(kind\)/);
  assert.match(src, /packageFitter\.reset\(\); packageManifestBounds = null/);
});

test("PackageFitter.fitNow ignores fit-once and user-moved gates, rejects invalid bounds", () => {
  const fits: unknown[] = [];
  const map = { on() {}, off() {}, fitBounds: (b: unknown) => { fits.push(b); } };
  const fitter = new PackageFitter();
  const target = { map };
  assert.equal(fitter.fit("v1", [1, 2, 3, 4], target), true);
  assert.equal(fitter.fit("v1", [1, 2, 3, 4], target), false);
  assert.equal(fitter.fitNow([5, 6, 7, 8], target), true);
  assert.equal(fitter.fitNow([5, 6, 7, 8], target), true);
  assert.equal(fits.length, 3);
  assert.equal(fitter.fitNow(null, target), false);
  assert.equal(fitter.fitNow([9, 9, 1, 1], target), false);
  const applied: unknown[] = [];
  assert.equal(fitter.fitNow([1, 2, 3, 4], { map: null, applyCamera: c => applied.push(c) }), true);
  assert.equal(applied.length, 1);
});

test("receiver stops dialogs and annotations on the stop event", () => {
  const rx = read("../apps/geolibre-desktop/src/components/layout/TestudoNativeActionReceiver.tsx");
  assert.match(rx, /TESTUDO_NATIVE_STOP_EVENT/);
  assert.match(rx, /setRecordTourOpen\(false\)/);
  assert.match(rx, /setRecordVideoOpen\(false\)/);
  assert.match(rx, /toggle\(ANNOTATIONS_PLUGIN_ID/);
});
