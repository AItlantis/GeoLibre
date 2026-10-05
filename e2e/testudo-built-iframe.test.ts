import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { after, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

const artifactRoot = resolve("apps/geolibre-desktop/dist-testudo");
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
let port = 0;

const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function openParent(): Promise<Page> {
  if (!browser) throw new Error("Test browser is not running.");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/test-parent.html`);
  return page;
}

after(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()) ?? done());
});

it("round-trips commands through the exact built Testudo iframe and embed client", async () => {
  const manifest = JSON.parse(readFileSync(resolve(artifactRoot, "testudo-build-manifest.json"), "utf8")) as {
    schemaVersion: number;
    base: string;
    files: Record<string, string>;
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.base, "/geolibre-native/");
  assert.ok(manifest.files["index.html"]);
  assert.ok(manifest.files["embed-client.js"]);

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (pathname === "/test-parent.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><iframe id="app" src="${manifest.base}"></iframe>`);
      return;
    }
    if (pathname === `${manifest.base}geolibre-runtime-config.js`) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("window.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_EMBED_ORIGINS: location.origin };");
      return;
    }
    let filePath = resolve(artifactRoot, `.${pathname.slice(manifest.base.length - 1)}`);
    if (pathname === manifest.base || pathname === `${manifest.base}index.html`) {
      filePath = resolve(artifactRoot, "index.html");
    }
    if (!filePath.startsWith(`${artifactRoot}${sep}`) || !statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
    response.end(readFileSync(filePath));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });

  const page = await openParent();
  page.on("pageerror", (error) => process.stderr.write(`[built-iframe page error] ${error.message}\n`));
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`[built-iframe console] ${message.text()}\n`);
  });
  const output = await page.evaluate(async () => {
    const { connect } = await import("/geolibre-native/embed-client.js");
    const iframe = document.querySelector("#app") as HTMLIFrameElement;
    const client = await connect(iframe, { origin: location.origin, timeoutMs: 15_000 });
    const initialTViews = await client.testudoGetTViews();
    const created = await client.testudoCreateTView({ tviewId: "built-smoke" });
    const state = await client.testudoGetState({ tviewId: "built-smoke" });
    client.disconnect();
    return { initialTViews, created, state };
  });

  assert.deepEqual(output.initialTViews, []);
  assert.equal(output.created.tviewId, "built-smoke");
  assert.equal(output.state.tviewId, "built-smoke");
  assert.equal(output.state.status, "empty");
});
