import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { validateTestudoBootstrap } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
// Imported by its own path, not through the `@geolibre/plugins` barrel: the barrel re-exports the
// heavier map/DuckDB plugins (network-kpi, emissions-h3, …), which pull in browser/wasm-only
// modules that Node's test runner cannot resolve. `geoai-chat.ts` itself only imports `type`s from
// `../types`, so it is safe to load directly — the same pattern other tests in this suite use to
// avoid the barrel (see plugin-query-api.test.ts, plugin-owned-paint.test.ts).
import {
  checkGeoAiAvailability,
  getGeoAiChatStatus,
  initGeoAiChat,
  isGeoAiChatConfigured,
  resetGeoAiChat,
  sendGeoAiChat,
} from "../packages/plugins/src/plugins/geoai-chat";
import type { TestudoBootstrap } from "../packages/embed/src/testudo";

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

describe("GeoAI chat capability wiring (issue #273)", () => {
  afterEach(() => { resetGeoAiChat(); });

  it("is present in the set of Testudo capabilities TestudoControls wires up", () => {
    // Regression guard: before the fix, `ids` had exactly 5 entries and never included "geoai" —
    // GeoAI chat had zero wiring in the GeoLibre-native path even though the legacy viewer's
    // adapter and the `/api/v1/ai/chat` backend were fully built and working. Read as source text
    // (rather than importing the component) to avoid pulling the browser/wasm-only map plugins
    // TestudoControls value-imports from `@geolibre/plugins` into this Node test.
    const idsDeclaration = TESTUDO_CONTROLS_SOURCE.match(/const ids: TestudoCapabilityId\[\] = \[([^\]]+)\]/);
    assert.ok(idsDeclaration, "TestudoControls must declare its capability id list as `ids`");
    const declaredIds = idsDeclaration![1].split(",").map(value => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
    assert.ok(declaredIds.includes("geoai"), "TestudoControls must wire the geoai capability");
    assert.ok(TESTUDO_CONTROLS_SOURCE.includes('"geoai": { open: plugins.openGeoAiChatPanel'), "TestudoControls must dispatch geoai through the shared handlers table");
  });

  it("accepts a bootstrap that declares the geoai capability", () => {
    const candidate = bootstrap({ capabilities: [{ id: "vehicle-playback", available: true }, { id: "geoai", available: true }] });
    assert.doesNotThrow(() => validateTestudoBootstrap(candidate, false));
  });

  it("still rejects an unknown capability id", () => {
    const candidate = bootstrap({ capabilities: [{ id: "vehicle-playback", available: true }, { id: "not-a-real-capability" as never, available: true }] });
    assert.throws(() => validateTestudoBootstrap(candidate, false));
  });
});

describe("geoai-chat store (ported adapter contract: init/sendChat/checkAvailability)", () => {
  afterEach(() => {
    resetGeoAiChat();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("is unconfigured until init() is called with a bearer token", () => {
    assert.equal(isGeoAiChatConfigured(), false);
  });

  it("stays unconfigured for a guest session (no bearer token) since the backend only accepts principal bearer auth", () => {
    initGeoAiChat({ origin: "https://app.testudo.live", packageId: "London/demo" });
    assert.equal(isGeoAiChatConfigured(), false);
  });

  it("checkAvailability calls GET /api/v1/ai/status with the bearer token and package_id", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    (globalThis as { fetch?: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return {
        ok: true,
        json: async () => ({ ok: true, ai_available: true, code: null }),
      } as Response;
    };
    initGeoAiChat({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await checkGeoAiAvailability();
    assert.equal(status.available, true);
    assert.equal(status.error, null);
    assert.equal(capturedAuth, "Bearer token-123");
    assert.match(capturedUrl ?? "", /^https:\/\/app\.testudo\.live\/api\/v1\/ai\/status\?package_id=London%2Fdemo$/);
  });

  it("sendChat posts to /api/v1/ai/chat and records the reply in the transcript", async () => {
    let capturedBody: unknown;
    (globalThis as { fetch?: unknown }).fetch = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ reply: "There are 12 sections with high flow." }),
      } as Response;
    };
    initGeoAiChat({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await sendGeoAiChat("Which sections have the highest flow?");
    assert.equal(status.loading, false);
    assert.equal(status.messages.length, 2);
    assert.equal(status.messages[0]?.role, "user");
    assert.equal(status.messages[1]?.role, "assistant");
    assert.equal(status.messages[1]?.text, "There are 12 sections with high flow.");
    assert.deepEqual(capturedBody, { prompt: "Which sections have the highest flow?", package_id: "London/demo" });
  });

  it("sendChat records a degraded AI_UNAVAILABLE-style response as an error message, not a thrown exception", async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      json: async () => ({ error: "AI is currently unavailable.", code: "AI_UNAVAILABLE" }),
    } as Response);
    initGeoAiChat({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "London/demo" });
    const status = await sendGeoAiChat("hello");
    assert.equal(status.messages.at(-1)?.role, "error");
    assert.equal(getGeoAiChatStatus().error, "AI is currently unavailable.");
  });

  it("sendChat without init() reports the session requirement instead of throwing", async () => {
    const status = await sendGeoAiChat("hello");
    assert.equal(status.error, "GeoAI chat requires a signed-in session.");
  });
});
