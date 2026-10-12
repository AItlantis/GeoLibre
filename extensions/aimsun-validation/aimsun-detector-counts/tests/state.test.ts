import test from "node:test";
import assert from "node:assert/strict";
import { initialState, minToLabel, normalizeWindow, reduce } from "../src/common/state.ts";

const loaded = () =>
  reduce(
    reduce(initialState(), { type: "package-loaded", label: "data", runs: ["AMPK_3", "PMPK_3"], run: "AMPK_3" }),
    { type: "probe-ready", fromMin: 420, toMin: 480, bucket: 60, bucketOptions: [60, 120] },
  );

test("normalizeWindow clamps and keeps from < to", () => {
  assert.deepEqual(normalizeWindow(-5, 2000), [0, 1440]);
  assert.deepEqual(normalizeWindow(600, 600), [600, 601]);
  assert.deepEqual(normalizeWindow(900, 100), [900, 901]);
  assert.deepEqual(normalizeWindow(1500, 1600), [1439, 1440]);
  assert.deepEqual(normalizeWindow(Number.NaN, Number.NaN, [420, 480]), [420, 480]);
  assert.deepEqual(normalizeWindow(10.4, 70.6), [10, 71]);
});

test("package-loaded then probe-ready reaches ready with the probed window", () => {
  const s = loaded();
  assert.equal(s.phase, "ready");
  assert.equal(s.run, "AMPK_3");
  assert.equal(s.fromMin, 420);
  assert.equal(s.toMin, 480);
  assert.equal(s.busy, false);
});

test("selecting a run clears the selection and goes back to loading", () => {
  let s = reduce(loaded(), { type: "select-detector", id: "123" });
  assert.equal(s.selectedId, "123");
  s = reduce(s, { type: "run-selected", run: "PMPK_3" });
  assert.equal(s.run, "PMPK_3");
  assert.equal(s.selectedId, null);
  assert.equal(s.phase, "loading");
});

test("bucket must be one of the offered options", () => {
  const s = loaded();
  assert.equal(reduce(s, { type: "set-bucket", bucket: 15 }), s);
  assert.equal(reduce(s, { type: "set-bucket", bucket: 120 }).bucket, 120);
});

test("set-window normalises and marks busy", () => {
  const s = reduce(loaded(), { type: "set-window", fromMin: 500, toMin: 400 });
  assert.deepEqual([s.fromMin, s.toMin], [500, 501]);
  assert.equal(s.busy, true);
});

test("sort toggles direction on the same key and defaults per key", () => {
  let s = initialState();
  assert.equal(s.sortKey, "geh");
  s = reduce(s, { type: "sort", key: "geh" });
  assert.equal(s.sortDir, "asc");
  s = reduce(s, { type: "sort", key: "id" });
  assert.deepEqual([s.sortKey, s.sortDir], ["id", "asc"]);
  s = reduce(s, { type: "sort", key: "diff" });
  assert.deepEqual([s.sortKey, s.sortDir], ["diff", "desc"]);
});

test("top-N is clamped; error ends busy", () => {
  assert.equal(reduce(initialState(), { type: "set-top-n", n: 0 }).topN, 20);
  assert.equal(reduce(initialState(), { type: "set-top-n", n: 9999 }).topN, 500);
  const e = reduce(reduce(initialState(), { type: "package-loading" }), { type: "error", message: "boom" });
  assert.deepEqual([e.phase, e.error, e.busy], ["error", "boom", false]);
});

test("minToLabel", () => {
  assert.equal(minToLabel(0), "00:00");
  assert.equal(minToLabel(425), "07:05");
  assert.equal(minToLabel(1440), "24:00");
});
