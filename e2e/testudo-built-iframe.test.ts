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
  let proxiedArtifactCount = 0;
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (pathname === "/test-parent.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><script>window.__testudoReady = null; addEventListener("message", event => { if (event.data?.type === "ready") window.__testudoReady = event.data.payload; });</script><iframe id="app" src="${manifest.base}"></iframe>`);
      return;
    }
    if (pathname === "/host-proxy-artifact") {
      hostProxySawHostAuth = request.headers.authorization === "Bearer host-only-e2e";
      proxiedArtifactCount += 1;
      if (!hostProxySawHostAuth) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        dt: 0.5, n_ticks: 10, scenarios: [{ scid: 7, name: "Fixture" }, { scid: 8, name: "Proposal" }],
        kpiTimeSeries: { flow: Array.from({ length: 10 }, (_, tick) => 100 + tick) },
        emissionsTimeSeries: { h3a: Array.from({ length: 10 }, (_, tick) => 20 + tick) },
        comparisonTimeSeries: {
          "7": Array.from({ length: 10 }, (_, tick) => ({ flow: 100 + tick })),
          "8": Array.from({ length: 10 }, (_, tick) => ({ flow: 90 + tick })),
        },
      }));
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
    const artifactRelays: Array<Record<string, unknown>> = [];
    window.addEventListener("message", (event) => {
      if (event.source !== (document.querySelector("#app") as HTMLIFrameElement).contentWindow
        || event.data?.type !== "testudoArtifactRequest") return;
      artifactRelays.push(event.data.payload as Record<string, unknown>);
    });
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
    const loaded = await client.testudoLoadPackage({
      tviewId: "built-smoke",
      bootstrap: {
        packageId: "fixture/vehicle-playback",
        versionId: "fixture-v1",
        label: "Playback fixture",
        origin: "published",
        manifestPath: "manifest.json",
        nativeManifestPath: "manifest.json",
        artifactEndpoint: "/package/fixture-v1/",
        capabilities: ["vehicle-playback", "network-kpi", "emissions-h3", "scenario-comparison"].map((id) => ({ id, available: true })),
        presets: [],
      },
      selectedPlugin: "vehicle-playback",
    });
    const generation = loaded.generation;
    const scenario = await client.testudoSetScenario({ tviewId: "built-smoke", scenarioId: "7" });
    const playing = await client.testudoSetPlaybackPlaying({ tviewId: "built-smoke", playing: true, generation });
    await client.testudoSetPlaybackSpeed({ tviewId: "built-smoke", speed: 2, generation });
    const sought = await client.testudoSeekPlayback({ tviewId: "built-smoke", tick: 6, generation });
    await client.testudoSetPlugin({ tviewId: "built-smoke", id: "network-kpi" });
    const networkClock = await client.testudoGetPlaybackState({ tviewId: "built-smoke", generation });
    await client.testudoSetPlugin({ tviewId: "built-smoke", id: "emissions-h3" });
    const environmentClock = await client.testudoGetPlaybackState({ tviewId: "built-smoke", generation });
    await client.testudoSetPlugin({ tviewId: "built-smoke", id: "scenario-comparison" });
    const comparisonClock = await client.testudoGetPlaybackState({ tviewId: "built-smoke", generation });
    let staleSeekError: string | undefined;
    try {
      await client.testudoSeekPlayback({ tviewId: "built-smoke", tick: 1, generation: generation + 1 });
    } catch (error) {
      staleSeekError = error instanceof Error ? error.message : String(error);
    }
    await client.testudoSetPlugin({ tviewId: "built-smoke", id: "vehicle-playback" });
    const vehicleClock = await client.testudoGetPlaybackState({ tviewId: "built-smoke", generation });
    const paused = await client.testudoSetPlaybackPlaying({ tviewId: "built-smoke", playing: false, generation });
    const playbackState = await client.testudoGetPlaybackState({ tviewId: "built-smoke", generation });
    return { initialTViews, created, state, loaded, scenario, playing, paused, sought, networkClock, environmentClock, comparisonClock, vehicleClock, staleSeekError, playbackState, proxyMetrics, artifactRelays };
  });

  assert.deepEqual(output.initialTViews, []);
  assert.equal(output.created.tviewId, "built-smoke");
  assert.equal(output.state.tviewId, "built-smoke");
  assert.equal(output.state.status, "empty");
  assert.equal(output.loaded.status, "ready");
  assert.equal(output.loaded.generation, 1);
  assert.equal(output.scenario.id, "7");
  assert.equal(output.playing.playing, true);
  assert.equal(output.paused.playing, false);
  assert.equal(output.sought.tick, 6);
  for (const [clock, capability] of [
    [output.networkClock, "network-kpi"],
    [output.environmentClock, "emissions-h3"],
    [output.comparisonClock, "scenario-comparison"],
    [output.vehicleClock, "vehicle-playback"],
  ] as const) {
    assert.equal(clock.tick, 6);
    assert.equal(clock.playing, false); // seek pauses the shared clock; capability switches must preserve that state
    assert.equal(clock.speed, 2);
    assert.equal(clock.activeCapability, capability);
    assert.equal(clock.tickFollowers?.length, 4);
  }
  assert.match(output.staleSeekError ?? "", /stale/i);
  assert.equal(output.playbackState.tick, 6);
  assert.equal(output.playbackState.maxTick, 9);
  assert.deepEqual(output.proxyMetrics, { fetchCount: 1, sawHostAuth: true });
  assert.equal(output.artifactRelays.length, 1);
  assert.deepEqual(Object.keys(output.artifactRelays[0] ?? {}).sort(), [
    "artifactRef", "challenge", "generation", "requestId", "tviewId",
  ]);
  assert.equal(output.artifactRelays[0]?.tviewId, "built-smoke");
  assert.equal(output.artifactRelays[0]?.generation, output.loaded.generation);
  assert.equal(proxiedArtifactCount, 1);
  assert.equal(hostProxySawHostAuth, true);

  const childFrame = page.frames().find((frame) => frame.url().includes("/geolibre-native/"));
  assert.ok(childFrame, "built Testudo iframe frame is present");
  await page.evaluate(() =>
    (window as Window & { __testudoClient?: { disconnect(): void } }).__testudoClient?.disconnect(),
  );
});
