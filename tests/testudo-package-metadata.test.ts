import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGeolibrePackage, resolveEnvironmentScenarioCoverage, verifyEnvironmentScenarioCandidates } from "../packages/plugins/src/plugins/geolibre-package-loader";

test("package metadata preserves declared results view modes, alternatives, comparison pairs and time axis", () => {
  const pkg = parseGeolibrePackage({ results: {
    viewModes: {
      results: { table: "MISECT", column: "flow", unit: "veh/h", style: { type: "ramp", id: "flow" }, domains: { sid: { min: 0, max: 4 }, intervalSeconds: 600 }, alternates: [{ table: "MISECT", column: "speed", unit: "km/h", style: { type: "extrusion", max: 90 } }] },
      comparison: { table: "MISECT", column: "flow_delta", unit: "veh/h", style: { type: "ramp" }, domains: { ent: { min: 0, max: 1 } }, scenarioDidPair: [{ scid: 10, did: 100 }, { scid: 20, did: 200 }] },
    },
    timeAxis: { fromTime: 28800, intervalMs: 600000, intervals: 1 },
  } });
  assert.equal(pkg.viewModes.results?.alternates?.[0].style.type, "extrusion");
  assert.deepEqual(pkg.viewModes.comparison?.scenarioDidPair, [{ scid: 10, did: 100 }, { scid: 20, did: 200 }]);
  assert.deepEqual(pkg.timeAxis, { fromTime: 28800, intervalMs: 600000, intervals: 1 });
});

test("package metadata drops malformed view modes and invalid time axes", () => {
  const pkg = parseGeolibrePackage({ results: { viewModes: { results: { table: "MISECT", column: "flow", unit: "veh/h", style: { type: "other" } } }, timeAxis: { fromTime: "later", intervalMs: 0, intervals: -1 } } });
  assert.deepEqual(pkg.viewModes, {});
  assert.equal(pkg.timeAxis, null);
});

test("Environment coverage exact-joins emissions DIDs to SCID replications regardless of scenario order", () => {
  const pkg = parseGeolibrePackage({
    scenarios: [
      { scid: 49464, replications: [{ did: 49468 }] },
      { scid: 49414, replications: [{ did: 49418 }] },
      { scid: 49320, replications: [{ did: 49342 }] },
    ],
    results: { dataContracts: { emissions: { actual_dids: [49468, 49342], actual_dids_truncated: false } } },
  });
  const result = resolveEnvironmentScenarioCoverage(pkg);
  assert.deepEqual(result.byScid, {
    "49464": { status: "available", dids: [49468] },
    "49414": { status: "unavailable", dids: [] },
    "49320": { status: "available", dids: [49342] },
  });
  assert.equal(result.packageEligible, true);
});

test("explicit Environment scenarioDidPair takes precedence and requires declared SCID/DID membership", () => {
  const raw = {
    scenarios: [{ scid: 1, replications: [{ did: 10 }, { did: 11 }] }, { scid: 2, replications: [{ did: 20 }] }],
    results: {
      dataContracts: { emissions: { actual_dids: [20], actual_dids_truncated: false } },
      viewModes: { environment: { table: "MISECT", column: "co2", unit: "kg", style: { type: "ramp" }, scenarioDidPair: [{ scid: 1, did: 11 }] } },
    },
  };
  const pkg = parseGeolibrePackage(raw);
  assert.deepEqual(resolveEnvironmentScenarioCoverage(pkg, raw).byScid, {
    "1": { status: "available", dids: [11] },
    "2": { status: "unavailable", dids: [] },
  });
  const invalidRaw = structuredClone(raw);
  invalidRaw.results.viewModes.environment.scenarioDidPair = [{ scid: 1, did: 99 }];
  assert.deepEqual(resolveEnvironmentScenarioCoverage(parseGeolibrePackage(invalidRaw), invalidRaw).byScid, {
    "1": { status: "unavailable", dids: [] },
    "2": { status: "available", dids: [20] },
  }, "a foreign explicit pair falls back to the complete exact-DID inventory");
});

test("empty and malformed explicit pairs fall back to a complete valid inventory", () => {
  const base = {
    scenarios: [{ scid: 1, replications: [{ did: 10 }] }, { scid: 2, replications: [{ did: 20 }] }],
    results: { dataContracts: { emissions: { actual_dids: [20, 10], actual_dids_truncated: false } } },
  };
  for (const pairs of [[], null, [{ scid: "bad", did: 10 }], [{ scid: 1, did: 99 }]]) {
    const raw = structuredClone(base) as typeof base & { results: { viewModes?: unknown } };
    raw.results = { ...raw.results, viewModes: { environment: { table: "MISECT", column: "co2", unit: "kg", style: { type: "ramp" }, scenarioDidPair: pairs } } };
    const pkg = parseGeolibrePackage(raw);
    assert.deepEqual(resolveEnvironmentScenarioCoverage(pkg, raw).byScid, {
      "1": { status: "available", dids: [10] },
      "2": { status: "available", dids: [20] },
    }, `invalid explicit pairs ${JSON.stringify(pairs)} use the exact complete inventory`);
  }
});

test("selecting an unknown scenario while Environment is active probes safe reps and never leaves stale rows", async () => {
  let selectedMode = "environment";
  let selectedScenario = "A";
  let rows = [{ scid: 1, did: 10 }];
  const attempts: number[] = [];
  const coverage = { status: "unknown" as const, dids: [], candidateDids: [20, 21] };
  selectedScenario = "B";
  const loaded = await verifyEnvironmentScenarioCandidates(coverage.candidateDids, async did => {
    attempts.push(did);
    rows = []; // Each strict scenario read clears the prior scenario before awaiting data.
    if (did === 20) throw new Error("candidate has no usable rows");
    rows = [{ scid: 2, did }];
    return rows[0];
  }, () => { rows = []; }, () => {
    assert.equal(selectedMode, "environment");
    assert.equal(selectedScenario, "B");
  });
  assert.deepEqual(attempts, [20, 21]);
  assert.deepEqual(loaded, { did: 21, value: { scid: 2, did: 21 } });
  assert.deepEqual(rows, [{ scid: 2, did: 21 }]);
  assert.equal(selectedMode, "environment", "unknown coverage preserves active Environment eligibility");

  rows = [{ scid: 2, did: 21 }];
  const failed = await verifyEnvironmentScenarioCandidates([22], async () => { rows = []; throw new Error("empty interval set"); }, () => { rows = []; });
  assert.equal(failed, null, "a failed verification remains unknown rather than unavailable");
  assert.deepEqual(rows, [], "failed verification cannot leave old scenario rows visible");
});

test("Environment inventory handles duplicate, invalid, truncated and missing declarations conservatively", () => {
  const scenarios = [{ scid: 1, replications: [{ did: 10 }, { did: 11 }] }, { scid: 2, replications: [{ did: 20 }] }];
  const coverage = (emissions: unknown) => resolveEnvironmentScenarioCoverage(parseGeolibrePackage({ scenarios, results: { dataContracts: { emissions } } }));
  assert.deepEqual(coverage({ actual_dids: [10, 10, 11], actual_dids_truncated: false }).byScid["1"], { status: "available", dids: [10, 11] });
  assert.deepEqual(coverage({ actual_dids: [10, -1], actual_dids_truncated: false }).byScid["1"], { status: "unknown", dids: [], candidateDids: [10, 11] });
  assert.deepEqual(coverage({ actual_dids: [11], actual_dids_truncated: true }).byScid["1"], { status: "available", dids: [11] }, "listed DIDs remain positive when inventory is truncated");
  assert.deepEqual(coverage({ actual_dids: [11], actual_dids_truncated: true }).byScid["2"], { status: "unknown", dids: [], candidateDids: [20] }, "unlisted DIDs stay unknown when inventory is truncated");
  assert.deepEqual(coverage({ actual_dids: [999], actual_dids_truncated: false }).byScid["1"], { status: "unavailable", dids: [] });
  assert.deepEqual(coverage({ actual_dids: [999] }).byScid["1"], { status: "unknown", dids: [], candidateDids: [10, 11] }, "missing completeness flag cannot prove absence");
  assert.deepEqual(coverage({ actual_dids_truncated: false }).byScid["1"], { status: "unknown", dids: [], candidateDids: [10, 11] }, "missing inventory is unknown");
});

test("Environment coverage deduplicates valid nonnegative safe integer DIDs and supports multiple replications", () => {
  const pkg = parseGeolibrePackage({ scenarios: [{ scid: 1, replications: [{ did: 10 }, { did: 11 }, { did: 11 }, { did: -1 }, { did: 1.5 }] }],
    results: { dataContracts: { emissions: { actual_dids: [11, 10, 11, Number.MAX_SAFE_INTEGER + 1], actual_dids_truncated: false } } } });
  assert.deepEqual(resolveEnvironmentScenarioCoverage(pkg).byScid["1"], { status: "unknown", dids: [], candidateDids: [10, 11] }, "invalid inventory values make the inventory unknown");
  const valid = parseGeolibrePackage({ scenarios: [{ scid: 1, replications: [{ did: 10 }, { did: 11 }, { did: 11 }, { did: -1 }, { did: 1.5 }] }],
    results: { dataContracts: { emissions: { actual_dids: [11, 10, 11], actual_dids_truncated: false } } } });
  assert.deepEqual(resolveEnvironmentScenarioCoverage(valid).byScid["1"], { status: "available", dids: [10, 11] });
});
