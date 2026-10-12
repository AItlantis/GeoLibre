// Static server for the plugin smoke tests, with a CSP modelled on apps/geolibre-desktop/src-tauri/tauri.conf.json
// (the same one _shared/smoke/server.mjs uses: script-src blob: 'wasm-unsafe-eval', worker-src blob: 'self').
//   /plugins/**         -> apps/geolibre-desktop/public/plugins/** (the BUILT plugins, as the app serves them)
//   /plugins/_shared/duckdb/duckdb-eh.wasm -> falls back to the npm package when the deployer has not copied it
//   /smoke/**           -> the jt/smoke folder (harness) and any extra roots given in `roots`
//   /pkg/<name>/<file>  -> package files; /pkg/<name>/manifest.json is the static manifest of the first dir that has one,
//                          else generated from the explicit `files` list ({table, file})
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PUBLIC_PLUGINS = resolve(HERE, "../../../../apps/geolibre-desktop/public/plugins");
const SHARED = resolve(HERE, "../../_shared");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".wasm": "application/wasm", ".parquet": "application/octet-stream" };
const CSP =
  "default-src 'self'; connect-src 'self' blob: https: data:; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob: 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";

const exists = (p) => stat(p).then((s) => s.isFile(), () => false);

/**
 * @param {{ roots?: string[], packages?: Record<string, { dir?: string, files?: Array<{ table: string, file: string }>, run?: string }> }} cfg
 */
export function start(cfg = {}, port = 0) {
  const roots = [HERE, ...(cfg.roots ?? [])];
  const server = createServer(async (req, res) => {
    const send = (code, body, type = "text/plain") => {
      res.writeHead(code, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/\\/g, "/").replace(/^\/+/, "");
      if (path.includes("..")) return send(400, "bad path");
      if (path === "favicon.ico") return send(204, "");
      if (path.startsWith("plugins/")) {
        let file = join(PUBLIC_PLUGINS, path.slice("plugins/".length));
        if (!(await exists(file)) && path.endsWith("_shared/duckdb/duckdb-eh.wasm")) file = join(SHARED, "node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm");
        return send(200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
      if (path.startsWith("pkg/")) {
        const [, name, ...rest] = path.split("/");
        const p = cfg.packages?.[name];
        if (!p) return send(404, "no such package");
        const rel = rest.join("/");
        if (rel === "manifest.json") {
          if (p.dir && (await exists(join(p.dir, "manifest.json")))) return send(200, await readFile(join(p.dir, "manifest.json")), "application/json");
          const files = (p.files ?? []).map((f) => ({ table: f.table, path: f.as ?? basename(f.file) }));
          return send(200, JSON.stringify({ schema_version: 1, run: p.run ?? name, files }), "application/json");
        }
        const hit = (p.files ?? []).find((f) => (f.as ?? basename(f.file)) === rel);
        const file = hit ? hit.file : p.dir ? join(p.dir, rel) : null;
        if (!file) return send(404, "nf");
        return send(200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
      const rel = path.startsWith("smoke/") ? path.slice("smoke/".length) : path;
      for (const r of roots) {
        const file = join(r, rel);
        if (await exists(file)) return send(200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
      return send(404, "nf");
    } catch (e) {
      return send(404, String(e?.message ?? e));
    }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
