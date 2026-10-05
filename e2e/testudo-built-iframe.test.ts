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
  // tsx keepNames rewrites serialized page.evaluate callbacks to call this helper.
  await page.addInitScript("window.__name = (fn) => fn;");
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
    const embedClientUrl: string = "/geolibre-native/embed-client.js";
    const { connect } = await import(embedClientUrl);
    const iframe = document.querySelector("#app") as HTMLIFrameElement;
    const proxyMetrics = { fetchCount: 0, sawHostAuth: false };
    const client = await connect(iframe, {
      origin: location.origin,
      timeoutMs: 15_000,
      fetchArtifact: async ({ artifactRef }, signal) => {
        proxyMetrics.fetchCount += 1;
        const response = await fetch(`/host-proxy-artifact?ref=${encodeURIComponent(artifactRef)}`, {
          headers: { Authorization: "Bearer host-only-e2e" }, signal,
        });
        if (!response.ok) throw new Error("Host proxy fixture failed.");
        proxyMetrics.sawHostAuth = true;
        return response.arrayBuffer();
      },
    });
    (window as Window & { __testudoClient?: typeof client; __testudoProxyMetrics?: typeof proxyMetrics }).__testudoClient = client;
    (window as Window & { __testudoProxyMetrics?: typeof proxyMetrics }).__testudoProxyMetrics = proxyMetrics;
    client.on("testudoStateChanged", (state) => {
      if (state.tviewId === "built-smoke" && state.progress) {
        (window as Window & { __testudoProgress?: typeof state.progress }).__testudoProgress = state.progress;
      }
    });
    const initialTViews = await client.testudoGetTViews();
    const created = await client.testudoCreateTView({ tviewId: "built-smoke" });
    const state = await client.testudoGetState({ tviewId: "built-smoke" });
    return { initialTViews, created, state };
  });

  assert.deepEqual(output.initialTViews, []);
  assert.equal(output.created.tviewId, "built-smoke");
  assert.equal(output.state.tviewId, "built-smoke");
  assert.equal(output.state.status, "empty");

  const childFrame = page.frames().find((frame) => frame.url().includes("/geolibre-native/"));
  assert.ok(childFrame, "built Testudo iframe frame is present");
  const challenge = await page.evaluate(() => {
    const ready = (window as Window & { __testudoReady?: { challenge?: string } }).__testudoReady;
    if (!ready?.challenge) throw new Error("Built iframe did not publish its challenge.");
    return ready.challenge;
  });
  await childFrame.evaluate(() => {
    (window as Window & { __testudoArtifactReplies?: unknown[] }).__testudoArtifactReplies = [];
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.data?.type !== "testudoArtifactResponse") return;
      const payload = event.data.payload;
      (window as Window & { __testudoArtifactReplies?: unknown[] }).__testudoArtifactReplies?.push({
        requestId: payload.requestId,
        tviewId: payload.tviewId,
        generation: payload.generation,
        artifactRef: payload.artifactRef,
        artifactText: payload.bytes instanceof ArrayBuffer ? new TextDecoder().decode(payload.bytes) : null,
      });
    });
  });

  // Send a state event through the built iframe's real window message channel.
  // The host client must surface the loader progress and advance this TView's
  // generation before it will accept artifact requests for that generation.
  await childFrame.evaluate(() => window.parent.postMessage({
    v: 2,
    source: "geolibre",
    type: "testudoStateChanged",
    payload: {
      tviewId: "built-smoke",
      generation: 2,
      status: "loading",
      progress: { label: "Fetching package", value: 0.5, loaded: 5, total: 10 },
    },
  }, location.origin));
  await page.waitForFunction(() => {
    const progress = (window as Window & { __testudoProgress?: { loaded?: number; total?: number } }).__testudoProgress;
    return progress?.loaded === 5 && progress.total === 10;
  });

  await childFrame.evaluate((currentChallenge) => {
    window.parent.postMessage({
      v: 2, source: "geolibre", type: "testudoArtifactRequest",
      payload: { requestId: "built-iframe-stale", tviewId: "built-smoke", generation: 1,
        artifactRef: "artifacts/manifest.json", challenge: currentChallenge },
    }, location.origin);
    window.parent.postMessage({
      v: 2, source: "geolibre", type: "testudoArtifactRequest",
      payload: { requestId: "built-iframe-credential", tviewId: "built-smoke", generation: 2,
        artifactRef: "artifacts/manifest.json", challenge: currentChallenge, authorization: "fixture-only-rejected" },
    }, location.origin);
  }, challenge);
  await page.waitForTimeout(50);
  const rejectedMetrics = await page.evaluate(() => ({
    fetchCount: (window as Window & { __testudoProxyMetrics?: { fetchCount: number } }).__testudoProxyMetrics?.fetchCount,
    replies: (window.frames[0] as Window & { __testudoArtifactReplies?: unknown[] }).__testudoArtifactReplies?.length,
  }));
  assert.deepEqual(rejectedMetrics, { fetchCount: 0, replies: 0 });

  await childFrame.evaluate((currentChallenge) => window.parent.postMessage({
    v: 2, source: "geolibre", type: "testudoArtifactRequest",
    payload: { requestId: "built-iframe-artifact-1", tviewId: "built-smoke", generation: 2,
      artifactRef: "artifacts/manifest.json", challenge: currentChallenge },
  }, location.origin), challenge);
  await childFrame.waitForFunction(() =>
    ((window as Window & { __testudoArtifactReplies?: unknown[] }).__testudoArtifactReplies?.length ?? 0) === 1,
  );
  const fetchedArtifact = await childFrame.evaluate(() =>
    (window as Window & { __testudoArtifactReplies?: Array<Record<string, unknown>> }).__testudoArtifactReplies?.[0],
  );
  const proxyMetrics = await page.evaluate(() =>
    (window as Window & { __testudoProxyMetrics?: { fetchCount: number; sawHostAuth: boolean } }).__testudoProxyMetrics,
  );
  assert.deepEqual(fetchedArtifact, {
    requestId: "built-iframe-artifact-1",
    tviewId: "built-smoke",
    generation: 2,
    artifactRef: "artifacts/manifest.json",
    artifactText: "host-proxied-artifact-bytes",
  });
  assert.deepEqual(proxyMetrics, { fetchCount: 1, sawHostAuth: true });
  assert.equal(hostProxySawHostAuth, true);

  await page.evaluate(() =>
    (window as Window & { __testudoClient?: { disconnect(): void } }).__testudoClient?.disconnect(),
  );
});
