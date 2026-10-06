import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAssistantAllowed, isTestudoLayout, TESTUDO_BLOCKED_PLUGIN_IDS } from "../apps/geolibre-desktop/src/lib/testudo-mode";

test("Testudo layout is recognized and blocks the two unsafe plugins", () => {
  assert.equal(isTestudoLayout("?layout=testudo"), true);
  assert.equal(isTestudoLayout("?layout=map"), false);
  assert.deepEqual(TESTUDO_BLOCKED_PLUGIN_IDS, ["maplibre-gl-geoagent", "maplibre-gl-geo-editor"]);
  assert.throws(() => assertAssistantAllowed("?layout=testudo"), /disabled in Testudo/);
  assert.doesNotThrow(() => assertAssistantAllowed("?layout=map"));
});
