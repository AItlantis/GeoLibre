import assert from "node:assert/strict";
import test from "node:test";
import { commitEmissionsLoadIfCurrent, readEmissionsRowsFromProvider } from "./emissions-h3-provider-reader";
import { loadEmissionsH3Geometry } from "./emissions-h3-geometry";
import type { NetworkKpiPackageSource } from "./network-kpi-data";
import type { TestudoDatasetProvider } from "./testudo-dataset-provider";

test("Emissions H3 loads section geometry without touching unrelated network layers", async () => {
  const requested: string[] = [];
  const source: NetworkKpiPackageSource = {
    baseUrl: null,
    read: async (path) => {
      requested.push(path);
      return new TextEncoder().encode(JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { section_id: 7 }, geometry: null }],
      })).buffer;
    },
  };

  const geometry = await loadEmissionsH3Geometry(source, "geometry/sections.geojson");

  assert.deepEqual(requested, ["geometry/sections.geojson"]);
  assert.equal(geometry.sections.features.length, 1);
});

test("Environment pins a selected scenario replication even when another replication is the default", async () => {
  const requests: Array<{ dataset: string; did?: number }> = [];
  const metadata = {
    schemaVersion: "geolibre.package.v1", format: "parquet" as const, resultsPath: null, catalogPath: null,
    scenarios: [{ scid: 1, replications: [{ did: 10 }, { did: 11 }] }],
    datasets: [{ id: "MISECT", table: "MISECT", format: "parquet" as const, paths: [], dids: [10, 11], scenarioIds: [1], rowLimit: 100, warnings: [] },
      { id: "MISECTIEM", table: "MISECTIEM", format: "parquet" as const, paths: [], dids: [10, 11], scenarioIds: [1], rowLimit: 100, warnings: [] }],
    dataContracts: { emissions: { tables: ["MISECTIEM"] } }, warnings: [],
  };
  const provider: TestudoDatasetProvider = {
    metadata,
    describe: () => metadata,
    readSimulationInfo: async () => ({ rows: [], columns: [], rowCount: 0, truncated: false, source: "test", dataset: "SIM_INFO", did: 11, scenarioId: 1, warnings: [] }),
    close: async () => {},
    query: async request => {
      requests.push({ dataset: request.dataset, did: request.did });
      if (request.dataset === "MISECT" && request.distinct) return { rows: [{ ent: 0 }, { ent: 1 }], columns: ["ent"], rowCount: 2, truncated: false, source: "test", dataset: "MISECT", did: request.did ?? null, scenarioId: request.scenarioId ?? null, warnings: [] };
      if (request.dataset === "MISECT" && request.columns?.includes("flow")) return { rows: [{ oid: 3355, eid: 1, sid: 0, ent: 0, flow: 492, speed: 30, nstops: 0 }], columns: request.columns, rowCount: 1, truncated: false, source: "test", dataset: "MISECT", did: request.did ?? null, scenarioId: request.scenarioId ?? null, warnings: [] };
      if (request.dataset === "MISECTIEM" && !request.columns) return { rows: [], columns: ["oid", "eid", "sid", "ent", "CO2"], rowCount: 0, truncated: false, source: "test", dataset: "MISECTIEM", did: request.did ?? null, scenarioId: request.scenarioId ?? null, warnings: [] };
      if (request.dataset === "MISECTIEM") return { rows: [{ oid: 3361, eid: 1, sid: 0, ent: 0, CO2: 3 }], columns: request.columns ?? [], rowCount: 1, truncated: false, source: "test", dataset: "MISECTIEM", did: request.did ?? null, scenarioId: request.scenarioId ?? null, warnings: [] };
      throw new Error(`Unexpected dataset ${request.dataset}`);
    },
  };
  const loaded = await readEmissionsRowsFromProvider(provider, 11, 0, 1, true);
  assert.equal(loaded.did, 11);
  assert.ok(loaded.hasEmissions);
  assert.ok(requests.filter(row => row.did !== undefined).every(row => row.did === 11), "all DID-scoped reads stay on the selected emissions replication");
});

test("Environment rejects an explicit replication outside the selected scenario before querying fallbacks", async () => {
  const metadata = { schemaVersion: "geolibre.package.v1", format: "parquet" as const, resultsPath: null, catalogPath: null,
    scenarios: [{ scid: 1, replications: [{ did: 10 }, { did: 11 }] }], datasets: [], dataContracts: {}, warnings: [] };
  let queryCount = 0;
  const provider: TestudoDatasetProvider = { metadata, describe: () => metadata, readSimulationInfo: async () => { throw new Error("unexpected"); }, close: async () => {},
    query: async () => { queryCount++; throw new Error("unexpected query"); } };
  await assert.rejects(readEmissionsRowsFromProvider(provider, 99, 0, 1, true), /not declared for scenario 1/);
  assert.equal(queryCount, 0, "no other replication is queried after an explicit invalid selection");
});

test("stale emissions scenario and replaced-package reads cannot commit", async () => {
  let token = 1;
  const packageA = {};
  const packageB = {};
  const commits: string[] = [];
  let finishA!: (value: string) => void;
  const readA = new Promise<string>(resolve => { finishA = resolve; });
  const selectionA = readA.then(value => commitEmissionsLoadIfCurrent(value, 1, token, packageA, packageB,
    result => commits.push(result)));
  token = 2;
  const currentB = commitEmissionsLoadIfCurrent("B", 2, token, packageB, packageB, value => commits.push(value));
  finishA("stale A");
  await selectionA;
  assert.equal(currentB, true);
  assert.deepEqual(commits, ["B"], "the old scenario/package read cannot overwrite the current committed identity");
});
