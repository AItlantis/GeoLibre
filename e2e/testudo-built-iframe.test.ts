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

  let hostProxySawHostAuth = false;
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (pathname === "/test-parent.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><script>window.__testudoReady = null; addEventListener("message", event => { if (event.data?.type === "ready") window.__testudoReady = event.data.payload; });</script><iframe id="app" src="${manifest.base}"></iframe>`);
      return;
    }
    if (pathname === "/host-proxy-artifact") {
      hostProxySawHostAuth = request.headers.authorization === "Bearer host-only-e2e";
      if (!hostProxySawHostAuth) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("host-proxied-artifact-bytes");
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
    const client = await connect(iframe, {
      origin: location.origin,
      timeoutMs: 15_000,
      fetchArtifact: async ({ artifactRef }, signal) => {
        const response = await fetch(`/host-proxy-artifact?ref=${encodeURIComponent(artifactRef)}`, {
          headers: { Authorization: "Bearer host-only-e2e" }, signal,
        });
        if (!response.ok) throw new Error("Host proxy fixture failed.");
        return response.arrayBuffer();
      },
    });
    const initialTViews = await client.testudoGetTViews();
    const created = await client.testudoCreateTView({ tviewId: "built-smoke" });
    const state = await client.testudoGetState({ tviewId: "built-smoke" });
    const iframeWindow = iframe.contentWindow!;
    const childFrame = iframeWindow;
    const artifactResponse = new Promise<{ type: string; payload: { requestId: string; tviewId: string; generation: number; artifactRef: string; bytes: ArrayBuffer } }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Host-proxied artifact response timed out.")), 10_000);
      childFrame.addEventListener("message", function onResponse(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (data?.type !== "testudoArtifactResponse") return;
        childFrame.removeEventListener("message", onResponse);
        window.clearTimeout(timer);
        resolve(data);
      });
    });
    const childChallenge = await pageChallenge();
    iframeWindow.postMessage({
      v: 2, source: "geolibre", type: "testudoStateChanged",
      payload: { tviewId: "built-smoke", generation: 1, status: "loading" },
    }, location.origin);
    iframeWindow.postMessage({
      v: 2, source: "geolibre", type: "testudoArtifactRequest",
      payload: { requestId: "built-iframe-artifact-1", tviewId: "built-smoke", generation: 1,
        artifactRef: "artifacts/manifest.json", challenge: childChallenge },
    }, location.origin);
    const fetchedArtifact = await artifactResponse;
    const artifactText = new TextDecoder().decode(fetchedArtifact.payload.bytes);
    client.disconnect();
    return { initialTViews, created, state, fetchedArtifact, artifactText };

    async function pageChallenge(): Promise<string> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = (window as Window & { __testudoReady?: { challenge?: string } }).__testudoReady;
        if (ready?.challenge) return ready.challenge;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error("Built iframe did not publish its challenge.");
    }
  });

  assert.deepEqual(output.initialTViews, []);
  assert.equal(output.created.tviewId, "built-smoke");
  assert.equal(output.state.tviewId, "built-smoke");
  assert.equal(output.state.status, "empty");
  assert.equal(output.fetchedArtifact.type, "testudoArtifactResponse");
  assert.equal(output.fetchedArtifact.payload.requestId, "built-iframe-artifact-1");
  assert.equal(output.fetchedArtifact.payload.tviewId, "built-smoke");
  assert.equal(output.fetchedArtifact.payload.generation, 1);
  assert.equal(output.fetchedArtifact.payload.artifactRef, "artifacts/manifest.json");
  assert.equal(output.artifactText, "host-proxied-artifact-bytes");
  assert.equal(hostProxySawHostAuth, true);
});
