import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getGeolibrePackage } from "../packages/plugins/src/plugins/geolibre-package-loader";
import { readLocalNetworkKpiManifestJson } from "../packages/plugins/src/plugins/network-kpi-data";
import { createDirectoryPackageSource, type VehicleDirectoryHandle } from "../packages/plugins/src/plugins/vehicle-playback-data";

const fixture = process.env.TESTUDO_LOCAL_PACKAGE_FIXTURE;

function folder(directory: string): VehicleDirectoryHandle {
  return {
    name: path.basename(directory),
    async getDirectoryHandle(name) {
      const child = path.join(directory, name);
      if (!(await stat(child)).isDirectory()) throw new Error(`Not a directory: ${name}`);
      return folder(child);
    },
    async getFileHandle(name) {
      const file = path.join(directory, name);
      if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${name}`);
      return { async getFile() { return new Blob([new Uint8Array(await readFile(file))]); } };
    },
  };
}

test("a picked local package resolves its real manifest, geometry, and path index", { skip: !fixture }, async () => {
  const source = createDirectoryPackageSource(folder(fixture!));
  const manifest = await readLocalNetworkKpiManifestJson(folder(fixture!));
  const native = getGeolibrePackage(manifest);
  assert.equal(native?.capabilities.paths?.state, "available");
  assert.ok(native?.scenarios.length);
  const legacy = manifest as Record<string, unknown>;
  assert.equal(typeof legacy.path_index, "string");
  const geometry = JSON.parse(new TextDecoder().decode(await source.read("geometry/sections.geojson")));
  assert.ok(geometry.features.length);
  const index = JSON.parse(new TextDecoder().decode(await source.read("indexed_paths/metadata.json")));
  assert.ok(index);
  assert.ok((await source.read("indexed_paths/routes.parquet")).byteLength > 0);
  await assert.rejects(source.read("../manifest.json"), /outside the package folder/);
});
