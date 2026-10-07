import test from "node:test";
import assert from "node:assert/strict";
import { TestudoGenerationMount, TestudoGenerationResourceCache } from "../packages/plugins/src/shared/testudo-generation-resources";
import { selectScenarioPathIndex } from "../packages/plugins/src/shared/scenario-path-index";
import {
  __resetDuckDbLayerRegistryForTests,
  configureDuckDbLayerRegistry,
  getActiveDuckDbLayers,
  registerDuckDbLayer,
} from "../packages/plugins/src/shared/duckdb-layer-registry";

test("persistent network mounts once and remains mounted across mode changes", async () => {
  const mount = new TestudoGenerationMount();
  let mounts = 0;
  const apply = () => { mounts += 1; };
  assert.equal(await mount.mount(1, () => true, apply), true);
  // A mode change does not clear the package-owned mount.
  assert.equal(await mount.mount(1, () => true, apply), true);
  assert.equal(mounts, 1);
  assert.equal(mount.isMounted(1), true);
});

test("persistent network rejects a late mount from an old package generation", async () => {
  const mount = new TestudoGenerationMount();
  let resolveMount!: () => void;
  const pending = mount.mount(1, () => false, () => new Promise<void>(resolve => { resolveMount = resolve; }));
  mount.clear();
  resolveMount();
  assert.equal(await pending, false);
  assert.equal(mount.isMounted(1), false);
});

test("results resource cache reuses one database resource per package generation", async () => {
  const cache = new TestudoGenerationResourceCache<{ generation: number }>();
  let opens = 0;
  const open = async (generation: number) => cache.get(`package:${generation}`, async () => ({ generation: ++opens }));
  const [first, second] = await Promise.all([open(4), open(4)]);
  const nextGeneration = await open(5);
  assert.equal(first, second);
  assert.notEqual(first, nextGeneration);
  assert.equal(opens, 2);
});

test("network KPI timeline reads all per-did SIM_INFO catalog partitions", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(process.cwd(), "packages/plugins/src/plugins/network-kpi-parquet-data.ts"), "utf8");
  assert.match(source, /const parquetSource = handles\.length === 1[\s\S]*read_parquet\(\[\$\{handles\.map\(q\)\.join\("\, "\)\}\]\)/);
  assert.match(source, /WHERE did = \$\{did\}/);
  const provider = fs.readFileSync(path.join(process.cwd(), "packages/plugins/src/plugins/testudo-dataset-provider.ts"), "utf8");
  assert.match(provider, /testudoDatasetSessions\.get\(sessionKey, create\)/);
  assert.match(provider, /Plugin deactivation releases its view, while the package owner disposes/);
});

test("path analysis prefers the selected scenario index and keeps the legacy default", () => {
  const indices = { "0": "indexed_paths/0", "49320": "indexed_paths/49320", "49414": "indexed_paths/49414" };
  assert.equal(selectScenarioPathIndex(indices, 49414), "indexed_paths/49414");
  assert.equal(selectScenarioPathIndex(indices), "indexed_paths/0");
  assert.equal(selectScenarioPathIndex({ "49320": "indexed_paths/49320" }, 49414), "indexed_paths/49320");
});

test("vehicle playback stays registered without evicting or consuming a DuckDB slot", () => {
  __resetDuckDbLayerRegistryForTests();
  configureDuckDbLayerRegistry({ maxConcurrent: 1 });
  const disposed: string[] = [];
  registerDuckDbLayer({ pluginId: "network-kpi", family: "duckdb", dispose: () => { disposed.push("network-kpi"); } });
  registerDuckDbLayer({ pluginId: "vehicle-playback", family: "non-duckdb", dispose: () => { disposed.push("vehicle-playback"); } });
  registerDuckDbLayer({ pluginId: "emissions-h3", family: "duckdb", dispose: () => { disposed.push("emissions-h3"); } });
  assert.deepEqual(getActiveDuckDbLayers(), ["vehicle-playback", "emissions-h3"]);
  assert.deepEqual(disposed, ["network-kpi"]);
  __resetDuckDbLayerRegistryForTests();
});
