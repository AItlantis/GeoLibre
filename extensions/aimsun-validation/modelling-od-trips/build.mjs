import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDropIn } from "./build-helper.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./package.json", import.meta.url), "utf8"));
await buildDropIn({ pluginDir: dir, id: pkg.name, name: "Modelling OD Trips", description: "Aimsun OD trips, before/after adjustment and difference analysis in one DuckDB-WASM plugin." });
