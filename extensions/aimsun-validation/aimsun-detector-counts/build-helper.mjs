// Shared build step for the two detector plugins (the validation plugin imports this file).
// Emits apps/geolibre-desktop/public/plugins/<id>/{plugin.json,dist/index.js,dist/style.css}
// and makes sure the shared DuckDB wasm sits at public/plugins/_shared/duckdb/duckdb-eh.wasm.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePlugin, copyDuckDbWasm } from "../_shared/scripts/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");
export const publicPlugins = join(repoRoot, "apps", "geolibre-desktop", "public", "plugins");
export const commonCss = join(here, "src", "common", "style.css");

export async function buildDropIn({ pluginDir, id, name, description, extraCss = [] }) {
  const pkg = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  const out = join(publicPlugins, id);
  await mkdir(join(out, "dist"), { recursive: true });
  await bundlePlugin({ entry: join(pluginDir, "src", "index.ts"), outfile: join(out, "dist", "index.js") });
  const css = [commonCss, ...extraCss].map((f) => readFile(f, "utf8"));
  await writeFile(join(out, "dist", "style.css"), (await Promise.all(css)).join("\n"), "utf8");
  const manifest = { id, name, version: pkg.version, description, entry: "dist/index.js", style: "dist/style.css", engines: ["maplibre"] };
  await writeFile(join(out, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  // copy the 36 MB wasm only when missing or a different size (idempotent, cheap re-builds)
  const wasm = join(publicPlugins, "_shared", "duckdb", "duckdb-eh.wasm");
  let have = false;
  try {
    have = (await stat(wasm)).size > 1_000_000;
  } catch {
    /* absent */
  }
  if (!have) await copyDuckDbWasm(publicPlugins);
  const size = (await stat(join(out, "dist", "index.js"))).size;
  console.log(`${id}: dist/index.js ${(size / 1e6).toFixed(2)} MB -> ${out}`);
  return out;
}
