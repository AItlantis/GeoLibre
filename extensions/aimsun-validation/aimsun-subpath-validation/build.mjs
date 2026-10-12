import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../aimsun-subpath-jt/scripts/build-plugin.mjs";
await buildPlugin(dirname(fileURLToPath(import.meta.url)));
