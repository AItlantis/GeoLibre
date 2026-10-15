import test from "node:test";
import assert from "node:assert/strict";
import { hostLabel, isHostOpen, packageUiPlan } from "../../_shared/src/host-managed.ts";

const t = (_k: string, en: string, v?: Record<string, string | number>) => en.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(v?.[k] ?? ""));

test("host-opened plugin hides its package picker and run selector", () => {
  const ui = packageUiPlan(isHostOpen(new URLSearchParams({ aimsunPackage: "https://x/manifest.json", aimsunRun: "AMPK_3", aimsunHost: "testudo" })));
  assert.equal(ui.showPackagePicker, false);
  assert.equal(ui.showRunSelector, false);
  assert.equal(ui.showHostLabel, true);
  assert.equal(hostLabel("jumeira", "AMPK_3", t), "Package: jumeira / Run: AMPK_3");
});

test("standalone open (no host marker) keeps picker and run selector", () => {
  const ui = packageUiPlan(isHostOpen(new URLSearchParams({ aimsunPackage: "https://x/manifest.json" })));
  assert.deepEqual(ui, { showPackagePicker: true, showRunSelector: true, showHostLabel: false });
});
