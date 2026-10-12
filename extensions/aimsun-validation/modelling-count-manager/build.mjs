import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "./build-helper.mjs";

await buildDropIn({
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  description: "Simulated and observed detector counts and model validation from an Aimsun run package.",
});
