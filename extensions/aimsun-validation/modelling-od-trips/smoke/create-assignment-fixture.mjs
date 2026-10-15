import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "assignment-only");
await mkdir(out, { recursive: true });
const require = createRequire(new URL("../../_shared/package.json", import.meta.url));
const { DuckDBInstance } = require("@duckdb/node-api");
const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
const parquet = resolve(out, "assignment.parquet").replace(/\\/g, "/").replace(/'/g, "''");
await conn.run(`COPY (SELECT 1::BIGINT AS origin_id, 'One'::VARCHAR AS origin_name, 2::BIGINT AS destination_id, 'Two'::VARCHAR AS destination_name, 12.0::DOUBLE AS value UNION ALL SELECT 2, 'Two', 1, 'One', 7.0) TO '${parquet}' (FORMAT PARQUET)`);
conn.closeSync();
await writeFile(resolve(out, "centroids.geojson"), JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [54.0, 24.0] }, properties: { id: 1, name: "One", external_id: "one", groups: [] } },
  { type: "Feature", geometry: { type: "Point", coordinates: [54.1, 24.1] }, properties: { id: 2, name: "Two", external_id: "two", groups: [] } },
] }) + "\n", "utf8");
await writeFile(resolve(out, "manifest.json"), JSON.stringify({ schema_version: 1, run: "ASSIGNMENT_FIXTURE", analysis: "assignment", files: [
  { table: "od", path: "assignment.parquet", format: "parquet" },
  { table: "centroids", path: "centroids.geojson", format: "geojson" },
] }, null, 2) + "\n", "utf8");
