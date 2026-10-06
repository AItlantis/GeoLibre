import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pickTestudoLocalDirectory,
  TestudoLocalPackageError,
  validateTestudoLocalPackage,
  type TestudoLocalDirectoryHandle,
} from "../apps/geolibre-desktop/src/lib/testudo-local-package";
import { TestudoFeatureBridge } from "../packages/plugins/src/testudo-feature-bridge";
import { getTestudoPackageProviderSuite } from "../packages/plugins/src/testudo-provider-registry";
import { registerTestudoTimeSeriesProviders } from "../packages/plugins/src/plugins/testudo-time-series-providers";
import { registerTestudoVehiclePlaybackProvider } from "../packages/plugins/src/plugins/testudo-vehicle-playback";

function directory(name: string, files: Record<string, string>): TestudoLocalDirectoryHandle {
  const tree = new Map<string, string>();
  for (const [path, value] of Object.entries(files)) tree.set(path, value);
  const at = (prefix: string): TestudoLocalDirectoryHandle => ({
    name,
    async getDirectoryHandle(child) {
      const next = prefix ? `${prefix}/${child}` : child;
      if (![...tree.keys()].some((path) => path.startsWith(`${next}/`))) throw new DOMException("Missing", "NotFoundError");
      return at(next);
    },
    async getFileHandle(file) {
      const path = prefix ? `${prefix}/${file}` : file;
      const contents = tree.get(path);
      if (contents === undefined) throw new DOMException("Missing", "NotFoundError");
      return { async getFile() { return new Blob([contents]); } };
    },
  });
  return at("");
}

const validFiles = {
  "manifest.json": JSON.stringify({ name: "Fixture package", scenarios: [{ id: "baseline" }], kpiTimeSeries: { "1": [1] } }),
  "geolibre/package.json": JSON.stringify({ name: "Fixture package", capabilities: { animation: { state: "available" }, results: { state: "available" } } }),
  "geolibre/data.bin": "local bytes",
};

const realShapeFiles = {
  "manifest.json": JSON.stringify({
    package_schema_version: "1.1",
    metadata: { dt: 0.8, n_ticks: 768 },
    capabilities: {
      animation: { status: "available" }, geometry: { status: "available" },
      results: { status: "available" }, paths: { status: "available" },
    },
    geometry: { sections: "geometry/sections.geojson", lanes: "geometry/lanes.geojson" },
    path_indices: { "49320": "indexed_paths/49320" },
    environment: { sqlite_path: "results.sqlite.zst", results_catalog_relative: "results/catalog.json" },
    animations: [{ name: "A1", path: "chunks/A1/animation.json", scid: 49320 }],
    decoration: { path: "decoration/style.json" },
    preview: { image: "preview/thumbnail.png" },
  }),
  "geolibre/package.json": JSON.stringify({
    schemaVersion: "geolibre.package.v1", time: { dtSeconds: 0.8, intervalCount: 768 },
    capabilities: { animation: { state: "available" }, paths: { state: "available" }, results: { state: "available" } },
    scenarios: [{ scid: 49320, name: "Reference", pathIndex: "indexed_paths/49320", replications: [{ did: 49342 }] }],
  }),
  "geometry/sections.geojson": "sections",
  "indexed_paths/49320/link_to_routes.parquet": "path bytes",
  "chunks/A1/animation.json": "animation manifest",
  "results/catalog.json": "{}",
  "results.sqlite.zst": "compressed database fixture",
  "decoration/style.json": "{}",
  "preview/thumbnail.png": "image bytes",
};

describe("Testudo local package picker and validation", () => {
  it("returns a validated package and reads nested artifacts from the selected folder", async () => {
    const pkg = await validateTestudoLocalPackage(directory("fixture", validFiles));
    assert.equal(pkg.label, "Fixture package");
    assert.equal(pkg.capabilities.find((item) => item.id === "vehicle-playback")?.available, true);
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("geolibre/data.bin")), "local bytes");
    await assert.rejects(pkg.readArtifact("../outside"), /unsafe artifact path/);
  });

  it("maps capabilities and artifact references from the v3.1 Testudo package manifest shape", async () => {
    const pkg = await validateTestudoLocalPackage(directory("real-shape", realShapeFiles));
    for (const id of ["vehicle-playback", "network-kpi", "emissions-h3", "scenario-comparison"] as const) {
      assert.equal(pkg.capabilities.find((item) => item.id === id)?.available, true, id);
    }
    assert.equal(pkg.capabilities.find((item) => item.id === "path-analysis")?.available, false);
    assert.match(pkg.capabilities.find((item) => item.id === "path-analysis")?.reason ?? "", /no Testudo path-analysis provider/);
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("geometry/sections.geojson")), "sections");
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("indexed_paths/49320/link_to_routes.parquet")), "path bytes");
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("chunks/A1/animation.json")), "animation manifest");
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("results/catalog.json")), "{}");
  });

  it("loads the local fixture through the published provider suite and binds playback to its TView", async () => {
    const unregisterVehicle = registerTestudoVehiclePlaybackProvider();
    const unregisterTimeSeries = registerTestudoTimeSeriesProviders();
    const pkg = await validateTestudoLocalPackage(directory("real-shape", realShapeFiles));
    const bridge = new TestudoFeatureBridge(getTestudoPackageProviderSuite);
    try {
      bridge.createTView("local");
      const context = await bridge.loadPackage("local", {
        packageId: pkg.packageId, versionId: "local", label: pkg.label, artifactEndpoint: "",
        origin: "local", capabilities: pkg.capabilities, selectedPlugin: "vehicle-playback",
      }, undefined, pkg.readArtifact);
      assert.equal(bridge.getState("local").status, "ready");
      assert.equal(bridge.getState("local").package?.origin, "local");
      assert.deepEqual(bridge.sessions.get("local")?.scenarios, [
        { id: "49320", label: "Reference", replications: [{ id: 49342 }] },
      ]);
      await bridge.selectPlugin("local", "network-kpi");
      const state = await bridge.playback("local", "seek", 12, context.generation);
      assert.equal(state.available, true);
      assert.equal(state.tick, 12);
      assert.equal(state.maxTick, 767);
      await bridge.selectPlugin("local", "scenario-comparison");
      assert.equal(bridge.getPlaybackState("local", context.generation).available, true);
      assert.equal(bridge.getPlaybackState("local", context.generation).tick, 12);
    } finally {
      bridge.close("local");
      unregisterTimeSeries();
      unregisterVehicle();
    }
  });

  it("rejects folders without valid Testudo manifests", async () => {
    await assert.rejects(
      validateTestudoLocalPackage(directory("bad", { "manifest.json": "{broken" })),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "invalid-package",
    );
    await assert.rejects(
      validateTestudoLocalPackage(directory("bad", { "manifest.json": "{}", "geolibre/package.json": "{}" })),
      /must declare capabilities/,
    );
  });

  it("reports unsupported folder pickers with a typed error", async () => {
    await assert.rejects(
      pickTestudoLocalDirectory({} as Window),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "unsupported",
    );
  });

  it("reports picker cancellation with a typed error", async () => {
    await assert.rejects(
      pickTestudoLocalDirectory({ showDirectoryPicker: async () => { throw new DOMException("cancelled", "AbortError"); } } as unknown as Window),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "cancelled",
    );
  });
});
