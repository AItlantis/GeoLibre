// C15 host-managed view: cursor -> bucket, window -> minutes, reported period/info, pitched-map line paint.
import test from "node:test";
import assert from "node:assert/strict";
import { cursorToBucketMin, journeyHostInfo, journeyPeriod, windowToMinutes } from "../src/hostView.ts";
import { EMPTY_PERIOD_INFO, type PeriodInfo } from "../src/period.ts";
import { CASING_EXTRA_PX, MIN_LINE_PX, WIDTH_ZOOM_STOPS, lineWidthAt, zoomCasingWidth, zoomLineWidth } from "../src/linePaint.ts";
import { OVERLAY_CASING, overlayCasingPaint, overlayLinePaint } from "../src/overlay.ts";
import { SECTIONS_CASING, sectionCasingPaint, sectionLinePaint } from "../src/sectionOverlay.ts";
import { SECTION_LINE_WIDTH } from "../src/sections.ts";
import type { SimRow } from "../src/validation.ts";

const H = 3600;

test("cursorToBucketMin: floor(cursor_s / 60 / 15) * 15, wrapped to the day", () => {
  assert.equal(cursorToBucketMin(8 * H), 480);
  assert.equal(cursorToBucketMin(8 * H + 899), 480);
  assert.equal(cursorToBucketMin(8 * H + 900), 495);
  assert.equal(cursorToBucketMin(0), 0);
  assert.equal(cursorToBucketMin(25 * H + 1800), 90);
  assert.equal(cursorToBucketMin(Number.NaN), 0);
  assert.equal(cursorToBucketMin(-5), 0);
});

test("windowToMinutes: seconds -> minute-of-day window, clamped; empty windows are rejected", () => {
  assert.deepEqual(windowToMinutes({ from_s: 7 * H, to_s: 10 * H }), { from: 420, to: 600 });
  assert.deepEqual(windowToMinutes({ from_s: 7 * H + 30, to_s: 10 * H + 30 }), { from: 420, to: 601 });
  assert.deepEqual(windowToMinutes({ from_s: 20 * H, to_s: 30 * H }), { from: 1200, to: 1440 });
  assert.equal(windowToMinutes({ from_s: 5 * H, to_s: 5 * H }), null);
  assert.equal(windowToMinutes({ from_s: Number.NaN, to_s: 5 * H }), null);
});

const sim = (start: number, dur: number): SimRow => ({ route: "R", direction_norm: "NB", bucket_start_min: start / 60, sim_s: 100, n: 1, interval_start_s: start, duration_s: dur, run: "AM" });

test("journeyPeriod: manifest run_period (per run, then default), else the simulated span, else null", () => {
  const rp = (a: number, b: number, i: number | null) => ({ start_s: a, end_s: b, interval_s: i, day: null, source: "manifest" });
  const info: PeriodInfo = { runPeriods: { PM: rp(16 * H, 19 * H, 600) }, defaultPeriod: rp(7 * H, 10 * H, 300), sources: [] };
  assert.deepEqual(journeyPeriod(info, "PM", []), { start_s: 16 * H, end_s: 19 * H, interval_s: 600 });
  assert.deepEqual(journeyPeriod(info, "AM", []), { start_s: 7 * H, end_s: 10 * H, interval_s: 300 });
  const sims = [sim(8 * H, 300), sim(8 * H + 300, 300)];
  assert.deepEqual(journeyPeriod(EMPTY_PERIOD_INFO, "AM", sims), { start_s: 8 * H, end_s: 8 * H + 600, interval_s: 300 });
  assert.equal(journeyPeriod({ ...info, defaultPeriod: rp(7 * H, 10 * H, null) }, null, sims)!.interval_s, 300);
  assert.equal(journeyPeriod({ ...info, defaultPeriod: rp(7 * H, 10 * H, null) }, null, [])!.interval_s, 900);
  assert.equal(journeyPeriod(EMPTY_PERIOD_INFO, null, []), null);
});

test("journeyHostInfo: Journey Time reports a 900 s bucket and cursorMode cursor", () => {
  const info = journeyHostInfo({ plugin: "modelling-journey-time", run: "AM", generation: 3, period: null, mode: "validation", busy: true });
  assert.deepEqual(info, { plugin: "modelling-journey-time", run: "AM", generation: 3, period: null, bucket_s: 900, mode: "validation", cursorMode: "cursor", busy: true });
});

// Evaluates the subset of MapLibre expressions used here (interpolate/linear on zoom, max, *, +, numbers).
const evalExpr = (e: unknown, zoom: number): number => {
  if (typeof e === "number") return e;
  const [op, ...args] = e as unknown[];
  if (op === "max") return Math.max(...args.map((a) => evalExpr(a, zoom)));
  if (op === "*") return args.map((a) => evalExpr(a, zoom)).reduce((x, y) => x * y, 1);
  if (op === "+") return args.map((a) => evalExpr(a, zoom)).reduce((x, y) => x + y, 0);
  if (op === "interpolate") {
    const stops = args.slice(2) as unknown[];
    let prev: [number, number] | null = null;
    for (let i = 0; i < stops.length; i += 2) {
      const z = stops[i] as number;
      const v = evalExpr(stops[i + 1], zoom);
      if (zoom <= z) return prev ? prev[1] + (v - prev[1]) * ((zoom - prev[0]) / (z - prev[0])) : v;
      prev = [z, v];
    }
    return prev![1];
  }
  throw new Error(`unsupported ${String(op)}`);
};

test("line width: zoom-interpolated, floored, constant base for sections; matches the numeric model", () => {
  const w = zoomLineWidth(SECTION_LINE_WIDTH);
  assert.deepEqual(w.slice(0, 3), ["interpolate", ["linear"], ["zoom"]]);
  assert.equal(w.length, 3 + WIDTH_ZOOM_STOPS.length * 2);
  for (const z of [3, 8, 10, 12, 14, 16, 18, 20, 22]) {
    assert.ok(Math.abs(evalExpr(w, z) - lineWidthAt(SECTION_LINE_WIDTH, z)) < 1e-9, `zoom ${z}`);
    assert.ok(evalExpr(w, z) >= MIN_LINE_PX, `never vanishes at zoom ${z}`);
  }
  assert.equal(lineWidthAt(2, 3), MIN_LINE_PX);
  let prev = 0;
  for (let z = 6; z <= 22; z++) { const v = lineWidthAt(SECTION_LINE_WIDTH, z); assert.ok(v >= prev); prev = v; }
});

test("casing is wider than the line it sits under at every zoom, for routes and sections", () => {
  for (const base of [SECTION_LINE_WIDTH, 2, 4]) {
    const line = zoomLineWidth(base);
    const casing = zoomCasingWidth(base);
    for (let z = 3; z <= 22; z++) assert.ok(evalExpr(casing, z) > evalExpr(line, z), `zoom ${z} base ${base}`);
  }
  assert.ok(CASING_EXTRA_PX > 0);
  assert.equal((sectionLinePaint()["line-width"] as unknown[])[0], "interpolate");
  assert.equal(sectionCasingPaint()["line-color"], "#ffffff");
  assert.equal(sectionLinePaint()["line-opacity"], 1);
  assert.ok(SECTIONS_CASING.endsWith("casing") && OVERLAY_CASING.endsWith("casing"));
});

test("route overlay paint: data-driven stroke-width/opacity kept (selected vs dimmed routes), casing under it", () => {
  const line = overlayLinePaint();
  assert.deepEqual(line["line-color"], ["get", "stroke"]);
  assert.deepEqual(line["line-opacity"], ["coalesce", ["get", "stroke-opacity"], 0.9]);
  assert.equal(JSON.stringify(line["line-width"]).includes("stroke-width"), true);
  assert.equal((overlayCasingPaint()["line-width"] as unknown[])[0], "interpolate");
});
