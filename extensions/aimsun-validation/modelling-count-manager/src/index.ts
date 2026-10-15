/** Combined counts and validation GeoLibre drop-in. */
import { getDuckDbInline } from "../../_shared/src/browser";
import { makeDetectorPlugin, type Env, type ViewMode } from "./common/plugin-host.ts";
import { buildCountsSections, COUNTS_INITIAL_STYLE } from "./sections.ts";
import { buildValidationSections, VALIDATION_INITIAL_STYLE } from "./validation-sections.ts";
import { buildComparisonSections } from "./comparison-sections.ts";

export const PLUGIN_ID = "modelling-count-manager";
export const PLUGIN_VERSION = "0.1.0";

const plugin = makeDetectorPlugin({
  id: PLUGIN_ID,
  name: "Modelling Count Manager",
  version: PLUGIN_VERSION,
  panelTitle: "Modelling Count Manager",
  menuLabel: "Modelling Count Manager",
  layerName: "Detector counts and validation",
  prefix: "mcm_",
  getDb: () => getDuckDbInline(),
  initialStyle: COUNTS_INITIAL_STYLE,
  build: (env: Env, mode: ViewMode) => mode === "validation" ? buildValidationSections(env) : mode === "comparison" ? buildComparisonSections(env) : buildCountsSections(env),
});

// Keep the validation style available to the shared layer manager without creating a second layer.
export { VALIDATION_INITIAL_STYLE };
export default plugin;
