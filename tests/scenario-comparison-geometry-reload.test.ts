import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Bug #277 (scenario-comparison mode): switching scenarioA/scenarioB through
// setScenarioComparisonSettings() re-queries the KPI numbers via readCurrent()
// (which IS scenario-aware — it looks the new index up in the live
// TestudoDatasetProvider's own metadata), but never re-resolved the
// `geometry`/`geometryB` module state that render()/enableSideBySide() draw:
// those were populated exactly once, at initial manifest load, for whatever
// scenarioA/scenarioB were selected then. So the rendered section/lane shapes
// stayed pinned to the original scenario pairing even after the numbers
// underneath had changed.
//
// The fix adds `reloadScenarioGeometry()`, called from
// setScenarioComparisonSettings() whenever scenarioA/scenarioB actually
// changed, mirroring maplibre-network-kpi's adoptScenario() pattern of
// re-fetching geometry alongside results on every scenario switch.
//
// This test extracts the real, unmodified `setScenarioComparisonSettings`
// and `reloadScenarioGeometry` out of source with regex + VM (the same
// technique network-kpi-restore.test.ts uses) and drives them against a
// mock context, since the production module pulls in maplibre-gl/deck.gl/
// DuckDB-WASM import graphs that node:test cannot resolve directly.

const source = readFileSync(new URL(
  "../packages/plugins/src/plugins/maplibre-scenario-comparison.ts", import.meta.url,
), "utf8");

function extractFunction(name: string): string {
  // These two are written as single-line (no-line-break) function bodies in
  // production, so a same-line, non-greedy match up to the function's own
  // balanced-brace end isn't reliable with regex alone — instead, find the
  // start and walk forward counting braces to the matching close.
  const startMatch = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(startMatch, `Missing production function ${name}`);
  const start = startMatch.index!;
  const openBraceIndex = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end !== -1, `Could not find end of function ${name}`);
  return source.slice(start, end).replace(/^export /, "");
}

const script = stripTypeScriptTypes(
  `${extractFunction("setScenarioComparisonSettings")}\n${extractFunction("reloadScenarioGeometry")}`,
);

/** Flush pending microtasks AND at least one macrotask tick — a bare chain of
 *  `await Promise.resolve()` isn't enough here because reloadScenarioGeometry
 *  is invoked fire-and-forget (`void reloadScenarioGeometry(...)`) and awaits
 *  a real `async` mock (`loadNetworkKpiGeometry`) inside `Promise.all`, which
 *  needs an extra turn of the event loop to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  const calls = {
    updateReplications: 0,
    enableSideBySide: 0,
    disableSideBySide: 0,
    readCurrent: 0,
    render: 0,
    notify: 0,
    setSharedDeckLayers: 0,
    loadNetworkKpiGeometry: [] as Array<{ source: unknown; sections: unknown }>,
  };
  const geometryBySection: Record<string, { sections: string }> = {};
  const context: Record<string, unknown> = {
    settings: { scenarioA: 0, scenarioB: 0, mode: "diff" as string },
    provider: { id: "provider" },
    status: { error: null as string | null },
    geometry: { sections: "geometry-A-initial" },
    geometryB: { sections: "geometry-B-initial" },
    loadToken: 1,
    geometryReadToken: 0,
    layerVisible: true,
    packageSource: { id: "source" },
    manifestRaw: { id: "manifest" },
    manifestBaseUrl: "https://host/manifest.json",
    updateReplications: () => { calls.updateReplications += 1; },
    enableSideBySide: () => { calls.enableSideBySide += 1; },
    disableSideBySide: () => { calls.disableSideBySide += 1; },
    readCurrent: () => { calls.readCurrent += 1; return Promise.resolve(); },
    render: () => { calls.render += 1; },
    notify: () => { calls.notify += 1; },
    setSharedDeckLayers: () => { calls.setSharedDeckLayers += 1; },
    // A minimal stand-in for parseNetworkKpiManifest: encodes the requested
    // scenario index into the geometry path it returns, so the assertions
    // below can tell which scenario's geometry actually got loaded.
    parseNetworkKpiManifest: (_raw: unknown, _url: string | null, scenarioIndex: number) => ({
      geometry: { sections: `scenario-${scenarioIndex}` },
    }),
    loadNetworkKpiGeometry: async (source: unknown, geometrySources: { sections: string }) => {
      calls.loadNetworkKpiGeometry.push({ source, sections: geometrySources.sections });
      return geometryBySection[geometrySources.sections] ?? { sections: geometrySources.sections };
    },
  };
  runInNewContext(script, context);
  return { context, calls } as {
    context: {
      settings: { scenarioA: number; scenarioB: number; mode: string };
      geometry: { sections: string } | null;
      geometryB: { sections: string } | null;
      setScenarioComparisonSettings: (next: Record<string, unknown>) => void;
    };
    calls: typeof calls;
  };
}

test("switching scenarioA reloads only side A's geometry, leaving side B untouched", async () => {
  const { context, calls } = harness();
  context.setScenarioComparisonSettings({ scenarioA: 1 });
  // reloadScenarioGeometry is fire-and-forget (void) from inside
  // setScenarioComparisonSettings; let its microtasks settle.
  await flush();

  assert.deepEqual(calls.loadNetworkKpiGeometry.map((c) => c.sections), ["scenario-1"]);
  assert.equal(context.geometry?.sections, "scenario-1");
  // BUG #277 regression guard: side B's geometry must be left exactly as it
  // was — only the side whose scenario index actually changed reloads.
  assert.equal(context.geometryB?.sections, "geometry-B-initial");
  assert.equal(calls.readCurrent, 1, "the KPI numbers must still re-query as before");
});

test("switching scenarioB reloads only side B's geometry", async () => {
  const { context, calls } = harness();
  context.setScenarioComparisonSettings({ scenarioB: 2 });
  await flush();

  assert.deepEqual(calls.loadNetworkKpiGeometry.map((c) => c.sections), ["scenario-2"]);
  assert.equal(context.geometryB?.sections, "scenario-2");
  assert.equal(context.geometry?.sections, "geometry-A-initial");
});

test("switching both sides at once reloads both geometries", async () => {
  const { context, calls } = harness();
  context.setScenarioComparisonSettings({ scenarioA: 3, scenarioB: 4 });
  await flush();

  const sections = calls.loadNetworkKpiGeometry.map((c) => c.sections).sort();
  assert.deepEqual(sections, ["scenario-3", "scenario-4"]);
  assert.equal(context.geometry?.sections, "scenario-3");
  assert.equal(context.geometryB?.sections, "scenario-4");
});

test("a settings change unrelated to scenario selection never touches geometry", async () => {
  const { context, calls } = harness();
  context.setScenarioComparisonSettings({ opacity: 0.5 } as never);
  await flush();

  assert.equal(calls.loadNetworkKpiGeometry.length, 0);
  assert.equal(context.geometry?.sections, "geometry-A-initial");
  assert.equal(context.geometryB?.sections, "geometry-B-initial");
});
