import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the actual compatible-restore branch. Importing the plugin directly
// requires Vite's browser-only WASM and worker URL imports, so this keeps the
// renderer and package boundaries as small controlled stubs.
const source = readFileSync(new URL(
  "../packages/plugins/src/plugins/maplibre-vehicle-playback.ts", import.meta.url,
), "utf8");
const match = source.match(
  /^(?:export )?function restoreVehiclePlayback\([\s\S]*?^}/m,
);
assert.ok(match, "Missing production function restoreVehiclePlayback");
const script = stripTypeScriptTypes(match[0].replace(/^export /, ""));

test("compatible vehicle restore preserves the committed manifest URL", () => {
  const calls = { attach: 0, applySettings: 0 };
  const defaults = {
    manifestUrl: null as string | null,
    playing: false,
    speed: 1,
    loop: true,
    tick: 0,
    opacity: 0.95,
    zOffsetM: 0,
    seeThroughBuildings: true,
    showNetwork: true,
    showSections: true,
    showLanes: true,
    showTurns: true,
    showNodes: true,
  };
  const context = {
    appRef: null,
    panelVisible: true,
    data: {},
    settings: {
      ...defaults,
      manifestUrl: "https://package/manifest.json" as string | null,
      playing: true,
      tick: 42,
    },
    DEFAULT_VEHICLE_PLAYBACK_SETTINGS: defaults,
    normalizeVehiclePlaybackSettings: (state: object | undefined, base: object) => ({
      ...base,
      ...state,
    }),
    applyActiveVehicleSettings(next: object) {
      calls.applySettings++;
      context.settings = next;
    },
    attachEngine() {
      calls.attach++;
    },
    restoreVehiclePlayback: undefined as unknown as (app: object, state: object) => boolean,
  } as any;

  runInNewContext(script, context);
  assert.equal(
    context.restoreVehiclePlayback({}, { open: true, manifestUrl: null, opacity: 0.5 }),
    false,
  );
  const after = context.settings as typeof defaults & { manifestUrl: string | null };
  assert.equal(after.manifestUrl, "https://package/manifest.json");
  assert.equal(after.opacity, 0.5);
  assert.equal(after.playing, true);
  assert.equal(after.tick, 42);
  assert.deepEqual(calls, { attach: 1, applySettings: 1 });
});
