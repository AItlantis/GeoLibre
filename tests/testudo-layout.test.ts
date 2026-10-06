import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TestudoMapActions } from "../apps/geolibre-desktop/src/components/layout/TestudoMapActions";
import { TESTUDO_BLOCKED_PLUGIN_IDS } from "../packages/plugins/src/viewer-plugins";

// tsx compiles JSX with the classic runtime here; Vite uses the automatic runtime in the app.
(globalThis as { React?: typeof React }).React = React;

test("Testudo map actions expose the local package picker entry point", () => {
  const markup = renderToStaticMarkup(createElement(TestudoMapActions, { onOpenLocalPackage() {} }));
  assert.match(markup, /data-testid="testudo-open-local-package"/);
  assert.match(markup, />Open local package<\/button>/);
});

test("Testudo playback has no competing generic timeline controls", () => {
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("maplibre-gl-time-slider"));
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("geolibre-timelapse"));
  assert.ok(TESTUDO_BLOCKED_PLUGIN_IDS.includes("geolibre-route-animation"));
});
