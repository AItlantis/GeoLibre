import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "./build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  id: "aimsun-detector-counts",
  name: "Aimsun Detector Counts",
  description: "Simulated vs observed detector flow from an Aimsun run package: map layer, charts and table (DuckDB-WASM).",
});
