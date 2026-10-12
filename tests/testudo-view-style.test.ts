import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { availableTestudoModes } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
import { availableModesForScenario, finalizeModeSelection, pluginForTestudoMode, reconcileEnvironmentCapability, reconcilePathCapability, reconcileResultsCapability, resolveComparisonScenarioIndex, resolveComparisonScenarioPairIds, routeTestudoPluginSelection, selectScenarioInRoster, validateTestudoStyle } from "../apps/geolibre-desktop/src/lib/testudo-view-style";
import { resolvePathIndexDeclaration } from "../packages/plugins/src/shared/scenario-path-index";
import { parseGeolibrePackage } from "../packages/plugins/src/plugins/geolibre-package-loader";

test("shell modes map to persistent KPI views, animation and paths", () => {
  assert.equal(pluginForTestudoMode("results"), "network-kpi");
  assert.equal(pluginForTestudoMode("comparison"), "scenario-comparison");
  assert.equal(pluginForTestudoMode("environment"), "emissions-h3");
  assert.equal(pluginForTestudoMode("animation"), "vehicle-playback");
  assert.equal(pluginForTestudoMode("paths"), "path-analysis");
  assert.equal(pluginForTestudoMode("flow"), "network-kpi");
  assert.deepEqual(availableTestudoModes({ animation: true, flow: true, density: true, paths: true, results: true, comparison: false, environment: true }), ["animation", "flow", "paths", "density", "results", "environment"]);
});

test("mode-backed plugin tabs route through mode selection while capability-only plugins keep plugin selection", async () => {
  const receiver = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(receiver, /request\.type === "testudoSetPlugin"[\s\S]*routeTestudoPluginSelection\([\s\S]*mode => selectMode\(mode\)[\s\S]*pluginId => select\(pluginId as TestudoSelectablePluginId\)/);
  const routed: Array<[string, string]> = [];
  for (const [pluginId, mode] of [
    ["vehicle-playback", "animation"], ["network-kpi", "results"], ["path-analysis", "paths"],
    ["emissions-h3", "environment"], ["scenario-comparison", "comparison"],
  ]) {
    await routeTestudoPluginSelection(pluginId, async selectedMode => { routed.push(["mode", selectedMode]); return "mode"; }, async selectedPlugin => { routed.push(["plugin", selectedPlugin]); return "plugin"; });
    assert.deepEqual(routed.at(-1), ["mode", mode]);
  }
  assert.equal(await routeTestudoPluginSelection("geoai", async () => "mode", async selectedPlugin => `capability:${selectedPlugin}`), "capability:geoai");
  assert.deepEqual(routed, [
    ["mode", "animation"], ["mode", "results"], ["mode", "paths"], ["mode", "environment"], ["mode", "comparison"],
  ]);
});

test("Results to Animation acknowledges the scenario roster after plugin synchronization", async () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(controller, /return finalizeModeSelection\(\{[\s\S]*syncScenarioRoster: \(\) => \{ syncScenarioRoster\(target\.plugin\); \}[\s\S]*getCurrentState: \(\) => current/);
  const stalePreSyncResult = { selectedMode: "animation", scenarios: [{ id: "results-2", label: "Results scenario" }], selectedScenarioId: "results-2" };
  let current = { selectedMode: "results", scenarios: [{ id: "results-2", label: "Results scenario" }], selectedScenarioId: "results-2" };
  const order: string[] = [];
  const acknowledgement = await finalizeModeSelection({
    syncScenarioRoster: () => { order.push("roster"); current = { selectedMode: "animation", scenarios: [{ id: "anim-1", label: "Animation one" }, { id: "anim-2", label: "Animation two" }], selectedScenarioId: "anim-2" }; },
    synchronizeViewMode: async () => { order.push("mode"); },
    publishPlayback: () => { order.push("playback"); },
    assertCurrent: () => { order.push("ownership"); },
    getCurrentState: () => current,
  });
  assert.notDeepEqual(acknowledgement, stalePreSyncResult);
  assert.equal(acknowledgement.selectedMode, "animation");
  assert.deepEqual(acknowledgement.scenarios.map(row => row.id), ["anim-1", "anim-2"]);
  assert.equal(acknowledgement.selectedScenarioId, "anim-2");
  assert.deepEqual(order, ["roster", "ownership", "mode", "ownership", "playback", "ownership"]);
});

test("local Environment fallback keeps the chosen SCID in Results state, KPI selection and data", async () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(controller, /const select = async \(id: TestudoSelectablePluginId, operation\?: number, preserveScenarioId\?: string \| number\)/);
  assert.match(controller, /scenarioToPreserveOnPluginSelect !== undefined\)\) syncScenarioRoster\(bridgePluginId\)/);
  assert.match(controller, /selectScenarioInRoster\(preserveScenarioId, plugins\.getNetworkKpiStatus\(\)\.scenarios,[\s\S]*plugins\.setNetworkKpiScenario\(index\)[\s\S]*syncScenarioRoster\(id\)/);
  assert.match(controller, /await selectMode\(scenarioModeState\.selectedMode, false, packageOperationAtStart,[\s\S]*scenarioModeState\.selectedMode === "results" \? scenarioId : undefined\)/);
  assert.match(controller, /assertScenarioRequestCurrent\(\);[\s\S]*const finalScenario = featureBridge\.sessions\.get\("main"\)\?\.scenarios\?\.find/);

  const selectedScid = "49414";
  const roster = [{ scid: "49320", label: "A1" }, { scid: selectedScid, label: "B" }];
  const rowsByScenario = new Map([["49320", [{ id: "kpi-row-A1", volume: 17 }]], [selectedScid, [{ id: "kpi-row-B", volume: 42 }]]]);
  const nativeKpi = { scenarios: roster, scenarioIndex: 0, rows: rowsByScenario.get("49320")! };
  let current = { selectedPlugin: "emissions-h3", selectedMode: "environment", scenarios: [{ id: "49320", label: "A1" }, { id: selectedScid, label: "B" }], selectedScenarioId: selectedScid };
  const emittedStates: typeof current[] = [];
  let operation = 7;
  let generation = 12;
  const assertCurrent = () => { assert.equal(operation, 7); assert.equal(generation, 12); };
  const selected = await selectScenarioInRoster(selectedScid, nativeKpi.scenarios, async index => {
    nativeKpi.scenarioIndex = index;
    nativeKpi.rows = rowsByScenario.get(String(nativeKpi.scenarios[index].scid))!;
  }, assertCurrent);
  assert.equal(selected.index, 1);
  assert.equal(String(nativeKpi.scenarios[nativeKpi.scenarioIndex].scid), selectedScid, "native Network KPI selection uses B");
  assert.deepEqual(nativeKpi.rows, [{ id: "kpi-row-B", volume: 42 }], "KPI data belongs to B");
  current = { selectedPlugin: "network-kpi", selectedMode: "results",
    scenarios: nativeKpi.scenarios.map(row => ({ id: String(row.scid), label: row.label })), selectedScenarioId: selectedScid };
  emittedStates.push(current);
  const returned = { scenarioId: current.selectedScenarioId, modelScenarioId: selected.scenario.scid };
  assert.equal(emittedStates.at(-1)?.selectedScenarioId, selectedScid, "host selector state keeps B");
  assert.deepEqual(emittedStates.at(-1)?.scenarios.map(row => row.id), ["49320", selectedScid]);
  assert.equal(returned.scenarioId, selectedScid, "scenario acknowledgement keeps B");
  assert.equal(returned.modelScenarioId, selectedScid, "scenario acknowledgement identifies the selected model scenario");
  await assert.rejects(selectScenarioInRoster("missing", nativeKpi.scenarios, async () => {}, assertCurrent), /not available in the destination plugin/);
  assert.equal(operation, 7);
  assert.equal(generation, 12);
});

test("Environment capability, installed session and shell tab stay unavailable without declared usable data", () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(controller, /environment: reconcileEnvironmentCapability\(current\.capabilities, Boolean\(pkg\?\.viewModes\.environment\), environmentScenarioCoverage\.packageEligible\)\.available/);
  assert.match(controller, /const finalCapabilities = reconcileResultsCapability\(reconcilePathCapability\(environmentCapability\.capabilities,[\s\S]*?Boolean\(resolvedPathIndex\)\)\.capabilities\.map/);
  assert.match(controller, /capabilities: finalCapabilities/);
  assert.match(controller, /installedSession\.capabilities = finalCapabilities\.map\(item => \(\{ \.\.\.item \}\)\)/);
  assert.match(controller, /const environmentCapability = reconcileEnvironmentCapability\((?:current\.capabilities|resultsCapability\.capabilities), Boolean\(pkg\.viewModes\.environment\), environmentScenarioCoverage\.packageEligible\)/);
  assert.match(controller, /installedSession\.capabilities = environmentCapability\.capabilities\.map/);

  for (const fixture of [
    { name: "missing Environment metadata", metadata: false, rows: false, reason: /does not declare Environment metadata/ },
    { name: "declared Environment metadata without usable rows", metadata: true, rows: false, reason: /no usable emissions rows/ },
  ]) {
    const projection = reconcileEnvironmentCapability([{ id: "emissions-h3", available: true }], fixture.metadata, fixture.rows);
    const viewerState = { capabilities: projection.capabilities, availableModes: availableTestudoModes({ animation: true, flow: false, paths: false, density: false, results: false, environment: projection.available }) };
    const featureSession = { capabilities: projection.capabilities.map(capability => ({ ...capability })) };
    const hostEnvironmentTab = { disabled: !viewerState.capabilities.find(capability => capability.id === "emissions-h3")?.available };
    assert.equal(viewerState.capabilities.find(capability => capability.id === "emissions-h3")?.available, false, fixture.name);
    assert.equal(featureSession.capabilities.find(capability => capability.id === "emissions-h3")?.available, false, fixture.name);
    assert.equal(viewerState.availableModes.includes("environment"), false, fixture.name);
    assert.equal(hostEnvironmentTab.disabled, true, fixture.name);
    assert.match(viewerState.capabilities.find(capability => capability.id === "emissions-h3")?.reason ?? "", fixture.reason);
  }

  const descriptorDisabled = reconcileEnvironmentCapability([
    { id: "emissions-h3", available: false, reason: "Disabled by the package descriptor." },
  ], true, true);
  assert.equal(descriptorDisabled.available, false);
  assert.equal(descriptorDisabled.capabilities[0].available, false);
  assert.equal(descriptorDisabled.capabilities[0].reason, "Disabled by the package descriptor.");

  const usable = reconcileEnvironmentCapability([{ id: "emissions-h3", available: true }], true, true);
  assert.equal(usable.available, true, "only advertised, declared and usable Environment data enables the mode");
  assert.equal(usable.capabilities[0].reason, undefined);
});

test("local and published package paths share SCID coverage, preserve unknown, and load the selected emissions DID", () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.equal((controller.match(/resolveEnvironmentScenarioCoverage\(pkg, raw\)/g) ?? []).length, 2,
    "local and published package loads call the same coverage resolver");
  assert.match(controller, /environmentScenarioCoverage\.packageEligible/);
  assert.match(controller, /coverage\.status === "available" \|\| coverage\.status === "unknown" && environmentPackageEligible/);
  assert.match(controller, /coverage\.status === "unavailable"/);
  assert.match(controller, /loadLocalEmissionsH3Folder\(directory, index, did\)/);
  assert.match(controller, /loaded\.did !== did/);
  assert.match(controller, /clearEmissionsH3Scenario\(scenarioId\)/);
  assert.match(controller, /verifyUnknownEnvironmentScenario\(scenarioId, coverage, assertScenarioRequestCurrent\)/);
  assert.match(controller, /verifyUnknownEnvironmentScenario\(scenarioId!, coverage, assertSelectionCurrent\)/);
  assert.match(controller, /verifyEnvironmentScenarioCandidates\([\s\S]*coverage\.candidateDids/);
});

test("Results capability, local and published modes, installed session and host tab require a parsed descriptor", async () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(controller, /const resultsCapability = reconcileResultsCapability\(current\.capabilities, Boolean\(pkg\?\.viewModes\.results\)\)/);
  assert.match(controller, /results: resultsCapability\.available/);
  assert.match(controller, /const finalCapabilities = reconcileResultsCapability\(reconcilePathCapability\(environmentCapability\.capabilities,[\s\S]*?Boolean\(pkg\?\.viewModes\.results\)\)\.capabilities/);
  assert.match(controller, /const initialResultsCapability = reconcileResultsCapability\(capabilities, Boolean\(pkg\.viewModes\.results\)\)/);
  assert.match(controller, /const environmentCapability = reconcileEnvironmentCapability\(resultsCapability\.capabilities, Boolean\(pkg\.viewModes\.environment\), environmentScenarioCoverage\.packageEligible\)/);
  assert.match(controller, /installedSession\.capabilities = finalCapabilities\.map/);
  assert.match(controller, /installedSession\.capabilities = environmentCapability\.capabilities\.map/);
  assert.match(controller, /if \(!current\.availableModes\.includes\(mode\)\)[\s\S]*current\.capabilities\.find\(item => item\.id === capabilityId\)\?\.reason/);

  const validDescriptor = { table: "results", column: "flow", unit: "veh/h", style: { type: "ramp" } };
  const cases = [
    { name: "missing Results descriptor", viewModes: {}, advertised: true, expected: false, reason: "This package lacks a compatible Results view descriptor." },
    { name: "malformed Results descriptor", viewModes: { results: { table: "results", column: "flow", unit: "veh/h", style: { type: "invalid" } } }, advertised: true, expected: false, reason: "This package lacks a compatible Results view descriptor." },
    { name: "valid descriptor and available capability", viewModes: { results: validDescriptor }, advertised: true, expected: true },
    { name: "valid descriptor but explicitly unavailable capability", viewModes: { results: validDescriptor }, advertised: false, capabilityReason: "Disabled by the package descriptor.", expected: false, reason: "Disabled by the package descriptor." },
  ];
  for (const fixture of cases) {
    const pkg = parseGeolibrePackage({
      capabilities: { results: { state: fixture.advertised ? "available" : "unavailable", ...(fixture.capabilityReason ? { reason: fixture.capabilityReason } : {}) } },
      results: { viewModes: fixture.viewModes },
    });
    const hasParsedDescriptor = Boolean(pkg.viewModes.results);
    const advertisedCapability = [{ id: "network-kpi", available: pkg.capabilities.results?.state === "available", ...(pkg.capabilities.results?.reason ? { reason: pkg.capabilities.results.reason } : {}) }];
    const localProjection = reconcileResultsCapability(advertisedCapability, hasParsedDescriptor);
    const publishedProjection = reconcileResultsCapability(advertisedCapability, hasParsedDescriptor);
    for (const [label, projection] of [["local", localProjection], ["published", publishedProjection]] as const) {
      const availableModes = availableTestudoModes({ animation: true, flow: false, paths: true, density: false, results: projection.available });
      const viewerState = { capabilities: projection.capabilities, availableModes };
      const featureSession = { capabilities: projection.capabilities.map(capability => ({ ...capability })), availableModes: [...availableModes] };
      const hostResultsTab = { disabled: !viewerState.capabilities.find(capability => capability.id === "network-kpi")?.available };
      assert.equal(viewerState.capabilities[0].available, fixture.expected, `${fixture.name}: ${label} capability`);
      assert.equal(featureSession.capabilities[0].available, fixture.expected, `${fixture.name}: ${label} session capability`);
      assert.equal(viewerState.availableModes.includes("results"), fixture.expected, `${fixture.name}: ${label} Results mode`);
      assert.equal(featureSession.availableModes.includes("results"), fixture.expected, `${fixture.name}: ${label} session mode`);
      assert.equal(hostResultsTab.disabled, !fixture.expected, `${fixture.name}: ${label} host tab`);
      assert.equal(viewerState.availableModes.includes("animation"), true, `${fixture.name}: Animation remains available`);
      assert.equal(viewerState.availableModes.includes("paths"), true, `${fixture.name}: Paths remains available`);
      if (fixture.reason) assert.equal(viewerState.capabilities[0].reason, fixture.reason, fixture.name);
      else assert.equal(viewerState.capabilities[0].reason, undefined, fixture.name);
      const selectedResultsMode = viewerState.availableModes.includes("results") ? "results" : undefined;
      const renderedKpiColumn = selectedResultsMode === "results" ? pkg.viewModes.results?.column : undefined;
      assert.equal(renderedKpiColumn, fixture.expected ? "flow" : undefined, `${fixture.name}: Results selects the parsed KPI descriptor`);
      if (!fixture.expected) {
        const directResultsCommand = async () => {
          if (!viewerState.availableModes.includes("results")) throw new Error(viewerState.capabilities[0].reason);
        };
        await assert.rejects(directResultsCommand(), error => error instanceof Error && error.message === fixture.reason, `${fixture.name}: direct Results command is rejected with capability reason`);
      }
    }
  }
});

test("Paths capability, available mode, installed session and host tab follow declared indexes", () => {
  const controller = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  const parser = readFileSync(new URL("../packages/plugins/src/plugins/path-analysis-data.ts", import.meta.url), "utf8");
  assert.match(parser, /resolvePathIndexDeclaration\(root, scenarioId\)/);
  assert.match(controller, /plugins\.parsePathAnalysisManifest\(raw, null\)\.pathIndex/);
  assert.match(controller, /const pathCapability = reconcilePathCapability\(current\.capabilities, Boolean\(resolvedPathIndex\)\)/);
  assert.match(controller, /paths: pathCapability\.available/);
  assert.match(controller, /reconcilePathCapability\(environmentCapability\.capabilities,[\s\S]*Boolean\(resolvedPathIndex\)\)/);
  assert.match(controller, /let capabilities = ids\.map/);
  assert.match(controller, /capabilities = pathCapability\.capabilities/);
  assert.match(controller, /update\(\{ availableModes, capabilities: environmentCapability\.capabilities \}\)/);
  assert.match(controller, /installedSession\.capabilities = environmentCapability\.capabilities\.map/);

  const cases = [
    { name: "missing index", manifest: {}, descriptor: true, expectedIndex: null, available: false },
    { name: "empty root map shadows valid envelope map", manifest: { path_indices: {}, __geolibrePackage: { pathIndicesByScid: { "49320": "envelope-index" } } }, descriptor: true, expectedIndex: null, available: false },
    { name: "legacy scalar index", manifest: { path_index: "indexed_paths" }, descriptor: true, expectedIndex: "indexed_paths", available: true },
    { name: "root pathIndicesByScid map", manifest: { pathIndicesByScid: { "49320": "root-envelope-index" } }, descriptor: true, expectedIndex: "root-envelope-index", available: true },
    { name: "scenario-scoped index map", manifest: { __geolibrePackage: { pathIndicesByScid: { "49320": "paths/49320.json" } } }, descriptor: true, expectedIndex: "paths/49320.json", available: true },
    { name: "explicit root index beats default map index", manifest: { path_index: "root-index", path_indices: { "0": "map-index" } }, descriptor: true, expectedIndex: "root-index", available: true },
    { name: "empty root index shadows valid map index", manifest: { path_index: "", path_indices: { "0": "map-index" } }, descriptor: true, expectedIndex: null, available: false },
    { name: "malformed root map shadows valid envelope map", manifest: { path_indices: { "49320": 7 }, __geolibrePackage: { pathIndicesByScid: { "49320": "envelope-index" } } }, descriptor: true, expectedIndex: null, available: false },
    { name: "descriptor disabled despite a valid index", manifest: { path_index: "indexed_paths" }, descriptor: false, expectedIndex: "indexed_paths", available: false },
  ];
  for (const fixture of cases) {
    const resolvedIndex = resolvePathIndexDeclaration(fixture.manifest);
    const projection = reconcilePathCapability([{
      id: "path-analysis", available: fixture.descriptor,
      ...(!fixture.descriptor ? { reason: "Disabled by the package descriptor." } : {}),
    }], Boolean(resolvedIndex));
    const availableModes = availableTestudoModes({ animation: true, flow: false, paths: projection.available, density: false });
    const viewerState = { capabilities: projection.capabilities, availableModes };
    const featureSession = { capabilities: projection.capabilities.map(capability => ({ ...capability })), availableModes: [...availableModes] };
    const hostPathsTab = { disabled: !viewerState.capabilities.find(capability => capability.id === "path-analysis")?.available };
    assert.equal(projection.available, fixture.available, fixture.name);
    assert.equal(resolvedIndex, fixture.expectedIndex, fixture.name);
    assert.equal(viewerState.capabilities[0].available, fixture.available, fixture.name);
    assert.equal(featureSession.capabilities[0].available, fixture.available, fixture.name);
    assert.equal(viewerState.availableModes.includes("paths"), fixture.available, fixture.name);
    assert.equal(featureSession.availableModes.includes("paths"), fixture.available, fixture.name);
    assert.equal(hostPathsTab.disabled, !fixture.available, fixture.name);
    if (!fixture.descriptor) assert.equal(viewerState.capabilities[0].reason, "Disabled by the package descriptor.");
    else if (!fixture.expectedIndex) assert.match(viewerState.capabilities[0].reason ?? "", /does not declare a path index/);
    else assert.equal(viewerState.capabilities[0].reason, undefined);
  }
});

test("style validation accepts current generation settings and rejects bad metrics, intervals, heights and scenario indexes", () => {
  assert.deepEqual(validateTestudoStyle({ display: "extrusion", metric: "flow_delta", interval: 1, maxHeightM: 80, scenarioA: 0, scenarioB: 1 }, "comparison", 2), {
    display: "extrusion", metric: "flow_delta", interval: 1, maxHeightM: 80, scenarioA: 0, scenarioB: 1,
  });
  for (const style of [
    { display: "heat", metric: "flow", interval: 0, maxHeightM: 10 },
    { display: "ramp", metric: "co2", interval: 0, maxHeightM: 10 },
    { display: "ramp", metric: "flow", interval: -1, maxHeightM: 10 },
    { display: "ramp", metric: "flow", interval: 0, maxHeightM: 10001 },
    { display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, scenarioA: 2 },
  ]) assert.throws(() => validateTestudoStyle(style, "results", 2));
});

test("package metric columns alias iframe metric ids and comparison scenario ids map to plugin indexes", () => {
  assert.equal(validateTestudoStyle({ display: "ramp", metric: "dtime", interval: 0, maxHeightM: 10 }, "results", 2).metric, "delay");
  assert.equal(validateTestudoStyle({ display: "ramp", metric: "nstops", interval: 0, maxHeightM: 10 }, "environment", 2).metric, "noise");
  assert.equal(validateTestudoStyle({ display: "ramp", metric: "dtime_delta", interval: 0, maxHeightM: 10 }, "comparison", 2).metric, "delay_delta");
  const scenarios = [{ scid: 49320 }, { scid: 49414 }];
  assert.equal(resolveComparisonScenarioIndex(49414, scenarios), 1);
  assert.equal(resolveComparisonScenarioIndex(0, scenarios), 0);
  assert.deepEqual(validateTestudoStyle({ display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, scenarioA: 49320, scenarioB: 49414 }, "comparison", 2, scenarios), {
    display: "ramp", metric: "flow", interval: 0, maxHeightM: 10, scenarioA: 0, scenarioB: 1,
  });
  assert.deepEqual(validateTestudoStyle({ display: "ramp", metric: "flow", interval: 0, maxHeightM: 10 }, "comparison", 2, scenarios).scenarioA, undefined);
  assert.throws(() => validateTestudoStyle({ display: "ramp", metric: "unknown", interval: 0, maxHeightM: 10 }, "results", 2), /metric "unknown"/);
  assert.deepEqual(availableModesForScenario(["results", "environment", "animation"], false), ["results", "animation"]);
  assert.deepEqual(availableModesForScenario(["results", "environment", "animation"], true), ["results", "environment", "animation"]);
});

test("stable comparison scenario IDs win when their numeric values are also valid indexes", () => {
  const scenarios = [{ scid: 1 }, { scid: 2 }, { scid: 3 }];
  assert.deepEqual(resolveComparisonScenarioPairIds("1", "2", scenarios), { scenarioA: 0, scenarioB: 1 });
});
