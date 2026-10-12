/**
 * aimsun-detector-validation: GEH / RMSE / R2 validation of simulated vs observed detector flow.
 * Entry of the drop-in bundle: default-exports a GeoLibrePlugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeDetectorPlugin } from "../../aimsun-detector-counts/src/common/plugin-host.ts";
import { buildValidationSections, VALIDATION_INITIAL_STYLE } from "./sections.ts";

export const PLUGIN_ID = "aimsun-detector-validation";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeDetectorPlugin({
  id: PLUGIN_ID,
  name: "Aimsun Detector Validation",
  version: PLUGIN_VERSION,
  panelTitle: "Detector validation",
  menuLabel: "Detector validation",
  layerName: "Detector validation (GEH status)",
  prefix: "dv_",
  getDb: () => getDuckDbInline(),
  initialStyle: VALIDATION_INITIAL_STYLE,
  build: buildValidationSections,
});

export default plugin;
