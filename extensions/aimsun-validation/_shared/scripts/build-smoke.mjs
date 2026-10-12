// Bundles src/browser.ts (as a plugin entry would) and checks blob-module hygiene.
import { bundlePlugin } from "./build-lib.mjs";
import { readFileSync, statSync } from "node:fs";
await bundlePlugin({ entry: "src/browser.ts", outfile: "dist/smoke.js" });
const src = readFileSync("dist/smoke.js", "utf8");
const bad = ["import.meta.url", "require(", "new URL(\"./"].filter((p) => src.includes(p));
console.log(`dist/smoke.js ${(statSync("dist/smoke.js").size / 1e6).toFixed(2)} MB; forbidden patterns: ${bad.join(", ") || "none"}`);
if (/^\s*import\s.*from\s*["']/m.test(src)) { console.error("bundle has external static imports"); process.exit(1); }
