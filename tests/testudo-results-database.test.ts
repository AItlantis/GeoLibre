import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { decompressResultsZstd, discoverResultsSchema, type TestudoResultsSqlDatabase, type TestudoResultsSqlFactory } from "../packages/plugins/src/plugins/testudo-results-database";
import { createTestudoTimeSeriesProviders } from "../packages/plugins/src/plugins/testudo-time-series-providers";
import type { TestudoFeatureContext, TestudoMapHandle, TestudoPlaybackState } from "../packages/plugins/src/shared/testudo-feature-session";

type SqlDatabase = TestudoResultsSqlDatabase & { export(): Uint8Array };
type SqlApi = TestudoResultsSqlFactory & { Database: new (bytes?: Uint8Array) => SqlDatabase };

async function sqlApi(): Promise<SqlApi> {
  const moduleName = "sql.js";
  const loaded = await import(moduleName) as { default?: (options: { locateFile: () => string }) => Promise<SqlApi> };
  const initialize = loaded.default ?? loaded as unknown as (options: { locateFile: () => string }) => Promise<SqlApi>;
  return initialize({ locateFile: () => resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm") });
}

function databaseBytes(SQL: SqlApi, includeKpiTable = true): Uint8Array {
  const db = new SQL.Database();
  if (includeKpiTable) {
    db.exec("CREATE TABLE MISECT (did INTEGER, oid INTEGER, eid TEXT, sid INTEGER, ent INTEGER, speed REAL, flow REAL, density REAL)");
    db.exec("INSERT INTO MISECT VALUES (11, 100, 'section-100', 1, 0, 40, 12, 3), (11, 100, 'section-100', 1, 1, 30, 10, 2), (22, 100, 'section-100', 1, 0, 20, 8, 2), (22, 100, 'section-100', 1, 1, 10, 6, 1)");
    db.exec("CREATE TABLE MIPTPO (did INTEGER, oid INTEGER, eid TEXT, sid INTEGER, ent INTEGER, CO2 REAL, NOx REAL)");
  } else db.exec("CREATE TABLE UNKNOWN_RESULTS (id INTEGER)");
  const bytes = db.export();
  db.close();
  return bytes;
}

async function zstd(bytes: Uint8Array): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  assert.equal(typeof zlib.zstdCompressSync, "function", "Node zstdCompressSync is required for this generated in-memory fixture");
  return new Uint8Array(zlib.zstdCompressSync(bytes));
}

function bytes(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function fakeMap() {
  const sources = new Map<string, { data: unknown; setData(data: unknown): void }>();
  const layers = new Map<string, Record<string, unknown>>();
  const layouts = new Map<string, unknown>();
  const map: TestudoMapHandle = {
    getSource: (id) => sources.get(id),
    addSource(id, source) { sources.set(id, { data: source.data, setData(data) { this.data = data; } }); },
    removeSource: (id) => { sources.delete(id); },
    getLayer: (id) => layers.get(id),
    addLayer(layer) { layers.set(String(layer.id), layer); },
    removeLayer: (id) => { layers.delete(id); },
    setLayoutProperty(id, name, value) { layouts.set(`${id}:${name}`, value); },
  };
  return { map, sources, layers, layouts };
}

function context(id: string, generation: number): TestudoFeatureContext {
  return { tviewId: id, packageId: "fixture", versionId: "v1", pluginId: null, generation };
}

const rootManifest = {
  metadata: { dt: 0.8, n_ticks: 2 },
  environment: { sqlite_relative: "results.sqlite.zst" },
  geometry: { sections: "geometry/sections.geojson" },
  scenarios: [
    { scid: 1, scname: "Baseline", replications: [{ did: 11 }] },
    { scid: 2, scname: "Alternative", replications: [{ did: 22 }] },
  ],
};
const sections = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { section_id: 100 } }] };

test("zstd decode discovers producer tables and enforces the expanded-size ceiling", async () => {
  const SQL = await sqlApi();
  const compressed = await zstd(databaseBytes(SQL));
  const decoded = await decompressResultsZstd(compressed);
  const opened = new SQL.Database(decoded);
  const schema = discoverResultsSchema(opened);
  assert.equal(schema.tables.has("MISECT"), true);
  assert.deepEqual([...schema.columns.get("MISECT")!].sort(), ["density", "did", "eid", "ent", "flow", "oid", "sid", "speed"]);
  opened.close();
  await assert.rejects(decompressResultsZstd(compressed, undefined, 32), /size limit/);
});

test("results provider opens on activation, follows playback, renders owned section layers, and shares then closes its generation DB", async () => {
  const SQL = await sqlApi();
  const compressed = await zstd(databaseBytes(SQL));
  let artifactReads = 0; let opens = 0; let closes = 0;
  const loadSqlJs = async () => ({ Database: class extends SQL.Database {
    constructor(data?: Uint8Array) { super(data); opens += 1; }
    close() { closes += 1; super.close(); }
  } });
  const artifacts: Record<string, ArrayBuffer> = {
    "manifest.json": bytes(rootManifest),
    "geolibre/package.json": bytes({}),
    "geometry/sections.geojson": bytes(sections),
    "results.sqlite.zst": compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
  };
  const fetchArtifact = async (path: string) => {
    if (path === "results.sqlite.zst") artifactReads += 1;
    if (!artifacts[path]) throw new Error(`Missing fixture artifact: ${path}`);
    return artifacts[path]!;
  };
  const providers = createTestudoTimeSeriesProviders(loadSqlJs);
  const map = fakeMap();
  const network = await providers.networkKpi.open({ packageId: "fixture", versionId: "v1", label: "Fixture", artifactEndpoint: "/proxy", capabilities: [] },
    context("results-view", 1), () => {}, fetchArtifact, map.map);
  assert.equal(artifactReads, 0, "the SQLite artifact must remain unloaded until the capability activates");
  await network.onActivate?.();
  assert.equal(network.capabilities?.[0]?.available, true);
  assert.equal(artifactReads, 1);
  assert.equal(opens, 1);
  assert.deepEqual(network.getPlaybackValues?.().values, [{ oid: "100", value: 40 }]);
  const layerId = "testudo-results-view-1-network-kpi-network-kpi-sections";
  assert.equal(map.sources.has(layerId), true);
  const initial = map.sources.get(layerId)?.data as { features: Array<{ properties: Record<string, unknown> }> };
  assert.equal(initial.features[0]?.properties.__testudoKpiValue, 40);
  const playback: TestudoPlaybackState = { available: true, loading: false, playing: false, tick: 1, maxTick: 1, speed: 1, dt: 0.8, loop: false };
  await network.onPlaybackTick?.("results-view", 1, playback);
  assert.deepEqual(network.getPlaybackValues?.().values, [{ oid: "100", value: 30 }]);

  const comparison = await providers.scenarioComparison.open({ packageId: "fixture", versionId: "v1", label: "Fixture", artifactEndpoint: "/proxy", capabilities: [] },
    context("results-view", 1), () => {}, fetchArtifact, map.map);
  await comparison.onActivate?.();
  await comparison.onPlaybackTick?.("results-view", 1, playback);
  assert.equal(comparison.capabilities?.[0]?.available, true);
  assert.equal(opens, 1, "both capability sessions share the database for one TView generation");
  const comparisonValues = comparison.getComparisonAtTick?.(["1", "2"]);
  assert.deepEqual(comparisonValues?.values, [[{ oid: "100", value: 30 }], [{ oid: "100", value: 10 }]]);
  await network.dispose?.();
  assert.equal(closes, 0, "the shared database stays open while another capability holds a lease");
  await comparison.dispose?.();
  assert.equal(closes, 1);
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
});

test("H3 emissions and missing KPI tables degrade to honest unavailable capabilities", async () => {
  const SQL = await sqlApi();
  const h3Providers = createTestudoTimeSeriesProviders(async () => SQL);
  const compressed = await zstd(databaseBytes(SQL));
  const artifacts: Record<string, ArrayBuffer> = {
    "manifest.json": bytes(rootManifest), "geolibre/package.json": bytes({}),
    "results.sqlite.zst": compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
  };
  const fetchArtifact = async (path: string) => artifacts[path]!;
  const env = await h3Providers.emissionsH3.open({ packageId: "fixture", versionId: "v1", label: "Fixture", artifactEndpoint: "/proxy", capabilities: [] },
    context("environment-view", 3), () => {}, fetchArtifact);
  await env.onActivate?.();
  assert.equal(env.capabilities?.[0]?.available, false);
  assert.match(env.capabilities?.[0]?.reason ?? "", /no producer-declared H3 emissions table/);
  await env.dispose?.();

  const missingBytes = await zstd(databaseBytes(SQL, false));
  artifacts["results.sqlite.zst"] = missingBytes.buffer.slice(missingBytes.byteOffset, missingBytes.byteOffset + missingBytes.byteLength) as ArrayBuffer;
  const network = await h3Providers.networkKpi.open({ packageId: "fixture", versionId: "v1", label: "Fixture", artifactEndpoint: "/proxy", capabilities: [] },
    context("missing-view", 4), () => {}, fetchArtifact);
  await network.onActivate?.();
  assert.equal(network.capabilities?.[0]?.available, false);
  assert.match(network.capabilities?.[0]?.reason ?? "", /MISECT is missing/);
  await network.dispose?.();
});

test("zstd decode observes an abort signal", async () => {
  const raw = new Uint8Array(600_000);
  const random = (await import("node:crypto")).randomBytes(raw.byteLength);
  raw.set(random);
  const compressed = await zstd(raw);
  const abort = new AbortController();
  const pending = decompressResultsZstd(compressed, abort.signal, 1_000_000);
  setTimeout(() => abort.abort(), 0);
  await assert.rejects(pending, /aborted/);
});
