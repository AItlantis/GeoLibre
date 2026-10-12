import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Bug #277 (network-kpi mode): switching the scenario selector reloads
// geometry but the results database opens on the package-wide default
// results catalog every time, because parseNetworkKpiManifest() prefers
// `pkg.resultsCatalogRelative` (the geolibre.package.v1 envelope's single,
// scenario-agnostic catalog pointer, parsed once from the manifest root by
// parseGeolibrePackage()) over the per-scenario `environment` block, which
// *is* resolved from the correct animations[scenarioIndex] scope a few lines
// above. So every scenario's adoptScenario() ends up pointed at the exact
// same results.catalog.json, and the KPI numbers never change.
//
// This test extracts the real, unmodified `parseNetworkKpiManifest` (plus its
// pure helpers) and the real `parseGeolibrePackage`/`attachGeolibrePackage`
// straight out of source with regex + VM, the same technique
// network-kpi-restore.test.ts uses to avoid pulling in the browser-only
// sql.js/proj4/DuckDB-WASM import graph those modules sit inside.

const dataSource = readFileSync(new URL(
  "../packages/plugins/src/plugins/network-kpi-data.ts", import.meta.url,
), "utf8");
const packageLoaderSource = readFileSync(new URL(
  "../packages/plugins/src/plugins/geolibre-package-loader.ts", import.meta.url,
), "utf8");
const kpiControllerSource = readFileSync(new URL(
  "../packages/plugins/src/plugins/maplibre-network-kpi.ts", import.meta.url,
), "utf8");
const parquetDataSource = readFileSync(new URL(
  "../packages/plugins/src/plugins/network-kpi-parquet-data.ts", import.meta.url,
), "utf8");

function extract(source: string, names: string[]): string {
  return names.map((name) => {
    const match = source.match(new RegExp(
      `^(?:export )?(?:async )?function ${name}(?:<[^>]*>)?\\([\\s\\S]*?\\n}`, "m",
    ));
    assert.ok(match, `Missing production function ${name}`);
    return match[0].replace(/^export /, "");
  }).join("\n");
}

const envelopeKeyMatch = packageLoaderSource.match(/^const envelopeKey = .*$/m);
const recordMatch = packageLoaderSource.match(/^const record = [\s\S]*?;$/m);
assert.ok(envelopeKeyMatch, "Missing production const envelopeKey");
assert.ok(recordMatch, "Missing production const record");
const packageLoaderFns = `${envelopeKeyMatch[0]}\n${recordMatch[0]}\n${extract(packageLoaderSource, [
  "parseGeolibrePackage",
  "attachGeolibrePackage",
  "getGeolibrePackage",
])}`;
const manifestFns = extract(dataSource, [
  "safeNumber",
  "resolveNetworkKpiScenarioReplication",
  "networkKpiDidCandidates",
  "resolveNetworkKpiReplicationDid",
  "queryNetworkKpiFallbackDimension",
  "commitNetworkKpiReadIfCurrent",
  "assertNetworkKpiExplicitDid",
  "assertNetworkKpiExplicitData",
  "readNetworkKpiScenarioResults",
  "isCurrentNetworkKpiRead",
  "resolvePath",
  "parseNetworkKpiManifest",
  "parseManifestRamps",
]);

// node:module's stripTypeScriptTypes mishandles a multi-line function
// signature whose closing `)` and return-type annotation sit on their own
// line — as parseNetworkKpiManifest's does (`\n): NetworkKpiManifest {`). It
// silently strips the entire parameter list along with the type instead of
// just the type, leaving `function parseNetworkKpiManifest(\n) {`. Collapsing
// each extracted function's signature onto one line before stripping avoids
// that failure mode without touching the production source.
function collapseSignatures(source: string): string {
  return source.replace(
    /^((?:export )?(?:async )?function [A-Za-z0-9_]+(?:<[^>]*>)?)\(([\s\S]*?)\)(\s*:\s*[\s\S]*?)?\s*\{/gm,
    (_all, head: string, params: string, returnType = "") =>
      `${head}(${params.replace(/\s+/g, " ").trim()})${returnType.replace(/\s+/g, " ")} {`,
  );
}

const script = stripTypeScriptTypes(collapseSignatures(`${packageLoaderFns}\n${manifestFns}`));

function harness() {
  // A bare vm context has no global constructors of its own — resolvePath()'s
  // `new URL(...)` needs the host's URL passed in explicitly, or it throws a
  // ReferenceError that resolvePath's own try/catch silently swallows into a
  // `null` return, which would otherwise misreport every case here as the
  // bug this test targets.
  const context: Record<string, unknown> = { URL };
  runInNewContext(script, context);
  return context as {
    attachGeolibrePackage: (legacy: unknown, packageRaw: unknown) => unknown;
    parseNetworkKpiManifest: (raw: unknown, manifestUrl: string | null, scenarioIndex?: number) => {
      resultsCatalogRelative: string | null;
    };
    resolveNetworkKpiScenarioReplication: (scenarios: Array<{ scid: string | number; replications?: Array<{ did: number; didname?: string }> }>, selectedScid: string | number | null, preferredDid?: number | null) => { did: number; replications: Array<{ did: number; didname?: string }> } | null;
    networkKpiDidCandidates: (requestedDid: number | null | undefined, declaredDids: number[]) => number[];
    resolveNetworkKpiReplicationDid: (replications: Array<{ did: number }>, requestedDid: number | null, scenarioScid: string | number) => number;
    queryNetworkKpiFallbackDimension: <T>(requestedDid: number | null | undefined, declaredDids: number[], query: (did: number | null) => Promise<T[]>) => Promise<{ did: number | null; rows: T[] }>;
    commitNetworkKpiReadIfCurrent: <T>(read: Promise<T>, isCurrent: () => boolean, commit: (value: T) => void) => Promise<T | undefined>;
    assertNetworkKpiExplicitDid: (actualDid: number | null, requestedDid: number | null | undefined) => void;
    assertNetworkKpiExplicitData: (requestedDid: number | null | undefined, rowCount: number, stage: string) => void;
    readNetworkKpiScenarioResults: <T extends { did: number | null }>(database: { read(options: { interval?: number; did?: number | null }): Promise<T> }, scenarios: Array<{ scid: string | number; replications?: Array<{ did: number; didname?: string }> }>, selectedScid: string | number | null, preferredDid: number | null, options: { interval?: number }) => Promise<{ results: T; replication: { did: number; replications: Array<{ did: number; didname?: string }> } | null }>;
    isCurrentNetworkKpiRead: (token: number, currentToken: number, capturedDatabase: object, activeDatabase: object | null) => boolean;
  };
}

/** A minimal geolibre.package.v1-style manifest with two distinct scenarios,
 *  each declaring its own per-scenario `environment.results_catalog_relative`,
 *  wrapped the way `attachGeolibrePackage` really wraps a legacy manifest —
 *  with a single package-root `results.catalogPath`, exactly as a real
 *  exported package does today. */
function buildTwoScenarioManifest(ctx: ReturnType<typeof harness>, options: { packageLevelCatalog: boolean }) {
  const legacy = {
    animations: [
      { name: "Base", environment: { results_catalog_relative: "scenarios/0/results/catalog.json" } },
      { name: "Alternative", environment: { results_catalog_relative: "scenarios/1/results/catalog.json" } },
    ],
  };
  const packageRaw = {
    scenarios: [
      { scid: 0, replications: [{ did: 100 }] },
      { scid: 1, replications: [{ did: 200 }] },
    ],
    results: options.packageLevelCatalog
      ? { sidecars: { parquet: { catalogPath: "results/catalog.json" } } }
      : {},
    environment: {},
  };
  return ctx.attachGeolibrePackage(legacy, packageRaw);
}

test("GH #277: a package-level results catalog no longer pins every scenario to the same catalog path", () => {
  const ctx = harness();
  // A real geolibre.package.v1 export declares BOTH a package-level fallback
  // catalog (`results.sidecars.parquet.catalogPath`, parsed once from the
  // manifest root) AND a per-scenario `environment.results_catalog_relative`
  // under each `animations[i]` entry. Before the fix, parseNetworkKpiManifest
  // preferred the package-level value unconditionally, so every scenario
  // opened the exact same results catalog and switching the scenario
  // selector never changed the displayed KPI numbers.
  const manifest = buildTwoScenarioManifest(ctx, { packageLevelCatalog: true });

  const scenario0 = ctx.parseNetworkKpiManifest(manifest, "https://host/manifest.json", 0);
  const scenario1 = ctx.parseNetworkKpiManifest(manifest, "https://host/manifest.json", 1);

  assert.match(scenario0.resultsCatalogRelative ?? "", /scenarios\/0\//);
  assert.match(scenario1.resultsCatalogRelative ?? "", /scenarios\/1\//);
  assert.notEqual(
    scenario0.resultsCatalogRelative,
    scenario1.resultsCatalogRelative,
    "each scenario must resolve its own results catalog, not the package-wide default",
  );
});

test("per-scenario results catalog is honored when no package-level catalog is declared", () => {
  const ctx = harness();
  const manifest = buildTwoScenarioManifest(ctx, { packageLevelCatalog: false });

  const scenario0 = ctx.parseNetworkKpiManifest(manifest, "https://host/manifest.json", 0);
  const scenario1 = ctx.parseNetworkKpiManifest(manifest, "https://host/manifest.json", 1);

  assert.match(scenario0.resultsCatalogRelative ?? "", /scenarios\/0\//);
  assert.match(scenario1.resultsCatalogRelative ?? "", /scenarios\/1\//);
  assert.notEqual(scenario0.resultsCatalogRelative, scenario1.resultsCatalogRelative);
});

test("the package-level catalog remains the fallback when a scenario declares no override", () => {
  const ctx = harness();
  const legacy = {
    animations: [
      { name: "Base" }, // No per-scenario `environment` block at all.
    ],
  };
  const packageRaw = {
    scenarios: [{ scid: 0, replications: [{ did: 100 }] }],
    results: { sidecars: { parquet: { catalogPath: "results/catalog.json" } } },
    environment: {},
  };
  const manifest = ctx.attachGeolibrePackage(legacy, packageRaw);

  const scenario0 = ctx.parseNetworkKpiManifest(manifest, "https://host/manifest.json", 0);
  assert.equal(scenario0.resultsCatalogRelative, "https://host/results/catalog.json");
});

test("Results scenario switches read OID 3355 from the DID resolved for each stable SCID", async () => {
  const ctx = harness();
  const packageScenarios = [
    { scid: 45001, replications: [{ did: 49342 }] },
    { scid: 49414, replications: [{ did: 49418 }] },
    { scid: 45002, replications: [{ did: 49468 }] },
  ];
  const rowsByDid = new Map([[49342, 450], [49418, 492], [49468, 450]]);
  const calls: number[] = [];
  const database = { read: async ({ did }: { interval?: number; did?: number | null }) => {
    const actualDid = did ?? -1;
    calls.push(actualDid);
    return { did: actualDid, oid3355Flow: rowsByDid.get(actualDid) };
  } };
  const switches = [];
  for (const scid of [45001, 49414, 45002, 45001]) {
    const selected = await ctx.readNetworkKpiScenarioResults(database, packageScenarios, scid, null, { interval: 0 });
    switches.push({ scid, did: selected.results.did, flow: selected.results.oid3355Flow });
  }
  assert.deepEqual(calls, [49342, 49418, 49468, 49342], "the production scenario reader passes an explicit scenario DID on every selection");
  assert.deepEqual(switches, [
    { scid: 45001, did: 49342, flow: 450 },
    { scid: 49414, did: 49418, flow: 492 },
    { scid: 45002, did: 49468, flow: 450 },
    { scid: 45001, did: 49342, flow: 450 },
  ]);
  assert.notEqual(switches[0].flow, switches[1].flow);
  assert.equal(switches[0].flow, switches[3].flow);
});

test("scenario metadata order and multiple replications resolve by SCID and selected scenario", () => {
  const ctx = harness();
  const packageScenarios = [
    { scid: "B", replications: [{ did: 20, didname: "B first" }, { did: 21, didname: "B second" }] },
    { scid: "A", replications: [{ did: 10 }] },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.resolveNetworkKpiScenarioReplication(packageScenarios, "A"))), { did: 10, replications: [{ did: 10 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.resolveNetworkKpiScenarioReplication(packageScenarios, "B"))), { did: 20, replications: [{ did: 20, didname: "B first" }, { did: 21, didname: "B second" }] });
  assert.equal(ctx.resolveNetworkKpiScenarioReplication(packageScenarios, "B", 21)?.did, 21);
  assert.throws(() => ctx.resolveNetworkKpiScenarioReplication(packageScenarios, "missing"), /no matching package scenario metadata/);
  assert.throws(() => ctx.resolveNetworkKpiScenarioReplication([{ scid: "empty", replications: [] }], "empty"), /declares no usable replication/);
  assert.equal(ctx.resolveNetworkKpiReplicationDid([{ did: 20 }, { did: 21 }], null, "B"), 20,
    "null replication selection resolves to the active scenario default");
  assert.throws(() => ctx.resolveNetworkKpiReplicationDid([{ did: 20 }], 10, "B"), /not declared for Network KPI scenario B/);
  const replicationSetter = kpiControllerSource.match(/export function setNetworkKpiReplication\([\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(replicationSetter.indexOf("resolveNetworkKpiReplicationDid") < replicationSetter.indexOf("settings = { ...settings, did: requestedDid }"),
    "foreign replication validation must happen before settings are changed");
});

test("an explicit DID never falls through to another dataset replication", () => {
  const ctx = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.networkKpiDidCandidates(49418, [49342, 49418, 49468]))), [49418]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.networkKpiDidCandidates(null, [49342, 49418]))), [49342, 49418]);
  assert.throws(() => ctx.assertNetworkKpiExplicitDid(49342, 49418), /explicitly selected did 49418/);
  assert.throws(() => ctx.assertNetworkKpiExplicitData(49418, 0, "MISECT"), /no MISECT data for explicitly selected did 49418/);
  assert.doesNotThrow(() => ctx.assertNetworkKpiExplicitData(49418, 1, "MISECT"));
  assert.match(parquetDataSource, /queryNetworkKpiFallbackDimension\(options\.did, declaredDids/,
    "the SQLite compatibility fallback queries only the explicitly selected DID");
  assert.match(parquetDataSource, /const dimensionResult = await queryNetworkKpiFallbackDimension\(options\.did, declaredDids/);
  assert.match(parquetDataSource, /assertNetworkKpiExplicitData\(options\.did, sectionRows\.length, "MISECT interval"\)/);
  assert.match(parquetDataSource, /assertNetworkKpiExplicitData\(options\.did, result\.length, "section time-series"\)/);
});

test("fallback provider does not query another DID after an explicit replication is missing", async () => {
  const ctx = harness();
  const queried: Array<number | null> = [];
  await assert.rejects(ctx.queryNetworkKpiFallbackDimension(49418, [49342, 49418, 49468], async did => {
    queried.push(did);
    return [];
  }), /no MISECT data for explicitly selected did 49418/);
  assert.deepEqual(queried, [49418]);
  assert.match(parquetDataSource, /queryNetworkKpiFallbackDimension\(options\.did, declaredDids/,
    "the fallback provider uses the tested exact-DID query loop");
});

test("requested Results identity is observable before the scenario DB read resolves", async () => {
  const ctx = harness();
  const scenarios = [{ scid: 49414, replications: [{ did: 49418 }] }];
  let resolveRead!: (value: { did: number | null; interval: number; sections: Map<number, unknown> }) => void;
  let request: { scid: string | number | null; did: number | null; interval: number } | null = null;
  const database = { read: () => new Promise<{ did: number | null; interval: number; sections: Map<number, unknown> }>(resolve => { resolveRead = resolve; }) };
  const pending = ctx.readNetworkKpiScenarioResults(database, scenarios, 49414, null, { interval: 7 }, identity => { request = identity; });
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { scid: 49414, did: 49418, interval: 7 });
  const getterScript = stripTypeScriptTypes(collapseSignatures(extract(kpiControllerSource, ["getNetworkKpiLiveDiagnostics"])));
  const getterContext: Record<string, unknown> = {
    status: { loading: true, error: null },
    requestedKpiIdentity: request,
    committedKpiIdentity: { scid: "previous", did: 49342, interval: 0 },
    liveIdentityState: (identity: unknown) => identity,
  };
  runInNewContext(getterScript, getterContext);
  const snapshot = (getterContext.getNetworkKpiLiveDiagnostics as () => { loading: boolean; requested: { scid: number; did: number; interval: number }; loaded: { scid: string } })();
  assert.equal(snapshot.loading, true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.requested)), { scid: 49414, did: 49418, interval: 7 });
  assert.equal(snapshot.loaded.scid, "previous", "the committed identity stays separate while the new request is pending");
  resolveRead({ did: 49418, interval: 7, sections: new Map() });
  const completed = await pending;
  assert.equal(completed.results.did, 49418);
});

test("delayed scenario, interval, replication, and replaced-package reads cannot commit stale values", async () => {
  const ctx = harness();
  const packageA = {};
  const packageB = {};
  const committed: string[] = [];
  const deferred = () => {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>(done => { resolve = done; });
    return { promise, resolve };
  };
  // Scenario replacement uses the package/load token; interval and replication
  // use the read token; package replacement also changes database identity.
  const scenarioRead = deferred();
  let activeLoadToken = 1;
  const scenarioCommit = ctx.commitNetworkKpiReadIfCurrent(scenarioRead.promise, () => activeLoadToken === 1, value => committed.push(value));
  activeLoadToken = 2;
  scenarioRead.resolve("stale");
  assert.equal(await scenarioCommit, undefined);
  const intervalRead = deferred();
  let intervalReadToken = 4;
  const intervalCommit = ctx.commitNetworkKpiReadIfCurrent(intervalRead.promise,
    () => ctx.isCurrentNetworkKpiRead(4, intervalReadToken, packageA, packageA), value => committed.push(value));
  intervalReadToken = 5;
  intervalRead.resolve("stale");
  assert.equal(await intervalCommit, undefined);
  const replicationRead = deferred();
  let replicationReadToken = 7;
  const replicationCommit = ctx.commitNetworkKpiReadIfCurrent(replicationRead.promise,
    () => ctx.isCurrentNetworkKpiRead(7, replicationReadToken, packageA, packageA), value => committed.push(value));
  replicationReadToken = 8;
  replicationRead.resolve("stale");
  assert.equal(await replicationCommit, undefined);
  const replacedRead = deferred();
  let activeDatabase = packageA;
  const replacedCommit = ctx.commitNetworkKpiReadIfCurrent(replacedRead.promise,
    () => ctx.isCurrentNetworkKpiRead(5, 5, packageA, activeDatabase), value => committed.push(value));
  activeDatabase = packageB;
  replacedRead.resolve("stale");
  assert.equal(await replacedCommit, undefined);
  assert.deepEqual(committed, []);
  const current = deferred();
  const currentCommit = ctx.commitNetworkKpiReadIfCurrent(current.promise,
    () => ctx.isCurrentNetworkKpiRead(5, 5, packageA, packageA), value => committed.push(value));
  current.resolve("current");
  assert.equal(await currentCommit, "current");
  assert.deepEqual(committed, ["current"]);
  assert.equal((kpiControllerSource.match(/isCurrentNetworkKpiRead\(/g) ?? []).length, 3,
    "scenario, interval, and explicit replication commits use the tested current-read fence");
  assert.match(kpiControllerSource, /if \(token !== loadToken\) return;/,
    "scenario adoption checks the package/scenario load generation before publication");
});
