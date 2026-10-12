import assert from "node:assert/strict";
import test from "node:test";
import { complianceShares, computeKpis, DEFAULT_CRITERIA, flowBandStats, gehBins, validateCriteria, type ValRow } from "../src/common/aggregate.ts";
import { assembleDayProfile, histogramSvg, timeSeriesSvg } from "../../_shared/src/charts.ts";

const row = (obs: number, sim: number): ValRow => ({ detector_id: String(obs), oid: null, bucket_start_min: 420, obs_flow_h: obs, sim_flow_h: sim, geh: 0, status: "pass" });

test("flow bands include their lower edge and report n, pass percent, and bias", () => {
  const bands = flowBandStats([row(249, 249), row(250, 300), row(500, 400), row(2000, 2000)]);
  assert.deepEqual(bands.map((b) => b.n), [1, 1, 1, 0, 1]);
  assert.equal(bands[1].passPct, 100);
  assert.equal(bands[1].meanBias, 50);
});

test("custom flow-band edges re-bin rows and criteria validate defaults and bounds", () => {
  assert.deepEqual(DEFAULT_CRITERIA, { gehPass: 5, gehFail: 10, targetPct: 85, flowBandEdges: [250, 500, 1000, 2000], bandPassPct: 85, bandWarnPct: 70 });
  assert.deepEqual(flowBandStats([row(100, 100), row(300, 300), row(900, 900)], { ...DEFAULT_CRITERIA, flowBandEdges: [200, 400, 800, 1200] }).map((b) => b.n), [1, 1, 0, 1, 0]);
  assert.throws(() => validateCriteria({ ...DEFAULT_CRITERIA, gehPass: 12, gehFail: 10 }), /pass threshold/);
  assert.throws(() => validateCriteria({ ...DEFAULT_CRITERIA, targetPct: 101 }), /within 0 to 100/);
  assert.throws(() => validateCriteria({ ...DEFAULT_CRITERIA, flowBandEdges: [250, 200, 1000, 2000] }), /increasing/);
});

test("custom GEH pass and target thresholds update KPI judgement", () => {
  const rows = [row(100, 130), row(100, 350)];
  const k = computeKpis(rows, { ...DEFAULT_CRITERIA, gehPass: 4, gehFail: 12, targetPct: 50 });
  assert.equal(k.pctGehLt5, 50);
  assert.equal(k.meetsTarget, true);
  assert.deepEqual([k.nPass, k.nWarn, k.nFail], [1, 0, 1]);
});

test("compliance shares use GEH pass/warn/fail boundaries", () => {
  const shares = complianceShares([row(100, 100), row(100, 200), row(100, 500)]);
  assert.equal(shares.n, 3);
  assert.equal(shares.pass, 1);
  assert.equal(shares.warn, 1);
  assert.equal(shares.fail, 1);
  assert.ok(Math.abs(shares.passPct! - 100 / 3) < 1e-12);
});

test("histogram supports per-bin colours and explicit vertical guide lines", () => {
  const svg = histogramSvg([{ start: 0, end: 5, value: 1 }, { start: 5, end: 10, value: 2 }, { start: 10, end: 11, value: 3 }], {
    binColor: (b) => b.start >= 10 ? "#c62828" : b.start >= 5 ? "#f9a825" : "#2e7d32",
    guides: [{ value: 5 }, { value: 10 }],
  });
  for (const color of ["#2e7d32", "#f9a825", "#c62828"]) assert.ok(svg.includes('fill="' + color + '"'));
  assert.equal((svg.match(/stroke-dasharray="4 3"/g) ?? []).length, 2);
});

test("custom GEH boundaries split histogram bins at the live criteria", () => {
  const bins = gehBins([2.4, 2.5, 4, 7.25, 11], 1, 10, [2.5, 7.25]);
  assert.ok(bins.some((b) => b.start === 2.5));
  assert.ok(bins.some((b) => b.start === 7.25));
  assert.equal(bins.reduce((sum, b) => sum + b.value, 0), 5);
});

test("day profile assembly sorts points, drops invalid rows, and computes simulated-window mean", () => {
  const series = assembleDayProfile([{ minute: 425, value: 20 }, { minute: 420, value: 10 }, { minute: 1440, value: 99 }, { minute: 430, value: Number.NaN }],
    [{ value: 15, startMin: 420, endMin: 450 }, { value: 25, startMin: 450, endMin: 480 }]);
  assert.deepEqual(series.observed, [{ minute: 420, value: 10 }, { minute: 425, value: 20 }]);
  assert.equal(series.observedWindowMean, 15);
  assert.deepEqual(series.simulated.map((s) => s.value), [15, 25]);
  assert.match(timeSeriesSvg(series), /<polyline/);
  assert.equal((timeSeriesSvg(series).match(/<path /g) ?? []).length, 2);
  assert.match(timeSeriesSvg(series), /fill-opacity="0.12"/);
});

