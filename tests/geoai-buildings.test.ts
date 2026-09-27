import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { validateTestudoBootstrap } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
// Imported by its own path, not through the `@geolibre/plugins` barrel: the barrel re-exports the
// heavier map/DuckDB plugins (network-kpi, emissions-h3, …), which pull in browser/wasm-only
// modules that Node's test runner cannot resolve. `geoai-buildings.ts` itself only imports `type`s
// from `../types` and `maplibre-gl`, so it is safe to load directly — the same pattern
// `geoai-chat.test.ts` uses to avoid the barrel.
import {
  getGeoAiBuildingsStatus,
  initGeoAiBuildings,
  isGeoAiBuildingsConfigured,
  resetGeoAiBuildings,
  runGeoaiBuildingsInference,
} from "../packages/plugins/src/plugins/geoai-buildings";
import type { TestudoBootstrap } from "../packages/embed/src/testudo";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const TESTUDO_CONTROLS_SOURCE = readFileSync(
  new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url),
  "utf8",
);

function bootstrap(overrides: Partial<TestudoBootstrap> = {}): TestudoBootstrap {
  return {
    packageId: "Some/package",
    versionId: "11111111-1111-1111-1111-111111111111",
    label: "Some package",
    origin: "published",
    manifestPath: "manifest.json",
    nativeManifestPath: "geolibre/package.json",
    artifactEndpoint: "/api/v1/view/11111111-1111-1111-1111-111111111111/artifact/",
    capabilities: [{ id: "vehicle-playback", available: true }],
    presets: [],
    ...overrides,
  };
}

function fakeApp(bounds: [number, number, number, number] | null = [-1, 51, 0, 52], basemap = "https://example.test/tiles/{z}/{x}/{y}.png"): GeoLibreAppAPI {
  return {
    getViewBounds: () => bounds,
    getActiveBasemap: () => basemap,
  } as unknown as GeoLibreAppAPI;
}

describe("GeoAI buildings capability wiring (issue #308)", () => {
  afterEach(() => { resetGeoAiBuildings(); });

  it("is present in the set of Testudo capabilities TestudoControls wires up", () => {
    const idsDeclaration = TESTUDO_CONTROLS_SOURCE.match(/const ids: TestudoCapabilityId\[\] = \[([^\]]+)\]/);
    assert.ok(idsDeclaration, "TestudoControls must declare its capability id list as `ids`");
    const declaredIds = idsDeclaration![1].split(",").map(value => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
    assert.ok(declaredIds.includes("geoai-buildings"), "TestudoControls must wire the geoai-buildings capability");
    assert.ok(TESTUDO_CONTROLS_SOURCE.includes('"geoai-buildings": { open: plugins.openGeoAiBuildingsPanel'), "TestudoControls must dispatch geoai-buildings through the shared handlers table");
  });

  it("accepts a bootstrap that declares the geoai-buildings capability", () => {
    const candidate = bootstrap({ capabilities: [{ id: "vehicle-playback", available: true }, { id: "geoai-buildings", available: true }] });
    assert.doesNotThrow(() => validateTestudoBootstrap(candidate, false));
  });

  it("still rejects an unknown capability id", () => {
    const candidate = bootstrap({ capabilities: [{ id: "vehicle-playback", available: true }, { id: "not-a-real-capability" as never, available: true }] });
    assert.throws(() => validateTestudoBootstrap(candidate, false));
  });
});

describe("geoai-buildings store (ported building-footprint overlay contract)", () => {
  afterEach(() => {
    resetGeoAiBuildings();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("is unconfigured until init() is called with a bearer token", () => {
    assert.equal(isGeoAiBuildingsConfigured(), false);
  });

  it("stays unconfigured for a guest session (no bearer token) since the backend only accepts principal bearer auth", () => {
    initGeoAiBuildings({ origin: "https://app.testudo.live", packageId: "London/demo" });
    assert.equal(isGeoAiBuildingsConfigured(), false);
  });

  it("posts to /api/agent/v1/geoai/infer with the exact task/bbox/source body and bearer header", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let capturedBody: unknown;
    (globalThis as { fetch?: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ available: true, task: "building_footprints", type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [] } }] }),
      } as Response;
    };
    initGeoAiBuildings({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await runGeoaiBuildingsInference(fakeApp([-1, 51, 0, 52], "https://tiles.example/aerial/{z}/{x}/{y}.png"));
    assert.equal(status.loading, false);
    assert.equal(status.available, true);
    assert.equal(status.error, null);
    assert.equal(status.featureCount, 1);
    assert.equal(capturedAuth, "Bearer token-123");
    assert.equal(capturedUrl, "https://app.testudo.live/api/agent/v1/geoai/infer");
    assert.deepEqual(capturedBody, { task: "building_footprints", bbox: [-1, 51, 0, 52], source: "https://tiles.example/aerial/{z}/{x}/{y}.png" });
  });

  it("records an available:false response as a status error, not a thrown exception", async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      json: async () => ({ available: false, task: "building_footprints", type: "FeatureCollection", features: [] }),
    } as Response);
    initGeoAiBuildings({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await runGeoaiBuildingsInference(fakeApp());
    assert.equal(status.available, false);
    assert.ok(status.error);
    assert.equal(getGeoAiBuildingsStatus().featureCount, 0);
  });

  it("records a non-OK response as a status error, not a thrown exception", async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many concurrent inferences" }),
    } as Response);
    initGeoAiBuildings({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await runGeoaiBuildingsInference(fakeApp());
    assert.equal(status.available, false);
    assert.equal(status.error, "Too many concurrent inferences");
  });

  it("inference without init() reports the session requirement instead of throwing", async () => {
    const status = await runGeoaiBuildingsInference(fakeApp());
    assert.equal(status.error, "GeoAI buildings requires a signed-in session.");
  });

  it("reports a missing viewport instead of throwing when getViewBounds returns null", async () => {
    initGeoAiBuildings({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await runGeoaiBuildingsInference(fakeApp(null));
    assert.equal(status.error, "The current viewport is unavailable.");
  });

  it("discards a stale response that arrives after resetGeoAiBuildings() bumped the token", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    (globalThis as { fetch?: unknown }).fetch = async () => new Promise<Response>(resolve => { resolveFetch = resolve; });
    initGeoAiBuildings({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const pending = runGeoaiBuildingsInference(fakeApp());
    resetGeoAiBuildings();
    resolveFetch!({
      ok: true,
      json: async () => ({ available: true, task: "building_footprints", type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [] } }] }),
    } as Response);
    await pending;
    assert.equal(getGeoAiBuildingsStatus().loading, false);
    assert.equal(getGeoAiBuildingsStatus().available, false);
    assert.equal(getGeoAiBuildingsStatus().featureCount, 0);
  });
});
