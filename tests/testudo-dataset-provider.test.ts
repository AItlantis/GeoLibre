import assert from "node:assert/strict";
import test from "node:test";
import {
  openTestudoDatasetProvider,
  type TestudoDuckDbRuntime,
  type TestudoSqliteRuntime,
} from "../packages/plugins/src/plugins/testudo-dataset-provider";

function sourceFor(files: Record<string, Uint8Array>) {
  return {
    baseUrl: null,
    async read(path: string): Promise<ArrayBuffer> {
      const bytes = files[path];
      if (!bytes) throw new Error(`missing fixture ${path}`);
      return bytes.slice().buffer;
    },
  };
}

function arrow(rows: Record<string, unknown>[]) {
  return { toArray: () => rows.map((row) => ({ ...row })) };
}

test("metadata exposes scenario identity, catalog partitions, and contract warnings", async () => {
  const catalog = new TextEncoder().encode(JSON.stringify({ files: [
    { table: "MISECT", did: 7, partition: "did=7", path: "results/MISECT/did=7/part-0.parquet" },
  ] }));
  const duckdb: TestudoDuckDbRuntime = {
    async registerParquet() { return "fixture.parquet"; },
    async connect() { return { query: async () => arrow([]), close() {} }; },
    async dropFiles() {},
  };
  const provider = await openTestudoDatasetProvider({
    source: sourceFor({ "catalog.json": catalog }),
    manifest: {
      schemaVersion: "geolibre.package.v1",
      scenarios: [{ scid: 10, name: "Baseline", replications: [{ did: 7, didname: "rep-7" }] }],
      environment: { results_catalog_relative: "catalog.json", results_format: "parquet" },
      results: { dataContracts: { emissions: { status: "partial", warnings: ["coverage incomplete"] } } },
    },
    duckdb,
  });

  assert.equal(provider.metadata.scenarios[0]?.scid, 10);
  assert.equal(provider.metadata.scenarios[0]?.replications[0]?.did, 7);
  assert.equal(provider.metadata.datasets[0]?.table, "MISECT");
  assert.deepEqual(provider.metadata.datasets[0]?.dids, [7]);
  assert.ok(provider.metadata.warnings.some((warning) => warning.includes("coverage incomplete")));
  await provider.close();
});

test("Parquet queries use the selected scenario replication and close registered files", async () => {
  let registered = 0;
  let dropped: string[] = [];
  let sql = "";
  const duckdb: TestudoDuckDbRuntime = {
    async registerParquet(_source, entry) { registered += 1; assert.equal(entry.did, 7); return "fixture.parquet"; },
    async connect() { return { query: async (value: string) => { sql = value; return arrow([{ did: 7, oid: 42 }]); }, close() {} }; },
    async dropFiles(handles) { dropped = handles; },
  };
  const provider = await openTestudoDatasetProvider({
    source: sourceFor({ "catalog.json": new TextEncoder().encode(JSON.stringify({ files: [
      { table: "MISECT", did: 7, path: "results/MISECT/did=7/part-0.parquet" },
      { table: "MISECT", did: 8, path: "results/MISECT/did=8/part-0.parquet" },
    ] })) }),
    manifest: { scenarios: [{ scid: 10, replications: [{ did: 7 }] }], environment: { results_catalog_relative: "catalog.json" } },
    duckdb,
    limits: { defaultRows: 5, maxRows: 5 },
  });

  const result = await provider.query({ dataset: "MISECT", scenarioId: 10, columns: ["did", "oid"], limit: 2 });
  assert.equal(result.source, "parquet");
  assert.deepEqual(result.rows, [{ did: 7, oid: 42 }]);
  assert.equal(result.did, 7, "a single-replication scenario resolves to its did");
  assert.ok(result.arrow, "Parquet results preserve the native Arrow result");
  assert.equal(registered, 1);
  assert.match(sql, /LIMIT 3/);

  await provider.close();
  assert.deepEqual(dropped, ["fixture.parquet"]);
  await provider.close();
  assert.deepEqual(dropped, ["fixture.parquet"]);
});

test("SQLite/sql.js fallback is explicit and lazy for packages without sidecars", async () => {
  let opened = 0;
  let closed = 0;
  const sqlite: TestudoSqliteRuntime = {
    open() {
      opened += 1;
      return {
        exec(sql: string) { assert.match(sql, /FROM "MISECT"/); return [{ columns: ["did", "ent"], values: [[4, 2]] }]; },
        close() { closed += 1; },
      };
    },
  };
  const provider = await openTestudoDatasetProvider({
    source: sourceFor({ "results.sqlite.gz": new Uint8Array([1, 2, 3]) }),
    manifest: { scenarios: [{ scid: 4, replications: [{ did: 4 }] }], results: { path: "results.sqlite.gz", format: "sqlite-gzip", dataContracts: { warnings: ["coverage unknown"] } } },
    sqlite,
  });

  assert.equal(opened, 0, "opening a provider must not inflate SQLite before the first fallback query");
  const result = await provider.query({ dataset: "MISECT", did: 4, limit: 5 });
  assert.equal(opened, 1);
  assert.equal(result.source, "sqlite");
  assert.deepEqual(result.rows, [{ did: 4, ent: 2 }]);
  assert.ok(result.warnings.some((warning) => warning.includes("SQLite/sql.js compatibility fallback")));
  await provider.close();
  assert.equal(closed, 1);
});

test("query limits and identifiers are bounded", async () => {
  const provider = await openTestudoDatasetProvider({
    source: sourceFor({}),
    manifest: { results: { path: "results.sqlite" } },
    sqlite: { open: () => ({ exec: () => [], close() {} }) },
    limits: { defaultRows: 2, maxRows: 3, maxColumns: 2, maxFilters: 1 },
  });
  await assert.rejects(() => provider.query({ dataset: "MISECT;DROP TABLE" }));
  await assert.rejects(() => provider.query({ dataset: "MISECT", limit: 4 }));
  await assert.rejects(() => provider.query({ dataset: "MISECT", columns: ["a", "b", "c"] }));
  await provider.close();
});
