// Serves smoke/ + dist/ with a CSP modelled on tauri.conf.json (script-src blob: 'wasm-unsafe-eval', worker-src blob: 'self').
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".mjs": "text/javascript" };
const CSP = "default-src 'self'; connect-src 'self' blob: https: data:; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob: 'self'; style-src 'self' 'unsafe-inline'";
export function start(port = 0) {
  const s = createServer(async (req, res) => {
    try {
      const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\/]+/, "");
      const body = await readFile(join(root, p));
      res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream", "content-security-policy": CSP });
      res.end(body);
    } catch { res.writeHead(404); res.end("nf"); }
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}
if (process.argv[1] === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\") || process.argv[2] === "serve") {
  const s = await start(Number(process.argv[3] ?? 8799));
  console.log("http://127.0.0.1:" + s.address().port + "/smoke/index.html");
}
