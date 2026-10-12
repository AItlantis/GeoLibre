/**
 * aimsun-od-diff: OD adjustment differences (top gains/losses, deviation bands, net production/attraction map,
 * group deviation table). Entry of the drop-in bundle: default-exports a GeoLibrePlugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeOdPlugin } from "../../_od/plugin.ts";
import { wasmOdDb } from "../../_od/wasm-db.ts";
import { createDiffView, DIFF_OVERLAY } from "./view.ts";

export const PLUGIN_ID = "aimsun-od-diff";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeOdPlugin({
  id: PLUGIN_ID,
  name: "Aimsun OD Differences",
  version: PLUGIN_VERSION,
  panelTitle: "OD differences",
  menuLabel: "OD differences",
  layerName: "OD differences",
  overlay: DIFF_OVERLAY,
  getDb: async () => wasmOdDb(await getDuckDbInline()),
  createView: createDiffView,
});

export default plugin;
