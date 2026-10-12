import test from "node:test";
import assert from "node:assert/strict";
import { geh, gehStatus, relativeError, hourlyFlow, regressionStats, histogram, haversineKm, deviationRatio } from "../src/metrics.ts";

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.notEqual(a, null);
  assert.ok(Math.abs((a as number) - b) < eps, `${a} != ${b}`);
};

test("geh known values", () => {
  close(geh(1100, 1000), Math.sqrt((2 * 100 ** 2) / 2100));
  close(geh(1100, 1000), 3.0861, 1e-3);
  close(geh(500, 1000), 18.2574, 1e-3);
  assert.equal(geh(0, 0), 0);
  assert.equal(geh(100, 100), 0);
  assert.equal(geh(1000, 0), Math.sqrt(2 * 1000)); // c = 0 is defined, not NaN
});

test("geh status thresholds", () => {
  assert.equal(gehStatus(4.99), "pass");
  assert.equal(gehStatus(5), "warn");
  assert.equal(gehStatus(10), "warn");
  assert.equal(gehStatus(10.01), "fail");
});

test("relative error and hourly flow", () => {
  close(relativeError(110, 100), 0.1);
  assert.equal(relativeError(5, 0), null);
  assert.equal(hourlyFlow(250, 15, "count"), 1000); // 250 veh in 15 min
  assert.equal(hourlyFlow(1000, 15), 1000); // default kind is a rate: unchanged
  assert.equal(hourlyFlow(1000, 15, "rate"), 1000);
});

test("regressionStats: perfect line y = 2x + 1", () => {
  const x = [1, 2, 3, 4, 5];
  const y = x.map((v) => 2 * v + 1);
  const s = regressionStats(x, y);
  assert.equal(s.count, 5);
  close(s.slope, 2);
  close(s.intercept, 1);
  close(s.r2, 1);
  close(s.bias, 4); // mean(y - x) = mean(x + 1) = 4
  close(s.mae, 4);
});

test("regressionStats: hand-computed example", () => {
  // x = obs, y = sim
  const x = [10, 20, 30, 40];
  const y = [12, 18, 33, 37];
  const s = regressionStats(x, y);
  // errors: 2,-2,3,-3 -> bias 0, mae 2.5, rmse sqrt(26/4)
  close(s.bias, 0);
  close(s.mae, 2.5);
  close(s.rmse, Math.sqrt(6.5));
  // sxx = 500, sxy = 450
  const mx = 25, my = 25;
  const sxy = [10, 20, 30, 40].reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0);
  close(s.slope, sxy / 500);
  close(s.slope, 0.9, 1e-12);
  close(s.intercept, 25 - 0.9 * 25);
  // r2 = sxy^2 / (sxx * syy), syy = 169+49+64+144 = 426
  close(s.r2, (450 * 450) / (500 * 426), 1e-12);
  // identity R2 = 1 - SSE/SSTobs = 1 - 26/500
  close(s.r2Identity, 1 - 26 / 500, 1e-12);
});

test("regressionStats: edge cases", () => {
  const empty = regressionStats([], []);
  assert.equal(empty.count, 0);
  assert.equal(empty.slope, null);
  const flatX = regressionStats([5, 5, 5], [1, 2, 3]);
  assert.equal(flatX.slope, null);
  assert.equal(flatX.r2, null);
  const withNaN = regressionStats([1, 2, NaN, 4], [1, 2, 3, 4]);
  assert.equal(withNaN.count, 3);
});

test("pctGehLt5", () => {
  // pairs (obs, sim): (1000,1100) geh 3.09 pass; (1000,500) geh 18 fail
  const s = regressionStats([1000, 1000], [1100, 500]);
  assert.equal(s.pctGehLt5, 50);
});

test("histogram weighted", () => {
  const h = histogram([0.5, 1.5, 1.7, 3.2], 1, [10, 1, 2, 5]);
  assert.deepEqual(h, [
    { start: 0, end: 1, count: 10 },
    { start: 1, end: 2, count: 3 },
    { start: 3, end: 4, count: 5 },
  ]);
  assert.throws(() => histogram([1], 0));
});

test("haversine", () => {
  // 1 degree of latitude ~ 111.195 km
  close(haversineKm(0, 0, 1, 0), 111.195, 0.01);
  assert.equal(haversineKm(10, 20, 10, 20), 0);
  // Paris -> London ~ 343.5 km
  close(haversineKm(48.8566, 2.3522, 51.5074, -0.1278), 343.5, 1);
});

test("deviationRatio zero denominator", () => {
  assert.equal(deviationRatio(100, 150), 0.5);
  assert.equal(deviationRatio(0, 0), 0);
  assert.equal(deviationRatio(0, 5), null);
});
