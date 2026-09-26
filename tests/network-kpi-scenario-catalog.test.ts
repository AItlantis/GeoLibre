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

function extract(source: string, names: string[]): string {
  return names.map((name) => {
    const match = source.match(new RegExp(
      `^(?:export )?function ${name}\\([\\s\\S]*?\\n}`, "m",
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
    /^((?:export )?(?:async )?function [A-Za-z0-9_]+)\(([\s\S]*?)\)(\s*:\s*[\s\S]*?)?\s*\{/gm,
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
