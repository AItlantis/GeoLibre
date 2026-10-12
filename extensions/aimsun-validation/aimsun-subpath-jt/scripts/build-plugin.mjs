// Generic drop-in plugin build, used by aimsun-subpath-jt and aimsun-subpath-validation.
//   node build.mjs            -> <repo>/apps/geolibre-desktop/public/plugins/<id>/{plugin.json,dist/index.js,dist/style.css}
// The id/name/version/description come from the plugin's package.json (`geolibre` block), so
// plugin.json, the exported plugin object and the folder name cannot drift apart.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePlugin } from "../../_shared/scripts/build-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_CSS = join(HERE, "..", "src", "common", "base.css");
const MAX_ENTRY_BYTES = 50 * 1024 * 1024; // host MAX_PLUGIN_ASSET_BYTES

export async function buildPlugin(pluginDir, { outRoot } = {}) {
  const pkg = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  const meta = pkg.geolibre;
  const out = join(outRoot ?? resolve(pluginDir, "../../../apps/geolibre-desktop/public/plugins"), meta.id);
  await mkdir(join(out, "dist"), { recursive: true });
  await bundlePlugin({ entry: join(pluginDir, "src/index.ts"), outfile: join(out, "dist/index.js") });

  const own = join(pluginDir, "src/style.css");
  const css = (await readFile(SHARED_CSS, "utf8")) + (existsSync(own) ? "\n" + (await readFile(own, "utf8")) : "");
  await writeFile(join(out, "dist/style.css"), css);

  const manifest = { id: meta.id, name: meta.name, version: pkg.version, description: meta.description, entry: "dist/index.js", style: "dist/style.css" };
  await writeFile(join(out, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Blob-module hygiene + host size limit. (A literal "require(" exists inside duckdb-wasm's node-only worker string; it never runs in a browser.)
  const src = await readFile(join(out, "dist/index.js"), "utf8");
  const bad = ["import.meta.url", 'new URL("./'].filter((p) => src.includes(p));
  if (bad.length) throw new Error(`bundle contains forbidden pattern(s): ${bad.join(", ")}`);
  if (/^\s*import\s.*from\s*["']/m.test(src)) throw new Error("bundle has external static imports");
  if (/\b(left|right)\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) throw new Error("style.css uses physical left/right (use logical properties)");
  const size = (await stat(join(out, "dist/index.js"))).size;
  if (size > MAX_ENTRY_BYTES) throw new Error(`entry is ${size} bytes, over the host limit`);
  console.log(`${meta.id}: ${out}  (index.js ${(size / 1e6).toFixed(2)} MB)`);
  return out;
}
