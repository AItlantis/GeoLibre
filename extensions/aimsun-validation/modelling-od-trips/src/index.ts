import { getDuckDbInline } from "../../_shared/src/browser";
import { makeOdPlugin } from "./_od/plugin.ts";
import { wasmOdDb } from "./_od/wasm-db.ts";
import { createModeView } from "./mode.ts";
import { TRIPS_OVERLAY } from "./views/trips.ts";
import { BA_OVERLAY } from "./views/before-after.ts";
import { DIFF_OVERLAY } from "./views/diff.ts";

export const PLUGIN_ID = "modelling-od-trips";
export const PLUGIN_VERSION = "0.2.0";
const plugin = makeOdPlugin({
  id: PLUGIN_ID,
  name: "Modelling OD Trips",
  version: PLUGIN_VERSION,
  panelTitle: "Modelling OD Trips",
  menuLabel: "Modelling OD Trips",
  layerName: "Modelling OD Trips",
  overlay: [...TRIPS_OVERLAY, ...BA_OVERLAY, { ...DIFF_OVERLAY[0], id: "diff-lines" }, DIFF_OVERLAY[1]],
  getDb: async () => wasmOdDb(await getDuckDbInline()),
  createView: createModeView,
});
export default plugin;
