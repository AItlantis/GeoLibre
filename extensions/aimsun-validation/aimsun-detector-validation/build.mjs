import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "../aimsun-detector-counts/build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  id: "aimsun-detector-validation",
  name: "Aimsun Detector Validation",
  description: "GEH, RMSE, R2 and trendline validation of simulated vs observed detector flow from an Aimsun run package (DuckDB-WASM).",
});
