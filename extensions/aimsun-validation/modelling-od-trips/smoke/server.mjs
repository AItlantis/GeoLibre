// Static server for the OD smoke: / = apps/geolibre-desktop/public (plugins + wasm, like the app), /data/ = real data folder,
// /smoke/ = this folder. Supports HEAD and Range (DuckDB-WASM reads parquet by byte ranges), CSP modelled on tauri.conf.json.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "..", "..", "..", "apps", "geolibre-desktop", "public");
const dataDir = process.env.AIMSUN_DATA_DIR; // no default: the /data/ route is disabled when unset
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".geojson": "application/geo+json", ".parquet": "application/octet-stream" };
const CSP = "default-src 'self'; connect-src 'self' blob: https: data:; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob: 'self'; style-src 'self' 'unsafe-inline'";

function resolvePath(urlPath) {
  const p = normalize(decodeURIComponent(urlPath)).replace(/\\/g, "/");
  if (p.includes("..")) return null;
  if (p.startsWith("/data/")) return dataDir ? join(dataDir, p.slice(6)) : null;
  if (p === "/od-smoke.html") return join(here, "index.html");
  if (p.startsWith("/smoke/")) return join(here, p.slice(7));
  return join(publicDir, p);
}

export function start(port = 0) {
  const s = createServer((req, res) => {
    try {
      const file = resolvePath(new URL(req.url, "http://x").pathname);
      const st = file && statSync(file, { throwIfNoEntry: false });
      if (!st || !st.isFile()) {
        res.writeHead(404);
        return res.end("not found");
      }
      const headers = { "content-type": types[extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes", "content-security-policy": CSP, "cache-control": "no-cache" };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        let a = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
        let b = range[1] === "" || range[2] === "" ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
        if (a > b || a >= st.size) {
          res.writeHead(416, { "content-range": `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${st.size}`, "content-length": b - a + 1 });
        return req.method === "HEAD" ? res.end() : createReadStream(file, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, { ...headers, "content-length": st.size });
      if (req.method === "HEAD") return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}
