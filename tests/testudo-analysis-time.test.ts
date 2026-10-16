import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { acceptsTestudoMessage, TESTUDO_COMMANDS } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
import { StaleAnalysisGenerationError, TestudoAnalysisController } from "../apps/geolibre-desktop/src/lib/testudo-analysis";

const parent = {} as Window;
const origin = "https://app.testudo.live";
const challenge = "0123456789abcdef0123456789abcdef";
const BASE = "https://testudo.example/api/v1/analysis-bytes/v1/tokA/analysis/";
const MANIFEST = `${BASE}run1/analysis_manifest.json`;
const PLUGIN = "modelling-journey-time";

const accepts = (payload: Record<string, unknown>) => acceptsTestudoMessage(
  { source: parent, origin, data: { v: 2, source: "testudo", requestId: "1", type: "testudoSetAnalysisTime", payload: { challenge, ...payload } } },
  parent, [origin], challenge);
const ok = { plugin: PLUGIN, generation: 1, from_s: 0, to_s: 3600, cursor_s: 0 };

describe("testudoSetAnalysisTime protocol", () => {
  it("is allowlisted and validates the payload", () => {
    assert.ok(TESTUDO_COMMANDS.includes("testudoSetAnalysisTime" as never));
    assert.equal(accepts(ok), true);
    for (const patch of [
      { plugin: "other" }, { generation: 0 }, { generation: 1.5 }, { from_s: NaN }, { to_s: Infinity }, { cursor_s: "1" },
      { cursor_s: 3600 }, { cursor_s: -1 }, { to_s: 0 }, { extra: 1 },
    ]) assert.equal(accepts({ ...ok, ...patch }), false, JSON.stringify(patch));
    assert.equal(accepts({ ...ok, challenge: "f".repeat(32) }), false);
  });
});

function setup(plugin: Record<string, unknown> | null, open: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true })) {
  const statuses: Array<Record<string, unknown>> = [];
  const infos: Array<Record<string, unknown>> = [];
  const closes: string[] = [];
  const host = {
    openWithParams: async () => open(),
    deactivate: (id: string) => { closes.push(id); },
    getPlugin: () => plugin,
  };
  const c = new TestudoAnalysisController(host, {} as GeoLibreAppAPI, s => statuses.push(s as never), Date.now, i => infos.push(i as never));
  c.setPackage({
    schemaVersion: 1, baseUrl: BASE, expiresAt: Date.now() + 60_000,
    runs: [{ run: "run1", label: "Run 1", available: true, manifest: "run1/analysis_manifest.json" }, { run: "run2", label: "Run 2", available: true, manifest: "run2/analysis_manifest.json" }],
    plugins: { "analysis-journey-time": { pluginId: PLUGIN, available: true } },
  } as never);
  return { c, statuses, infos, closes };
}
const openPayload = (generation: number, run = "run1") => ({ plugin: PLUGIN, manifestUrl: run === "run1" ? MANIFEST : `${BASE}${run}/analysis_manifest.json`, run, generation }) as never;

describe("TestudoAnalysisController C15", () => {
  it("emits loading first, then open", async () => {
    const { c, statuses } = setup({});
    await c.open(openPayload(1));
    assert.deepEqual(statuses, [
      { plugin: PLUGIN, status: "loading", run: "run1", generation: 1 },
      { plugin: PLUGIN, status: "open", run: "run1", generation: 1 },
    ]);
  });

  it("emits loading then error when the open fails", async () => {
    const { c, statuses } = setup({}, async () => ({ ok: false, error: "boom" }));
    await assert.rejects(c.open(openPayload(1)), /boom/);
    assert.deepEqual(statuses.map(s => s.status), ["loading", "error"]);
  });

  it("forwards setTime to setTimeWindow, validates generation and plugin state", async () => {
    const wins: unknown[] = [];
    const { c } = setup({ setTimeWindow: (w: unknown) => wins.push(w) });
    assert.throws(() => c.setTime({ ...ok, generation: 1 } as never), /not open/);
    await c.open(openPayload(2));
    assert.throws(() => c.setTime({ ...ok, generation: 1 } as never), StaleAnalysisGenerationError);
    assert.throws(() => c.setTime({ ...ok, generation: 3 } as never), StaleAnalysisGenerationError);
    assert.throws(() => c.setTime({ ...ok, generation: 2, cursor_s: 9999 } as never), /Invalid/);
    const status = c.setTime({ ...ok, generation: 2, from_s: 100, to_s: 900, cursor_s: 200 } as never);
    assert.equal(status.status, "open");
    assert.deepEqual(wins.at(-1), { from_s: 100, to_s: 900, cursor_s: 200 });
  });

  it("ignores setTime for a plugin without setTimeWindow", async () => {
    const { c } = setup({});
    await c.open(openPayload(1));
    assert.doesNotThrow(() => c.setTime({ ...ok, generation: 1 } as never));
  });

  it("replays a window received while still loading once the open completes", async () => {
    const wins: unknown[] = [];
    let release: (v: { ok: boolean }) => void = () => undefined;
    const { c } = setup({ setTimeWindow: (w: unknown) => wins.push(w) }, () => new Promise(resolve => { release = resolve; }));
    const pending = c.open(openPayload(1));
    c.setTime({ ...ok, generation: 1, to_s: 500 } as never);
    release({ ok: true });
    await pending;
    assert.equal(wins.length, 2);
    assert.deepEqual(wins.at(-1), { from_s: 0, to_s: 500, cursor_s: 0 });
  });

  it("relays plugin info stamped with plugin/generation and drops it after close or a newer generation", async () => {
    let cb: ((info: Record<string, unknown>) => void) | null = null;
    const { c, infos } = setup({ onHostInfo: (fn: typeof cb) => { cb = fn; } });
    await c.open(openPayload(1));
    cb!({ run: null, period: { start_s: 0, end_s: 3600, interval_s: 900 }, bucket_s: 900, mode: "dynamic", cursorMode: "cursor", busy: false, generation: 99, plugin: "x" });
    assert.deepEqual(infos[0], { run: "run1", period: { start_s: 0, end_s: 3600, interval_s: 900 }, bucket_s: 900, mode: "dynamic", cursorMode: "cursor", busy: false, generation: 1, plugin: PLUGIN });
    const stale = cb!;
    await c.open(openPayload(2));
    stale({ busy: true });
    assert.equal(infos.length, 1);
    c.close({ plugin: PLUGIN });
    assert.equal(cb, null);
  });

  it("uses setRun for a run switch over the same manifest, falling back to a reopen otherwise", async () => {
    const runs: string[] = [];
    let opens = 0;
    const plugin = { setRun: async (run: string) => { runs.push(run); return run === "run1"; } };
    const { c, statuses } = setup(plugin, async () => { opens++; return { ok: true }; });
    const same = { plugin: PLUGIN, manifestUrl: MANIFEST, run: "run1", generation: 1 } as never;
    await c.open(same);
    assert.equal(opens, 1);
    await c.open({ plugin: PLUGIN, manifestUrl: MANIFEST, run: "run2", generation: 2 } as never);
    assert.deepEqual(runs, ["run2"]);
    assert.equal(opens, 2, "setRun returned false -> reopen");
    await c.open({ plugin: PLUGIN, manifestUrl: MANIFEST, run: "run1", generation: 3 } as never);
    assert.equal(opens, 2, "setRun accepted -> no reopen");
    assert.deepEqual(statuses.at(-1), { plugin: PLUGIN, status: "open", run: "run1", generation: 3 });
    assert.equal(statuses.filter(s => s.status === "loading").length, 3);
  });
});
