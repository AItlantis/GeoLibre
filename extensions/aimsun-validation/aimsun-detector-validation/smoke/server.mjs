// Static server for the plugin smoke. Mirrors how GeoLibre serves a drop-in:
//   /plugins/**  -> apps/geolibre-desktop/public/plugins/**   (plugin.json, dist/, _shared/duckdb/duckdb-eh.wasm)
//   /data/**     -> $AIMSUN_DATA_DIR (required; the smoke is skipped when unset)
//   /smoke/**    -> this folder
// CSP modelled on tauri.conf.json (script-src blob: 'wasm-unsafe-eval', worker-src blob: 'self').
// /data/manifest_geo.json is synthesised from manifest_tabular.json plus <run>/detectors.geojson
// entries, so both the degraded (no geometry) and the full path can be exercised.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS = resolve(here, "..", "..", "..", "..", "apps", "geolibre-desktop", "public", "plugins");
const DATA = process.env.AIMSUN_DATA_DIR ?? "";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".geojson": "application/geo+json" };
const CSP = "default-src 'self'; connect-src 'self' blob: https: data:; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob: 'self'; style-src 'self' 'unsafe-inline'";

function safeJoin(root, rel) {
  const p = normalize(decodeURIComponent(rel)).replace(/^[\\/]+/, "");
  if (p.split(/[\\/]/).includes("..")) return null;
  return join(root, p);
}

async function geoManifest() {
  const m = JSON.parse(await readFile(join(DATA, "manifest_tabular.json"), "utf8"));
  const files = (m.runs ?? [])
    .filter((r) => r.available !== false && existsSync(join(DATA, r.run, "detectors.geojson")))
    .map((r) => ({ table: "detectors_geo", run: r.run, path: `${r.run}/detectors.geojson` }));
  return JSON.stringify({ ...m, files });
}

export function start(port = 0) {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let file = null;
      if (url.pathname === "/data/manifest_geo.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await geoManifest());
        return;
      }
      if (url.pathname.startsWith("/plugins/")) file = safeJoin(PLUGINS, url.pathname.slice("/plugins/".length));
      else if (url.pathname.startsWith("/data/")) file = safeJoin(DATA, url.pathname.slice("/data/".length));
      else if (url.pathname.startsWith("/smoke/")) file = safeJoin(here, url.pathname.slice("/smoke/".length));
      if (!file) throw new Error("nf");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("nf");
    }
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}
