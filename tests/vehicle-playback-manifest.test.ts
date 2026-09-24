import assert from "node:assert/strict";
import test from "node:test";
import {
  attachGeolibrePackage,
} from "../packages/plugins/src/plugins/geolibre-package-loader";
import {
  createHttpPackageSource,
  listVehicleManifestScenarios,
  loadScenarioAnimationManifest,
  loadVehicleGeometry,
  parseVehicleManifest,
  VehiclePlaybackData,
  type VehiclePackageSource,
} from "../packages/plugins/src/plugins/vehicle-playback-data";

function source(files: Record<string, unknown>): VehiclePackageSource {
  return {
    baseUrl: null,
    async read(path: string): Promise<ArrayBuffer> {
      const value = files[path];
      if (value === undefined) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(JSON.stringify(value)).buffer;
    },
  };
}

test("vehicle playback exposes package animation variants and loads each declared FZP manifest", async () => {
  const legacy = {
    metadata: { dt: 1, n_ticks: 2 },
    chunks: [{ index: 0, path: "chunks/shared.json", start_tick: 0, end_tick: 2 }],
    animations: [
      { name: "JUMPEIRA_AMPK", path: "chunks/JUMPEIRA_AMPK/animation.json", scid: 296665 },
      { name: "JUMPEIRA_PMPK", path: "chunks/JUMPEIRA_PMPK/animation.json", scid: 296665 },
    ],
  };
  const raw = attachGeolibrePackage(legacy, {
    scenarios: [{
      name: "Jumeira",
      scid: 296665,
      replications: [{ did: 296671 }],
      animations: [
        { name: "JUMPEIRA_AMPK", manifestPath: "chunks/JUMPEIRA_AMPK/animation.json", scid: 296665 },
        { name: "JUMPEIRA_PMPK", manifestPath: "chunks/JUMPEIRA_PMPK/animation.json", scid: 296665 },
      ],
    }],
  });

  const scenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
  assert.deepEqual(scenarios.map((scenario) => scenario.id), ["JUMPEIRA_AMPK", "JUMPEIRA_PMPK"]);
  assert.deepEqual(scenarios.map((scenario) => scenario.manifestPath), [
    "chunks/JUMPEIRA_AMPK/animation.json",
    "chunks/JUMPEIRA_PMPK/animation.json",
  ]);
  assert.deepEqual(scenarios.map((scenario) => scenario.scid), [296665, 296665]);
  assert.deepEqual(scenarios.map((scenario) => scenario.did), [296671, 296671]);
  assert.deepEqual(scenarios.map((scenario) => scenario.scenarioName), ["Jumeira", "Jumeira"]);
  assert.deepEqual(scenarios.map((scenario) => scenario.fzpName), ["JUMPEIRA_AMPK", "JUMPEIRA_PMPK"]);

  const pmpk = await loadScenarioAnimationManifest(
    raw,
    source({
      "chunks/JUMPEIRA_PMPK/animation.json": {
        metadata: { dt: 1, n_ticks: 2 },
        chunks: [{ index: 0, path: "chunks/JUMPEIRA_PMPK/0.json", start_tick: 0, end_tick: 2 }],
      },
    }),
    1,
    scenarios[1],
  );
  const parsed = parseVehicleManifest(raw, null, 1, pmpk);
  assert.equal(parsed.chunks[0]?.url, "chunks/JUMPEIRA_PMPK/0.json");
  assert.notEqual(parsed.chunks[0]?.url, "chunks/shared.json");
});

test("vehicle playback keeps named root manifests usable when package metadata has no animation list", () => {
  const raw = attachGeolibrePackage({
    animations: [{ name: "AM_FZP", path: "chunks/AM_FZP/animation.json", scid: 42 }],
  }, {
    scenarios: [{ name: "Scenario 42", scid: 42, replications: [{ did: 43 }] }],
  });
  const scenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0]?.id, "AM_FZP");
  assert.equal(scenarios[0]?.scid, 42);
  assert.equal(scenarios[0]?.manifestPath, "chunks/AM_FZP/animation.json");
});

test("scenario metadata without scenario animation manifests does not create fake playback choices", () => {
  const raw = attachGeolibrePackage({
    metadata: { n_ticks: 21, dt: 0.8 },
    chunks: [{ index: 0, path: "chunks/shared-vehicle-stream.json.gz", start_tick: 0, end_tick: 21 }],
  }, {
    scenarios: [
      { name: "Reference", scid: 10, replications: [{ did: 11 }] },
      { name: "Compared", scid: 20, replications: [{ did: 21 }] },
    ],
  });

  const scenarios = listVehicleManifestScenarios(raw, { includeAnimationVariants: true });
  assert.deepEqual(scenarios, []);
});

test("vehicle coverage loads only the chunk needed by the requested playback tick", async () => {
  const reads: string[] = [];
  const parsed = parseVehicleManifest({
    metadata: { n_ticks: 20, dt: 1 },
    chunks: [
      { index: 0, path: "chunks/0.json", start_tick: 0, end_tick: 10 },
      { index: 1, path: "chunks/1.json", start_tick: 10, end_tick: 20 },
    ],
  }, null);
  const playback = new VehiclePlaybackData(parsed, {
    baseUrl: null,
    async read(path: string): Promise<ArrayBuffer> {
      reads.push(path);
      return new TextEncoder().encode(JSON.stringify({ events: {} })).buffer;
    },
  });
  try {
    assert.equal(await playback.ensureCoverage(0), true);
    assert.deepEqual(reads, ["chunks/0.json"]);
    assert.equal(await playback.ensureCoverage(10), true);
    assert.deepEqual(reads, ["chunks/0.json", "chunks/1.json"]);
  } finally {
    playback.destroy();
  }
});

test("per-animation chunk paths remain rooted at the package manifest URL", () => {
  const parsed = parseVehicleManifest(
    { animations: [{ name: "AM_FZP", path: "chunks/AM_FZP/animation.json" }] },
    "https://packages.example.test/cbd/manifest.json",
    0,
    {
      chunks: [{ index: 0, path: "chunks/AM_FZP/0.json.gz", start_tick: 0, end_tick: 10 }],
    },
  );
  assert.equal(parsed.chunks[0]?.url, "https://packages.example.test/cbd/chunks/AM_FZP/0.json.gz");
});

test("scenario metadata inherits root bounds when animation metadata is partial", () => {
  const parsed = parseVehicleManifest({
    metadata: {
      bounds: { min_lon: 1, min_lat: 2, max_lon: 3, max_lat: 4 },
      initial_time_seconds: 28_800,
    },
    animations: [{ metadata: { n_ticks: 10 }, chunks: [{ index: 0, path: "chunks/0.json" }] }],
  }, null);
  assert.deepEqual(parsed.bounds, [1, 2, 3, 4]);
  assert.equal(parsed.initialTimeSeconds, 28_800);
});

test("empty and invalid geometry are optional and report the asset path", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const empty = await loadVehicleGeometry(
      {
        baseUrl: null,
        async read(): Promise<ArrayBuffer> {
          return new ArrayBuffer(0);
        },
      },
      { sections: null, lanes: "geometry/lanes.geojson", turns: null, nodes: null },
    );
    assert.equal(empty.lanes, null);

    const invalid = await loadVehicleGeometry(
      {
        baseUrl: null,
        async read(path: string): Promise<ArrayBuffer> {
          if (path === "geometry/lanes.geojson") return new TextEncoder().encode("{").buffer;
          throw new Error(`missing ${path}`);
        },
      },
      { sections: null, lanes: "geometry/lanes.geojson", turns: null, nodes: null },
    );
    assert.equal(invalid.lanes, null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /lanes geometry unavailable \(geometry\/lanes\.geojson\)/);
  assert.match(warnings[0]!, /file is empty/);
  assert.match(warnings[1]!, /file is not valid JSON/);
});

test("HTTP asset failures include the resolved URL and local-folder guidance for Vite external paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 403, statusText: "Forbidden" })) as typeof fetch;
  try {
    await assert.rejects(
      createHttpPackageSource("http://localhost:5173/@fs/F:/Testudo/package/manifest.json").read("chunks/0.json"),
      /Failed to fetch playback asset .*chunks\/0\.json.*Use GeoLibre's "Load folder" action/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
