import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/package.ts";
import { scatterSvg, histogramSvg, barSvg, niceTicks, esc } from "../src/charts.ts";
import { normalizeValue, defaultWasmUrls } from "../src/duckdb.ts";

test("validateManifest accepts v1 and rejects bad input", () => {
  const ok = validateManifest({ schema_version: 1, files: [{ table: "od_before", path: "sub/od_before.parquet" }] });
  assert.equal(ok.files.length, 1);
  assert.throws(() => validateManifest({ schema_version: 2, files: [] }), /schema_version/);
  assert.throws(() => validateManifest({ schema_version: 1 }), /files/);
  assert.throws(() => validateManifest({ schema_version: 1, files: [{ table: "x; drop", path: "a.parquet" }] }), /table/);
  assert.throws(() => validateManifest({ schema_version: 1, files: [{ table: "a", path: "../a.parquet" }] }), /relative/);
  assert.throws(() => validateManifest({ schema_version: 1, files: [{ table: "a", path: "https://x/a.parquet" }] }), /relative/);
  assert.throws(
    () => validateManifest({ schema_version: 1, files: [{ table: "a", path: "a.parquet" }, { table: "a", path: "b.parquet" }] }),
    /duplicate/,
  );
});

test("chart helpers produce well-formed SVG", () => {
  const s = scatterSvg([1, 2, 3], [1.1, 2.2, 2.9], { trend: { slope: 1, intercept: 0 }, xTitle: "obs", yTitle: "sim" });
  assert.match(s, /^<svg /);
  assert.equal((s.match(/<circle /g) ?? []).length, 3);
  assert.equal((s.match(/stroke-dasharray/g) ?? []).length, 1); // identity line
  assert.match(histogramSvg([{ start: 0, end: 1, value: 3 }, { start: 1, end: 2, value: 5 }]), /<rect /);
  assert.match(barSvg([{ label: "<a>", value: -2 }, { label: "b", value: 4 }]), /&lt;a&gt;/);
  assert.match(scatterSvg([], []), /No data/);
  assert.deepEqual(niceTicks(0, 10), [0, 2, 4, 6, 8, 10]);
  assert.equal(esc(`<&"'>`), "&lt;&amp;&quot;&#39;&gt;");
});

test("duckdb helpers", () => {
  assert.equal(normalizeValue(5n), 5);
  assert.equal(normalizeValue(2n ** 70n), (2n ** 70n).toString());
  const urls = defaultWasmUrls(); // no document in node -> CDN only
  assert.ok(urls[urls.length - 1].includes("1.33.1-dev57.0"));
});

test("stackedBarSvg: compact height, 0-100 axis ticks every 25, axis title, legend values, labelled target", async () => {
  const { stackedBarSvg, SHARE_H, CHART_H } = await import("../src/charts.ts");
  const svg = stackedBarSvg([
    { label: "Pass", value: 60, color: "#2e7d32" },
    { label: "Warn", value: 25, color: "#f9a825" },
    { label: "Fail", value: 15, color: "#c62828" },
  ], 85);
  assert.ok(SHARE_H >= 90 && SHARE_H <= 110 && SHARE_H < CHART_H);
  assert.ok(svg.includes(`viewBox="0 0 560 ${SHARE_H}"`));
  for (const tick of [0, 25, 50, 75, 100]) assert.ok(svg.includes(`>${tick}</text>`), `tick ${tick}`);
  assert.ok(svg.includes("Share of detectors (%)"));
  for (const l of ["Pass 60%", "Warn 25%", "Fail 15%"]) assert.ok(svg.includes(l), l);
  assert.ok(svg.includes("Target 85%"));
  assert.ok(stackedBarSvg([], 85, "x", { xTitle: "Part (%)", targetLabel: "Cible 85%" }).includes("Cible 85%"));
});
