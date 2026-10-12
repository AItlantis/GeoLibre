import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "../_od/build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  id: "aimsun-od-diff",
  name: "Aimsun OD Differences",
  description: "OD adjustment differences: top gains/losses, deviation bands, net production/attraction change map and group deviation table, DuckDB-WASM.",
});
