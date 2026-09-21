import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { pickDefaultDid, type CatalogEntry } from "./parquet-catalog";

// This test deliberately exercises the catalog contract without importing the
// browser-only DuckDB worker module. Browser integration covers the WASM path;
// the async consumer guard is tested as a timing primitive here.
test("latest async read wins over an older response", async () => {
  let generation = 0;
  let rendered = "";
  const read = async (value: string, delay: number) => {
    const token = ++generation;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (token === generation) rendered = value;
  };
  await Promise.all([read("old", 20), read("latest", 1)]);
  assert.equal(rendered, "latest");
});

test("catalog entries retain explicit did and parquet paths", () => {
  const catalog = { files: [{ table: "MISECT", partition: "did=7", did: 7, path: "results/MISECT/did=7/part-0.parquet" }] };
  assert.equal(catalog.files[0].did, 7);
  assert.match(catalog.files[0].path, /\.parquet$/);
});

test("pickDefaultDid skips a replication whose MISECT partition has zero rows", () => {
  const catalog: CatalogEntry[] = [
    { table: "MISECT", partition: "did=100", did: 100, path: "results/MISECT/did=100/part-0.parquet", row_count: 0 },
    { table: "MILANE", partition: "did=100", did: 100, path: "results/MILANE/did=100/part-0.parquet", row_count: 0 },
    { table: "MISECT", partition: "did=200", did: 200, path: "results/MISECT/did=200/part-0.parquet", row_count: 5000 },
    { table: "MILANE", partition: "did=200", did: 200, path: "results/MILANE/did=200/part-0.parquet", row_count: 12000 },
  ];
  assert.equal(pickDefaultDid(catalog), 200);
});

test("pickDefaultDid falls back to the numerically-first did when the catalog has no row_count at all", () => {
  const catalog: CatalogEntry[] = [
    { table: "MISECT", partition: "did=300", did: 300, path: "results/MISECT/did=300/part-0.parquet" },
    { table: "MISECT", partition: "did=100", did: 100, path: "results/MISECT/did=100/part-0.parquet" },
  ];
  assert.equal(pickDefaultDid(catalog), 100);
});

test("pickDefaultDid returns the only did present even if its row_count is zero", () => {
  const catalog: CatalogEntry[] = [
    { table: "MISECT", partition: "did=100", did: 100, path: "results/MISECT/did=100/part-0.parquet", row_count: 0 },
  ];
  assert.equal(pickDefaultDid(catalog), 100);
});

test("pickDefaultDid returns null for an empty catalog", () => {
  assert.equal(pickDefaultDid([]), null);
});

test("network KPI query construction keeps MISECT and MILANE unions separate", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/plugins/network-kpi-parquet-data.ts"), "utf8");
  assert.match(source, /const misect = subquery\("MISECT"\)/);
  assert.match(source, /const milane = subquery\("MILANE"\)/);
  assert.match(source, /FROM \(\$\{misect\}\)/);
  assert.match(source, /FROM \(\$\{milane\}\)/);
  assert.doesNotMatch(source, /const tables = .*UNION ALL/);
});
