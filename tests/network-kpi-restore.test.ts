import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the actual restore/load functions with controlled IO and renderer
// boundaries. Importing the plugin directly requires Vite's browser-only WASM
// and worker URL imports, which node:test cannot resolve.
const source = readFileSync(new URL(
  "../packages/plugins/src/plugins/maplibre-network-kpi.ts", import.meta.url,
), "utf8");
const functions = ["restoreNetworkKpi", "setNetworkKpiManifestUrl", "clearLoaded"]
  .map((name) => {
    const match = source.match(new RegExp(
      `^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, "m",
    ));
    assert.ok(match, `Missing production function ${name}`);
    return match[0].replace(/^export /, "");
  }).join("\n");
const script = stripTypeScriptTypes(functions);

function harness() {
  const calls = { attach: 0, cleared: 0, closed: 0, fetch: 0, state: 0, status: 0 };
  const defaults = { manifestUrl: null as string | null, interval: 0, did: null, intervalPlaying: false };
  const idle = { loading: false, hasResults: false, localFolderName: null as string | null };
  const context = {
    DEFAULT_NETWORK_KPI_SETTINGS: defaults,
    IDLE_STATUS: idle,
    appRef: null,
    panelVisible: true,
    settings: { ...defaults, manifestUrl: "https://package/manifest.json" as string | null, interval: 3, did: 7, intervalPlaying: true },
    status: { ...idle, hasResults: true },
    loadedPackage: {} as object | null,
    database: { close() { calls.closed++; } } as { close(): void } | null,
    pendingManifest: null as object | null,
    loadToken: 4,
    networkKpiLayerVisible: true,
    engine: { setPackage() { calls.cleared++; }, applySettings() {} },
    normalizeNetworkKpiSettings: (state: object | undefined, base: object) => ({ ...base, ...state }),
    settingsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    attachEngine() { calls.attach++; },
    notifyState() { calls.state++; },
    notifyStatus() { calls.status++; },
    patchStatus(patch: object) { context.status = { ...context.status, ...patch }; },
    openNetworkKpiPanel() { context.panelVisible = true; },
    closeNetworkKpiPanel() { context.panelVisible = false; context.loadToken++; },
    clearNetworkKpiGeometryCache() {},
    fetchNetworkKpiManifestJson: async (_url: string): Promise<object> => { calls.fetch++; return {}; },
    capabilityAvailable: () => ({ available: true }),
    listVehicleManifestScenarios: () => [],
    adoptScenario: async (_index: number, _token: number) => {},
    restoreNetworkKpi: undefined as unknown as (app: object, state: object) => boolean,
    setNetworkKpiManifestUrl: undefined as unknown as (url: string) => Promise<void>,
  };
  runInNewContext(script, context);
  return { context, calls };
}

for (const manifestUrl of [null, "https://package/manifest.json"]) {
  test(`compatible restore preserves a loaded package (restored URL: ${manifestUrl})`, () => {
    const { context: c, calls } = harness();
    const before = { settings: c.settings, status: c.status, package: c.loadedPackage, database: c.database };
    assert.equal(c.restoreNetworkKpi({}, { open: true, manifestUrl }), false);
    assert.equal(c.settings, before.settings);
    assert.equal(c.status, before.status);
    assert.equal(c.loadedPackage, before.package);
    assert.equal(c.database, before.database);
    assert.equal(c.loadToken, 4);
    assert.deepEqual(calls, { attach: 1, cleared: 0, closed: 0, fetch: 0, state: 0, status: 0 });
  });
}

for (const phase of ["manifest", "results"] as const) {
  test(`late restore during ${phase} IO preserves the URL and lets the original load finish`, async () => {
    const { context: c, calls } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enteredResults!: () => void;
    const resultsStarted = new Promise<void>((resolve) => { enteredResults = resolve; });
    c.fetchNetworkKpiManifestJson = async () => {
      calls.fetch++;
      if (phase === "manifest") await gate;
      return {};
    };
    c.adoptScenario = async (_index, token) => {
      enteredResults();
      if (phase === "results") await gate;
      if (token !== c.loadToken) return;
      c.loadedPackage = { sections: 53 };
      c.status = { ...c.status, loading: false, hasResults: true };
    };
    const loading = c.setNetworkKpiManifestUrl("https://package/manifest.json");
    if (phase === "results") await resultsStarted;
    assert.equal(c.status.loading, true);
    assert.equal(c.loadedPackage, null);
    assert.equal(Boolean(c.pendingManifest), phase === "results");
    const settings = c.settings;
    const token = c.loadToken;
    const closes = calls.closed;
    assert.equal(c.restoreNetworkKpi({}, { open: true, manifestUrl: null }), false);
    assert.equal(c.settings, settings);
    assert.equal(c.settings.manifestUrl, "https://package/manifest.json");
    assert.equal(c.loadToken, token);
    assert.equal(c.status.loading, true);
    assert.equal(calls.closed, closes);
    release();
    await loading;
    assert.deepEqual(c.loadedPackage, { sections: 53 });
    assert.equal(c.status.loading, false);
    assert.equal(c.settings.manifestUrl, "https://package/manifest.json");
    assert.equal(calls.fetch, 1);
  });
}

test("compatible restore preserves a local folder and its loaded status", () => {
  const { context: c, calls } = harness();
  c.settings.manifestUrl = null;
  c.status.localFolderName = "London";
  c.restoreNetworkKpi({}, { open: true });
  assert.equal(c.status.localFolderName, "London");
  assert.equal(c.status.hasResults, true);
  assert.equal(calls.closed, 0);
});

test("a different manifest still replaces the package", () => {
  const { context: c, calls } = harness();
  c.restoreNetworkKpi({}, { open: true, manifestUrl: "https://other/manifest.json" });
  assert.equal(c.loadedPackage, null);
  assert.equal(c.settings.manifestUrl, "https://other/manifest.json");
  assert.equal(c.loadToken, 5);
  assert.equal(calls.closed, 1);
  assert.equal(calls.fetch, 1);
});

test("an explicit close still clears the live package", () => {
  const { context: c, calls } = harness();
  c.restoreNetworkKpi({}, { open: false });
  assert.equal(c.panelVisible, false);
  assert.equal(c.loadedPackage, null);
  assert.equal(calls.closed, 1);
});

test("an idle panel with a stale pending manifest still restores saved settings", () => {
  const { context: c, calls } = harness();
  c.loadedPackage = null;
  c.pendingManifest = {};
  c.restoreNetworkKpi({}, { open: true, interval: 8 });
  assert.equal(c.settings.interval, 8);
  assert.equal(calls.closed, 1);
});
