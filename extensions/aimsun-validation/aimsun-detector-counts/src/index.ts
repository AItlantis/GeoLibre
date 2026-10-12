/**
 * aimsun-detector-counts: simulated vs observed detector flow (right panel, map layer, table).
 * Entry of the drop-in bundle: default-exports a GeoLibrePlugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeDetectorPlugin } from "./common/plugin-host.ts";
import { buildCountsSections, COUNTS_INITIAL_STYLE } from "./sections.ts";

export const PLUGIN_ID = "aimsun-detector-counts";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeDetectorPlugin({
  id: PLUGIN_ID,
  name: "Aimsun Detector Counts",
  version: PLUGIN_VERSION,
  panelTitle: "Detector counts",
  menuLabel: "Detector counts",
  layerName: "Detector counts (sim vs obs)",
  prefix: "dc_",
  getDb: () => getDuckDbInline(),
  initialStyle: COUNTS_INITIAL_STYLE,
  build: buildCountsSections,
});

export default plugin;
