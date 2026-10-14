import test from "node:test";
import assert from "node:assert/strict";
import { hostLabel, isHostOpen, packageUiPlan } from "../src/host-managed.ts";

const t = (_k: string, en: string, v?: Record<string, string | number>) => en.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(v?.[k] ?? ""));

test("host marker is only recognised for aimsunHost=testudo", () => {
  assert.equal(isHostOpen(new URLSearchParams({ aimsunPackage: "u", aimsunHost: "testudo" })), true);
  assert.equal(isHostOpen(new URLSearchParams({ aimsunPackage: "u" })), false);
  assert.equal(isHostOpen(new URLSearchParams({ aimsunHost: "other" })), false);
});

test("hostManaged hides package picker and run selector and shows the host label", () => {
  assert.deepEqual(packageUiPlan(true), { showPackagePicker: false, showRunSelector: false, showHostLabel: true });
  assert.deepEqual(packageUiPlan(false), { showPackagePicker: true, showRunSelector: true, showHostLabel: false });
});

test("hostLabel omits unknown parts", () => {
  assert.equal(hostLabel("jumeira", "AMPK_3", t), "Package: jumeira / Run: AMPK_3");
  assert.equal(hostLabel(null, "AMPK_3", t), "Run: AMPK_3");
  assert.equal(hostLabel("p", undefined, t), "Package: p");
});
