// Shared esbuild helper for plugin bundles.
//   import { bundlePlugin } from "../_shared/scripts/build-lib.mjs";
//   await bundlePlugin({ entry: "src/index.ts", outfile: "dist/index.js" });
// Produces ONE self-contained ES module (no splitting, no external imports, no import.meta.url
// use) suitable for GeoLibre's fetch -> Blob -> import(blobUrl) loader. The DuckDB worker
// script is inlined as a string. The wasm is NOT inlined; copy it with copyDuckDbWasm().
import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const duckdbDist = () => dirname(require.resolve("@duckdb/duckdb-wasm"));

export const duckdbWorkerTextPlugin = {
  name: "duckdb-worker-text",
  setup(b) {
    b.onResolve({ filter: /^virtual:duckdb-eh-worker-text$/ }, () => ({ path: "duckdb-eh-worker-text", namespace: "duckdb-worker" }));
    b.onLoad({ filter: /.*/, namespace: "duckdb-worker" }, async () => ({
      contents: await readFile(join(duckdbDist(), "duckdb-browser-eh.worker.js"), "utf8"),
      loader: "text",
    }));
  },
};

export async function bundlePlugin({ entry, outfile, minify = true, define = {} }) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify,
    sourcemap: false,
    splitting: false,
    legalComments: "none",
    plugins: [duckdbWorkerTextPlugin],
    define,
    logLevel: "info",
  });
}

/** Copy duckdb-eh.wasm to <publicPluginsDir>/_shared/duckdb/ (served same-origin, shared by all plugins). */
export async function copyDuckDbWasm(publicPluginsDir) {
  const out = join(publicPluginsDir, "_shared", "duckdb");
  await mkdir(out, { recursive: true });
  await copyFile(join(duckdbDist(), "duckdb-eh.wasm"), join(out, "duckdb-eh.wasm"));
  return join(out, "duckdb-eh.wasm");
}
