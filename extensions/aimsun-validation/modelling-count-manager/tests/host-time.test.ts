/** C15 host-managed time window, auto bucket and the host-mode controls (C1/C2). */
import test from "node:test";
import assert from "node:assert/strict";
import { planHostWindow } from "../src/common/host-window.ts";
import { WHOLE_PERIOD } from "../src/common/sql.ts";
import { controlsSection, statusBanner } from "../src/common/panel-parts.ts";
import { initialState } from "../src/common/state.ts";
import { installDomShim } from "./dom-shim.ts";

const period = { start_s: 25200, end_s: 28800, interval_s: 300 }; // 07:00-08:00, 5 min
const opts = [5, 15, 30, 60, WHOLE_PERIOD];

test("planHostWindow: snaps to the interval grid and uses the auto bucket (w <= 3h -> 15 min)", () => {
  const p = planHostWindow({ from_s: 25290, to_s: 28500, cursor_s: 25290 }, period, opts);
  assert.deepEqual([p.fromMin, p.toMin], [420, 475]);
  assert.equal(p.bucket, 15);
  assert.equal(p.bucket_s, 900);
});

test("planHostWindow: 3-8 h -> 30 min, > 8 h -> 60 min, never below the data interval", () => {
  const day = { start_s: 0, end_s: 86400, interval_s: 3600 };
  const o = [60, WHOLE_PERIOD];
  assert.equal(planHostWindow({ from_s: 0, to_s: 6 * 3600, cursor_s: 0 }, day, o).bucket, 60, "auto 30 min < 60 min interval -> smallest option");
  assert.equal(planHostWindow({ from_s: 0, to_s: 86400, cursor_s: 0 }, day, o).bucket_s, 3600);
  const fine = { start_s: 0, end_s: 86400, interval_s: 300 };
  const o2 = [5, 15, 30, 60, WHOLE_PERIOD];
  assert.equal(planHostWindow({ from_s: 0, to_s: 6 * 3600, cursor_s: 0 }, fine, o2).bucket, 30);
  assert.equal(planHostWindow({ from_s: 0, to_s: 12 * 3600, cursor_s: 0 }, fine, o2).bucket, 60);
});

test("planHostWindow: a window of one interval is the whole period; windows are clamped into the period", () => {
  const p = planHostWindow({ from_s: 25300, to_s: 25400, cursor_s: 25300 }, period, opts);
  assert.equal(p.bucket, WHOLE_PERIOD);
  assert.deepEqual([p.fromMin, p.toMin], [420, 425]);
  assert.equal(p.bucket_s, 300);
  const c = planHostWindow({ from_s: 0, to_s: 99999, cursor_s: 0 }, period, opts);
  assert.deepEqual([c.fromMin, c.toMin], [420, 480]);
});

const t = (_k: string, en: string, v?: Record<string, string | number>) => en.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(v?.[k] ?? ""));
const source = (id: string) => ({ sourceId: id, file: id, effective: "comparable" as const });
function ctxWith(choices: unknown[] | null) {
  const state = { ...initialState(), phase: "ready" as const, runs: ["R1"], run: "R1", obsSource: "both" as never, bucketOptions: [60] };
  const ctl = { state, obsSourceChoices: () => choices, hasObsData: true, validationReason: null, reports: [], bucketStepMin: 5, whole: () => null, selectRun: () => undefined, setObsSource: () => undefined, setWindow: () => undefined, setBucket: () => undefined };
  return { app: {}, t, fmt: {}, ctl } as never;
}
const text = (n: unknown) => (n as { textContent: string }).textContent;
const choice = (id: string) => ({ value: id, kind: "source", source: source(id) });

test("host-managed controls hide From/To/Bucket and the bucket hint; standalone keeps them", () => {
  const restore = installDomShim();
  try {
    const host = text(controlsSection(ctxWith([choice("a"), choice("b")]), true));
    assert.ok(!/From|To|Bucket|Buckets are whole/.test(host), host);
    assert.ok(/Observed source/.test(host));
    const alone = text(controlsSection(ctxWith([choice("a"), choice("b")]), false));
    assert.ok(/From/.test(alone) && /Bucket/.test(alone) && /Buckets are whole/.test(alone));
  } finally { restore(); }
});

test("observed source: select only with several sources, a plain text line with one", () => {
  const restore = installDomShim();
  try {
    for (const hostManaged of [true, false]) {
      const one = controlsSection(ctxWith([choice("loopA")]), hostManaged) as unknown as { querySelector(s: string): { textContent: string } | null; textContent: string };
      assert.equal(one.querySelector('[data-testid="observed-source-label"]')?.textContent, "Observed: loopA");
      assert.ok(!/Observed source/.test(one.textContent));
      const many = controlsSection(ctxWith([{ value: "both", kind: "all" }, choice("a"), choice("b")]), hostManaged) as unknown as { querySelector(s: string): unknown; textContent: string };
      assert.equal(many.querySelector('[data-testid="observed-source-label"]'), null);
      assert.ok(/Observed source/.test(many.textContent) && /All comparable sources/.test(many.textContent));
    }
    // zero sources: the existing (disabled) select is kept
    assert.ok(/Observed source/.test(text(controlsSection(ctxWith([]), true))));
  } finally { restore(); }
});

test("host-managed: no Package/Run line and no Reports line; standalone keeps both", () => {
  const restore = installDomShim();
  try {
    const mk = () => {
      const c = ctxWith([choice("a"), choice("b")]) as unknown as { ctl: { state: Record<string, unknown>; reports: unknown[] } };
      c.ctl.state.sourceLabel = "jumeira";
      c.ctl.reports = [{ name: "observed_report.json" }];
      return c as never;
    };
    assert.equal(text(statusBanner(mk(), true)).trim(), "");
    assert.ok(/Package: jumeira/.test(text(statusBanner(mk(), false))));
    assert.ok(!/Reports:/.test(text(controlsSection(mk(), true))));
    assert.ok(/Reports: observed_report.json/.test(text(controlsSection(mk(), false))));
    const err = mk() as unknown as { ctl: { state: Record<string, unknown> } };
    err.ctl.state.phase = "error"; err.ctl.state.error = "boom";
    assert.ok(/boom/.test(text(statusBanner(err as never, true))));
  } finally { restore(); }
});

test("legacy observed source (host-managed): plain text with one real source, select with two", () => {
  const restore = installDomShim();
  try {
    const mk = (have: string[]) => {
      const c = ctxWith(null) as unknown as { ctl: { legacyObsSources: string[] } };
      c.ctl.legacyObsSources = have;
      return c as never;
    };
    const one = controlsSection(mk(["calibration"]), true) as unknown as { querySelector(s: string): { textContent: string } | null; textContent: string };
    assert.equal(one.querySelector('[data-testid="observed-source-label"]')?.textContent, "Observed: Calibration");
    assert.ok(!/Observed source/.test(one.textContent));
    const two = text(controlsSection(mk(["validation", "calibration"]), true));
    assert.ok(/Observed source/.test(two) && /Both/.test(two));
    assert.ok(/Observed source/.test(text(controlsSection(mk(["calibration"]), false))), "standalone unchanged");
  } finally { restore(); }
});
