/**
 * aimsun-trips: OD desire lines for the selected run/period (before or after adjustment), top pairs and the
 * straight-line trip-length distribution. Entry of the drop-in bundle: default-exports a GeoLibrePlugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeOdPlugin } from "../../_od/plugin.ts";
import { wasmOdDb } from "../../_od/wasm-db.ts";
import { createTripsView, TRIPS_OVERLAY } from "./view.ts";

export const PLUGIN_ID = "aimsun-trips";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeOdPlugin({
  id: PLUGIN_ID,
  name: "Aimsun Trips (OD desire lines)",
  version: PLUGIN_VERSION,
  panelTitle: "OD trips",
  menuLabel: "OD trips",
  layerName: "OD desire lines",
  overlay: TRIPS_OVERLAY,
  getDb: async () => wasmOdDb(await getDuckDbInline()),
  createView: createTripsView,
});

export default plugin;
