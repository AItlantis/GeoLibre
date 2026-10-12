import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "./scripts/build-plugin.mjs";
await buildPlugin(dirname(fileURLToPath(import.meta.url)));
