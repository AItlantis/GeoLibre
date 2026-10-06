import assert from "node:assert/strict";
import { test } from "node:test";
import { TESTUDO_BLOCKED_PLUGIN_IDS } from "../packages/plugins/src/viewer-plugins";
import { createModel } from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { assertAssistantAllowed, isTestudoLayout } from "../apps/geolibre-desktop/src/lib/testudo-mode";
import type { AssistantProviderConfig } from "../apps/geolibre-desktop/src/lib/assistant/provider";

test("Testudo mode comes from layout=testudo and blocks GeoAgent", () => {
  assert.equal(isTestudoLayout("?layout=testudo"), true);
  assert.equal(isTestudoLayout("?layout=viewer"), false);
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("maplibre-gl-geoagent"));
});

test("Testudo keeps the host playback bar as the only playback UI", () => {
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("maplibre-gl-time-slider"));
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("geolibre-timelapse"));
});

test("stock assistant model and the shared session/fast-path guard refuse Testudo mode", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?layout=testudo" } },
  });
  try {
    const config = { provider: "openai", modelId: "test-model", apiKey: "never-used" } as AssistantProviderConfig;
    await assert.rejects(createModel(config), /disabled in Testudo embeds/);
    assert.throws(() => assertAssistantAllowed(), /disabled in Testudo embeds/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
