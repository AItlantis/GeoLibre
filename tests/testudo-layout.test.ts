import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { TESTUDO_BLOCKED_PLUGIN_IDS } from "../packages/plugins/src/viewer-plugins";

test("GeoLibre does not render its own local-package button in Testudo layout", () => {
  const shell = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/DesktopShell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /Open local package|testudo-open-local-package/);
});

test("Testudo playback has no competing generic timeline controls", () => {
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("maplibre-gl-time-slider"));
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("geolibre-timelapse"));
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("geolibre-route-animation"));
});
