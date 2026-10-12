import test from "node:test";
import assert from "node:assert/strict";
import { lineSvg, minutesToHHMM } from "../src/lineSvg.ts";

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test("minutesToHHMM", () => {
  assert.equal(minutesToHHMM(0), "00:00");
  assert.equal(minutesToHHMM(495), "08:15");
  assert.equal(minutesToHHMM(1440), "00:00");
});

test("empty input -> 'No data' svg", () => {
  assert.match(lineSvg({ series: [] }), /No data/);
  assert.match(lineSvg({ series: [{ label: "a", points: [{ x: 0, y: null }] }] }), /No data/);
});

test("one path per run: a null value breaks the line", () => {
  const pts = [0, 15, 30, 45, 60].map((x, i) => ({ x, y: i === 2 ? null : 10 + i }));
  const svg = lineSvg({ series: [{ label: "mean", points: pts }] });
  assert.equal(count(svg, /<path data-series="mean"/g), 2);
});

test("a time gap larger than 1.5x the smallest step breaks the line", () => {
  const pts = [0, 15, 30, 120, 135].map((x) => ({ x, y: 5 }));
  assert.equal(count(lineSvg({ series: [{ label: "m", points: pts }] }), /<path data-series/g), 2);
});

test("band polygons, legend, vline and dashes", () => {
  const svg = lineSvg({
    series: [{ label: "median", points: [{ x: 0, y: 5 }, { x: 15, y: 6 }], dash: "5 3" }],
    band: { label: "min-max", points: [{ x: 0, lo: 4, hi: 7 }, { x: 15, lo: 5, hi: 8 }] },
    vline: 15,
    xMin: 0,
    xMax: 1440,
  });
  assert.equal(count(svg, /<polygon/g), 1);
  assert.match(svg, /data-marker="1"/);
  assert.match(svg, /stroke-dasharray="5 3"/);
  assert.match(svg, />min-max</);
  assert.match(svg, />09:00</); // 3-hourly ticks over a day
  assert.equal(lineSvg({ series: [{ label: "m", points: [{ x: 0, y: 5 }] }], vline: 5000, xMin: 0, xMax: 1440 }).includes("data-marker"), false);
});

test("y axis starts at 0 and scales above the band max; labels are escaped", () => {
  const svg = lineSvg({ series: [{ label: "<b>x</b>", points: [{ x: 0, y: 3 }, { x: 15, y: 4 }] }], band: { label: "b", points: [{ x: 0, lo: 1, hi: 90 }] } });
  assert.ok(!svg.includes("<b>"));
  assert.match(svg, /&lt;b&gt;/);
  assert.match(svg, />80</); // the axis spans the band max (90) with nice ticks
});

test("single point draws a dot", () => {
  assert.match(lineSvg({ series: [{ label: "m", points: [{ x: 0, y: 5 }] }] }), /<circle/);
});
