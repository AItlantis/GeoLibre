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

  it("renders a toolbar trigger that opens the geoai panel only when the capability is available (#302)", () => {
    // Regression guard for #302: the backend correctly reported `geoai: available: true` and the
    // dispatch table + panel component both existed, but nothing in the toolbar actually called
    // `handlers["geoai"].open()` — so the chat panel was permanently unreachable from the UI. This
    // reads the JSX gating expression as source text (rather than rendering the component, which
    // needs the browser/wasm-only `@geolibre/plugins` barrel this Node suite avoids elsewhere —
    // see the comment on TESTUDO_CONTROLS_SOURCE above) and evaluates the *actual* guard condition
    // against synthetic capability lists, so a regression that silently drops the gate (e.g.
    // hardcoding `true`, or checking the wrong capability id) fails this test.
    const trigger = TESTUDO_CONTROLS_SOURCE.match(/\{(canOpenGeoAi) && <button[^]*?onClick=\{\(\) => \{ if \(app\) (handlers\["geoai"\]\.open\(app\));/);
    assert.ok(trigger, "TestudoControls must render a geoai trigger button gated on capability availability");
    const [, guardName, openExpr] = trigger!;
    assert.equal(guardName, "canOpenGeoAi");
    assert.equal(openExpr, 'handlers["geoai"].open(app)', "the trigger must call the shared geoai open handler");
    const guard = TESTUDO_CONTROLS_SOURCE.match(/const canOpenGeoAi = Boolean\(([^;]+)\);/);
    assert.ok(guard, "the trigger guard must be derived from the active package capability");
    assert.match(guard![1]!, /state\.capabilities\.some\(item => item\.id === "geoai" && item\.available\)/);

    const evalGuard = (capabilities: Array<{ id: string; available: boolean }>) => {
      const state = { capabilities };
      // eslint-disable-next-line no-new-func -- evaluating the extracted guard expression itself is the point of this test
      return new Function("app", "state", `return ${guard![1]};`)({}, state);
    };
    assert.equal(evalGuard([{ id: "geoai", available: true }]), true, "trigger must render when geoai is available");
    assert.equal(evalGuard([{ id: "geoai", available: false }]), false, "trigger must not render when geoai is unavailable");
    assert.equal(evalGuard([{ id: "vehicle-playback", available: true }]), false, "trigger must not render when geoai is not in the capability list at all");
    assert.equal(evalGuard([]), false, "trigger must not render for an empty capability list");
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

describe("Testudo GeoAI chat transport", () => {
  afterEach(() => {
    resetGeoAiChat();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("is unconfigured until initialized with a complete authenticated transport", () => {
    assert.equal(isGeoAiChatConfigured(), false);
  });

  it("requires the accepted package version for signed-in chat", () => {
    initGeoAiChat({ origin: "https://app.testudo.live", packageId: "London/demo" });
    assert.equal(isGeoAiChatConfigured(), false);
  });

  it("checks configured transport locally without probing a provider or endpoint", async () => {
    let fetchCalled = false;
    (globalThis as { fetch?: unknown }).fetch = async () => { fetchCalled = true; throw new Error("unexpected provider probe"); };
    initGeoAiChat({
      origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "package-uuid",
      packageVersionId: "accepted-version-uuid",
    });
    const status = await checkGeoAiAvailability();
    assert.equal(status.available, true);
    assert.equal(status.error, null);
    assert.equal(fetchCalled, false);
  });

  it("aborts a chat request that exceeds the 90-second transport deadline", async () => {
    const globals = globalThis as typeof globalThis & { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    const originalSetTimeout = globals.setTimeout;
    const originalClearTimeout = globals.clearTimeout;
    let fetchSawAbort = false;
    globals.setTimeout = ((callback: TimerHandler, delay?: number) => {
      assert.equal(delay, 90_000);
      if (typeof callback === "function") callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globals.clearTimeout = (() => undefined) as typeof clearTimeout;
    (globalThis as { fetch?: unknown }).fetch = async (_url: string | URL, init?: RequestInit) => {
      fetchSawAbort = Boolean(init?.signal?.aborted);
      throw init?.signal?.reason ?? new Error("request was not aborted");
    };
    initGeoAiChat({
      origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "package-uuid",
      packageVersionId: "accepted-version-uuid",
    });
    try {
      const status = await sendGeoAiChat("hello");
      assert.equal(fetchSawAbort, true);
      assert.match(status.error ?? "", /timed out/i);
    } finally {
      globals.setTimeout = originalSetTimeout;
      globals.clearTimeout = originalClearTimeout;
    }
  });

  it("posts signed-in chat with the platform package/version UUIDs and bounded viewer context", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    (globalThis as { fetch?: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          ok: true, reply: "There are 12 sections with high flow.", ai_available: true,
          ollaya: { status: "classified", intent: "data_query" },
          scenario_analysis: { status: "complete", evidence_reliability: { score: 0.8 } },
          diagnostics: { stage_latency_ms: { ollaya_intent_ms: 10, total_chat_ms: 40 } },
        }),
      } as Response;
    };
    initGeoAiChat({
      origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "package-uuid",
      packageVersionId: "accepted-version-uuid",
      getViewerContext: () => ({ surface: "geolibre", mode: "flow", plugin: "network-kpi", scenario_ids: [4, 5], active_scenario_id: 4 }),
    });
    const status = await sendGeoAiChat("Which sections have the highest flow?");
    assert.equal(status.loading, false);
    assert.equal(status.messages.length, 2);
    assert.equal(status.messages[0]?.role, "user");
    assert.equal(status.messages[1]?.role, "assistant");
    assert.equal(status.messages[1]?.text, "There are 12 sections with high flow.");
    assert.equal(status.messages[1]?.scenarioAnalysis?.status, "complete");
    assert.deepEqual(status.messages[1]?.diagnostics, { stage_latency_ms: { ollaya_intent_ms: 10, total_chat_ms: 40 } });
    assert.equal(capturedUrl, "https://app.testudo.live/api/v1/ai/chat");
    assert.equal(capturedInit?.method, "POST");
    assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer token-123");
    assert.equal(capturedInit?.credentials, "omit");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      package_id: "package-uuid",
      package_version_id: "accepted-version-uuid",
      prompt: "Which sections have the highest flow?",
      messages: [],
      viewer_context: { surface: "geolibre", mode: "flow", plugin: "network-kpi", scenario_ids: [4, 5], active_scenario_id: 4 },
    });
  });

  it("posts guest chat to the public route, keeps the current prompt separate, and sends no client-selected authority", async () => {
    const guestCredential = "guest-capability-secret-12345678901234567890";
    const fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
      fetched.push({ url: String(url), init });
      return { ok: true, json: async () => ({ ok: true, reply: "The guest answer.", available: true, read_only: true }) } as Response;
    };
    initGeoAiChat({
      origin: "https://app.testudo.live",
      guest: { getGuestEmbedToken: () => guestCredential },
      getViewerContext: () => ({ surface: "geolibre", mode: "comparison", scenario_ids: [2, 3] }),
    });

    await sendGeoAiChat("Compare scenario 2 with scenario 3.");
    const status = await sendGeoAiChat("Which one has more delay?");
    assert.equal(status.messages.at(-1)?.text, "The guest answer.");
    assert.equal(fetched.length, 2);
    const second = fetched[1]!;
    assert.equal(second.url, "https://app.testudo.live/api/public/demo/geoai-chat");
    assert.equal(second.init?.method, "POST");
    assert.equal((second.init?.headers as Record<string, string>).Authorization, `Testudo-Embed ${guestCredential}`);
    assert.equal(second.init?.credentials, "omit");
    assert.equal(new URL(second.url).search, "");
    const body = JSON.parse(String(second.init?.body));
    assert.deepEqual(body, {
      prompt: "Which one has more delay?",
      messages: [
        { role: "user", content: "Compare scenario 2 with scenario 3." },
        { role: "assistant", content: "The guest answer." },
      ],
      viewer_context: { surface: "geolibre", mode: "comparison", scenario_ids: [2, 3] },
    });
    assert.equal(JSON.stringify(body).includes(guestCredential), false);
    assert.equal(status.messages.some(message => message.text.includes(guestCredential)), false, "guest credential must stay out of the transcript");
    for (const forbiddenKey of ["city", "package_id", "package_version_id", "model", "tool", "tools", "token", "bearer_token", "grant"]) {
      assert.equal(Object.hasOwn(body, forbiddenKey), false, `guest body must not contain ${forbiddenKey}`);
    }
    assert.equal(fetched.every(call => call.url === "https://app.testudo.live/api/public/demo/geoai-chat"), true);
  });

  it("records an AI_UNAVAILABLE response as an error message", async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      json: async () => ({ error: "AI is currently unavailable.", code: "AI_UNAVAILABLE" }),
    } as Response);
    initGeoAiChat({ origin: "https://app.testudo.live", bearerToken: "token-123", packageId: "package-uuid", packageVersionId: "accepted-version-uuid" });
    const status = await sendGeoAiChat("hello");
    assert.equal(status.messages.at(-1)?.role, "error");
    assert.equal(getGeoAiChatStatus().error, "AI is currently unavailable.");
  });

  it("sendChat without init() reports the session requirement instead of throwing", async () => {
    const status = await sendGeoAiChat("hello");
    assert.equal(status.error, "GeoAI chat requires a signed-in session.");
  });
});
