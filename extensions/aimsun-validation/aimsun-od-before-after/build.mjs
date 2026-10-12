import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "../_od/build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  id: "aimsun-od-before-after",
  name: "Aimsun OD Before/After",
  description: "Group x group OD matrices before and after adjustment, totals per group and a before-vs-after scatter, DuckDB-WASM.",
});
