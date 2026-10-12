import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "../_od/build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  id: "aimsun-trips",
  name: "Aimsun Trips (OD desire lines)",
  description: "OD desire lines, top pairs and straight-line trip-length distribution for an Aimsun run (before or after adjustment), DuckDB-WASM.",
});
