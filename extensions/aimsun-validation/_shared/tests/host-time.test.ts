import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBucketSeconds, bucketIndexAt, clampWindow, isFiniteWindow, snapToInterval } from "../src/host-time.ts";

test("autoBucketSeconds follows the contract", () => {
  assert.equal(autoBucketSeconds(0, 3 * 3600, 300), 900);
  assert.equal(autoBucketSeconds(0, 3 * 3600 + 1, 300), 1800);
  assert.equal(autoBucketSeconds(0, 8 * 3600, 300), 1800);
  assert.equal(autoBucketSeconds(0, 8 * 3600 + 1, 300), 3600);
  assert.equal(autoBucketSeconds(0, 7200, 1800), 1800);
  assert.equal(autoBucketSeconds(0, 7200, 3600), 3600);
  assert.equal(autoBucketSeconds(0, 600, 900), 600);
});

test("isFiniteWindow validates ordering", () => {
  assert.ok(isFiniteWindow({ from_s: 0, to_s: 10, cursor_s: 0 }));
  assert.ok(!isFiniteWindow({ from_s: 0, to_s: 10, cursor_s: 10 }));
  assert.ok(!isFiniteWindow({ from_s: NaN, to_s: 10, cursor_s: 1 }));
  assert.ok(!isFiniteWindow({ from_s: 0, to_s: 10, cursor_s: "1" }));
});

test("clampWindow keeps the window inside the period", () => {
  const p = { start_s: 100, end_s: 1000 };
  assert.deepEqual(clampWindow({ from_s: 0, to_s: 5000, cursor_s: 50 }, p), { from_s: 100, to_s: 1000, cursor_s: 100 });
  assert.equal(clampWindow({ from_s: 0, to_s: 50, cursor_s: 10 }, p), null);
  assert.equal(clampWindow({ from_s: 0, to_s: 10, cursor_s: 1 }, { start_s: 5, end_s: 5 }), null);
});

test("snapToInterval and bucketIndexAt", () => {
  assert.equal(snapToInterval(1334, 1000, 300), 1300);
  assert.equal(snapToInterval(500, 1000, 300), 1000);
  assert.equal(snapToInterval(5000, 1000, 300, 2000), 2000);
  assert.equal(bucketIndexAt(1650, 1000, 300, 10), 2);
  assert.equal(bucketIndexAt(99999, 1000, 300, 10), 9);
  assert.equal(bucketIndexAt(0, 1000, 300, 10), 0);
});
