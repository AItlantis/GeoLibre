/**
 * aimsun-od-before-after: group x group OD matrices before and after adjustment (heat tables), totals per group,
 * before-vs-after scatter and KPIs. Entry of the drop-in bundle: default-exports a GeoLibrePlugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeOdPlugin } from "../../_od/plugin.ts";
import { wasmOdDb } from "../../_od/wasm-db.ts";
import { createBeforeAfterView } from "./view.ts";

export const PLUGIN_ID = "aimsun-od-before-after";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeOdPlugin({
  id: PLUGIN_ID,
  name: "Aimsun OD Before/After",
  version: PLUGIN_VERSION,
  panelTitle: "OD before / after",
  menuLabel: "OD before / after",
  layerName: "OD before / after",
  overlay: [],
  getDb: async () => wasmOdDb(await getDuckDbInline()),
  createView: createBeforeAfterView,
});

export default plugin;
