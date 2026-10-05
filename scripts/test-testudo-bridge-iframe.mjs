import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

const baseUrl = process.env.TESTUDO_IFRAME_BASE_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-gpu", "--use-gl=swiftshader", "--no-sandbox"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/geolibre-runtime-config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_EMBED_ORIGINS: ${JSON.stringify(new URL(baseUrl).origin)}, VITE_TESTUDO_BYTE_ORIGINS: "https://bytes.testudo.live" };`,
  }));
  const chatRequests = [];
  const descriptorRequests = [];
  const byteRequests = [];
  const bytePreflights = [];
  const byteCorsResponses = [];
  const answerChat = async (route) => {
    chatRequests.push({
      url: new URL(route.request().url()).pathname,
      method: route.request().method(),
      authorization: route.request().headers().authorization,
      body: route.request().postDataJSON(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "The selected route shows a longer journey time.",
        ai_available: true,
        scenario_analysis: {
          scenario: { scenario_id: "plan-1", name: "Plan" },
          subpath_impact: {
            comparable_interval_count: 1,
            expected_baseline_comparisons: 1,
            baseline_comparison_coverage: 1,
            paths: [{ origin: 1, destination: 2, section_ids: [10], journey_times: [{
              interval_id: "current-1", baseline_interval_id: "base-1", time_window: "AM",
              current: { journey_time: 12, count: 2 }, baseline: { journey_time: 8, count: 2 },
              delta: 4, percentage_delta: 50, comparable: true, raw_table: "private raw table",
            }] }],
          },
          od_evidence: { status: "available", metric: "journey_time", capabilities: { od_journey_time: true } },
        },
        ollaya: { status: "matched", intent: "scenario_comparison", matched: true, private_trace: "must not cross" },
      }),
    });
  };
  await page.route("**/api/public/demo/geoai-chat", answerChat);
  await page.route("**/api/v1/ai/chat", answerChat);
  const compressedChunk = gzipSync(Buffer.from(JSON.stringify({ events: { "1": [{ event: "spawn", id: 40, state: { WorldX: -0.12, WorldY: 51.5 } }] } })));
  const packageDocuments = {
    "manifest.json": {
      schema: "testudo-package",
      metadata: { dt: 1, n_ticks: 12 },
      chunks: [{ index: 0, path: "chunks/0.json.gz", start_tick: 0, end_tick: 12, compressed_size_bytes: compressedChunk.byteLength }],
    },
    "geolibre/package.json": {
      schemaVersion: "geolibre.package.v1",
      capabilities: { animation: { state: "available" }, results: { state: "available" }, paths: { state: "available" } },
      scenarios: [
        { scid: 1, name: "Baseline", replications: [{ did: 11 }] },
        { scid: 2, name: "Roadworks North", replications: [{ did: 22 }] },
      ],
    },
    "chunks/0.json.gz": compressedChunk,
  };
  const descriptorId = { "manifest.json": "manifest", "geolibre/package.json": "native", "chunks/0.json.gz": "chunk" };
  await page.route("**/api/v1/view/*/artifact/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.split("/artifact/")[1]);
    descriptorRequests.push({ path, authorization: request.headers().authorization, origin: request.headers().origin });
    const id = descriptorId[path];
    if (!id) return route.fulfill({ status: 404, body: "missing" });
    const signed = !request.headers().authorization?.startsWith("Testudo-Embed ");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ url: `https://bytes.testudo.live/artifact-bytes/${id}${signed ? "?token=signed" : ""}`, expires_at: Math.floor(Date.now() / 1000) + 60 }),
    });
  });
  await page.route("https://bytes.testudo.live/artifact-bytes/**", async (route) => {
    const request = route.request();
    const origin = request.headers().origin;
    if (request.method() === "OPTIONS") {
      bytePreflights.push({ origin, requestHeaders: request.headers()["access-control-request-headers"] });
      return route.fulfill({ status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization",
        "Access-Control-Max-Age": "600",
      } });
    }
    const url = new URL(request.url());
    byteRequests.push({ path: url.pathname, search: url.search, authorization: request.headers().authorization, origin });
    const id = url.pathname.split("/").at(-1);
    const body = id === "chunk" ? packageDocuments["chunks/0.json.gz"] : JSON.stringify(packageDocuments[id === "native" ? "geolibre/package.json" : "manifest.json"]);
    byteCorsResponses.push({ origin, allowOrigin: origin });
    await route.fulfill({ status: 200, contentType: id === "chunk" ? "application/gzip" : "application/json", headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "Content-Length",
      "Content-Length": String(Buffer.byteLength(body)),
      "Cache-Control": "private, no-store",
    }, body });
  });
  await page.addInitScript((origin) => {
    window.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_EMBED_ORIGINS: origin, VITE_TESTUDO_BYTE_ORIGINS: "https://bytes.testudo.live" };
  }, new URL(baseUrl).origin);
  await page.route("**/testudo-harness", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8"><title>Testudo plugin iframe smoke</title>
      <iframe id="viewer" src="/"></iframe>
      <script>
        window.bridge = { pluginChallenge: null, coreChallenge: null, pending: new Map(), corePending: new Map(), nextId: 1, updates: [], playbackUpdates: [], progressUpdates: [], scenarioUpdates: [] };
        window.addEventListener("message", event => {
          if (event.source !== document.querySelector("#viewer").contentWindow) return;
          if (event.data?.source === "geolibre") {
            if (event.data.type === "ready") { window.bridge.coreChallenge = event.data.payload.challenge; return; }
            if (event.data.type === "ack") {
              const waiter = window.bridge.corePending.get(event.data.payload.requestId);
              if (waiter) { window.bridge.corePending.delete(event.data.payload.requestId); waiter(event.data.payload); }
            }
            return;
          }
          if (event.data?.source !== "geolibre-testudo-plugin") return;
          if (event.data.type === "ready") { window.bridge.pluginChallenge = event.data.payload.challenge; return; }
          if (event.data.type === "testudoGeoAiInvestigationUpdate") { window.bridge.updates.push(event.data.payload); return; }
          if (event.data.type === "testudoPlaybackChanged") { window.bridge.playbackUpdates.push(event.data.payload); return; }
          if (event.data.type === "testudoProgressChanged") { window.bridge.progressUpdates.push(event.data.payload); return; }
          if (event.data.type === "testudoScenarioChanged") { window.bridge.scenarioUpdates.push(event.data.payload); return; }
          if (event.data.type === "ack") {
            const waiter = window.bridge.pending.get(event.data.payload.requestId);
            if (waiter) { window.bridge.pending.delete(event.data.payload.requestId); waiter(event.data.payload); }
          }
        });
        window.sendBridge = (type, payload = {}) => new Promise((resolve, reject) => {
          const requestId = String(window.bridge.nextId++);
          const timer = setTimeout(() => reject(new Error("Bridge acknowledgement timed out: " + type)), 10000);
          window.bridge.pending.set(requestId, result => { clearTimeout(timer); resolve(result); });
          if (requestId === "1") {
            const frame = document.querySelector("#viewer").contentWindow;
            window.dispatchEvent(new MessageEvent("message", {
              data: { v: 2, source: "geolibre", type: "ack", payload: { requestId, ok: true, result: { core: true } } },
              origin: location.origin, source: frame,
            }));
          }
          document.querySelector("#viewer").contentWindow.postMessage({
            v: 2, source: "testudo-geolibre-plugin", type, requestId,
            payload: { ...payload, challenge: window.bridge.pluginChallenge },
          }, location.origin);
        });
      </script>`,
  }));
  await page.goto(`${baseUrl}/testudo-harness`);
  await page.waitForFunction(() => window.bridge.pluginChallenge !== null, null, { timeout: 90_000 });
  await page.evaluate(() => {
    const frame = document.querySelector("#viewer").contentWindow;
    window.bridge.corePending.set("1", (message) => { window.bridge.coreAck = message; });
    window.dispatchEvent(new MessageEvent("message", {
      data: { v: 2, source: "geolibre", type: "ready", payload: { version: "embed-v1", challenge: "c".repeat(32) } },
      origin: location.origin, source: frame,
    }));
  });
  assert.equal(await page.evaluate(() => window.bridge.coreChallenge), "c".repeat(32));
  assert.match(await page.evaluate(() => window.bridge.pluginChallenge), /^[a-f0-9]{32}$/);
  assert.notEqual(await page.evaluate(() => window.bridge.pluginChallenge), "c".repeat(32));
  const send = (type, payload) => page.evaluate(([command, data]) => window.sendBridge(command, data), [type, payload]);

  const camera = await send("testudoSetCamera", { center: [12.5, 41.9], zoom: 7, bearing: 15, pitch: 20 });
  assert.equal(camera.ok, true, JSON.stringify(camera));
  assert.equal((await page.evaluate(() => window.bridge.coreAck)).result.core, true);
  assert.deepEqual(camera.result.center, [12.5, 41.9]);
  assert.equal(camera.result.zoom, 7);
  assert.equal(camera.result.bearing, 15);
  assert.equal(camera.result.pitch, 20);
  const control = await send("testudoSetBuiltInMapControl", { control: "navigation", visible: true });
  assert.deepEqual(control.result, { control: "navigation", visible: true });
  const state = await send("testudoGetState");
  assert.equal(state.result.capabilities.camera, true);
  assert.equal(state.result.capabilities.mapControls, true);
  assert.equal(state.result.capabilities.playback, false);
  assert.equal(state.result.capabilities.measuredProgress, false);
  assert.equal((await send("testudoGetPlaybackState")).result.available, false);
  assert.equal((await send("testudoGetProgressState")).result.available, false);
  const unavailablePlayback = await send("testudoSetPlaybackPlaying", { playing: true });
  assert.equal(unavailablePlayback.ok, false);
  assert.match(unavailablePlayback.error, /no active plugin provides package-backed playback/);
  const guestToken = "g".repeat(48);
  assert.equal((await send("testudoSetGuestCapability", {
    protocol: 1, guestEmbedToken: guestToken, expiresAt: Date.now() + 60_000,
    packageId: "London/testudo-package-2026-09-24-website-demo-v1", packageVersionId: "32787055-7258-45f0-8593-f8c53e1cc788",
  })).ok, true);
  const geoAiStatus = await send("testudoGetGeoAiStatus");
  assert.equal(geoAiStatus.result.configured, true);
  assert.equal(geoAiStatus.result.providerReady, null);
  const opened = await send("testudoOpenGeoAiChat", { open: true });
  assert.equal(opened.ok, true);
  assert.equal(opened.result.open, true);
  const frame = page.frameLocator("#viewer");
  await frame.getByRole("textbox", { name: "Ask Testudo GeoAI" }).fill("Question from the Testudo chat panel");
  await frame.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => window.bridge.updates.some((update) => update.status === "complete"), null, { timeout: 15_000 });
  await frame.getByText("Testudo: The selected route shows a longer journey time.").waitFor();
  assert.equal((await send("testudoOpenGeoAiChat", { open: false })).result.open, false);
  assert.equal((await send("testudoRequestInvestigation", { question: "What changed on this route?" })).result.accepted, true);
  await page.waitForFunction(() => window.bridge.updates.filter((update) => update.status === "complete").length >= 2, null, { timeout: 15_000 });
  const investigation = await page.evaluate(() => window.bridge.updates.at(-1));
  assert.equal(investigation.summary.reply, "The selected route shows a longer journey time.");
  assert.equal(investigation.summary.subpath_impact.paths[0].journey_times[0].current.journey_time, 12);
  assert.equal(investigation.summary.subpath_impact.baseline_comparison_coverage, 1);
  assert.equal("raw_table" in investigation.summary.subpath_impact.paths[0].journey_times[0], false);
  assert.equal(chatRequests[0].method, "POST");
  assert.equal(chatRequests[0].url, "/api/public/demo/geoai-chat");
  assert.equal(chatRequests[0].authorization, `Testudo-Embed ${guestToken}`);
  assert.equal(chatRequests[0].body.prompt, "Question from the Testudo chat panel");
  assert.equal("guestEmbedToken" in chatRequests[0].body, false);
  assert.equal(chatRequests[0].body.viewer_context.package_version_id, "32787055-7258-45f0-8593-f8c53e1cc788");
  assert.equal(chatRequests[1].body.prompt, "What changed on this route?");
  assert.equal(investigation.summary.ollaya.status, "matched");
  assert.equal("private_trace" in investigation.summary.ollaya, false);

  const guestTokenForPackage = "h".repeat(48);
  assert.equal((await send("testudoSetGuestCapability", {
    protocol: 1, guestEmbedToken: guestTokenForPackage, expiresAt: Date.now() + 60_000,
    packageId: "London/testudo-package-2026-09-24-website-demo-v1", packageVersionId: "32787055-7258-45f0-8593-f8c53e1cc788",
  })).ok, true);
  const guestLoadResult = await send("testudoLoadPackage", { bootstrap: {
    packageId: "London/testudo-package-2026-09-24-website-demo-v1",
    versionId: "32787055-7258-45f0-8593-f8c53e1cc788",
    manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
    artifactEndpoint: "/api/v1/view/32787055-7258-45f0-8593-f8c53e1cc788/artifact/",
  } });
  assert.equal(guestLoadResult.ok, true, JSON.stringify(guestLoadResult));
  const loadedPlayback = await send("testudoGetPlaybackState");
  assert.equal(loadedPlayback.result.available, true);
  assert.equal(loadedPlayback.result.maxTick, 12);
  assert.equal((await send("testudoSetPlaybackPlaying", { playing: true })).result.playing, true);
  assert.equal((await send("testudoSetPlaybackSpeed", { speed: 2 })).result.speed, 2);
  assert.equal((await send("testudoSeekPlayback", { tick: 6 })).result.tick, 6);
  assert.equal((await send("testudoRestartPlayback")).result.tick, 0);
  const loadedProgress = await send("testudoGetProgressState");
  assert.equal(loadedProgress.result.available, true);
  assert.equal(loadedProgress.result.value, 1);
  assert.equal((await send("testudoGetState")).result.capabilities.measuredProgress, true);
  assert.deepEqual(descriptorRequests.map((request) => request.path), ["manifest.json", "geolibre/package.json", "chunks/0.json.gz"]);
  assert.equal(descriptorRequests.every((request) => request.authorization === `Testudo-Embed ${guestTokenForPackage}`), true);
  assert.deepEqual(byteRequests.map((request) => request.path), ["/artifact-bytes/manifest", "/artifact-bytes/native", "/artifact-bytes/chunk"]);
  assert.equal(byteRequests.every((request) => request.authorization === `Testudo-Embed ${guestTokenForPackage}` && request.search === ""), true);
  assert.equal(byteRequests.every((request) => request.origin === new URL(baseUrl).origin), true);
  assert.equal(bytePreflights.every((request) => request.origin === new URL(baseUrl).origin && /authorization/i.test(request.requestHeaders)), true);
  assert.equal(byteCorsResponses.length, 3);
  assert.equal(byteCorsResponses.every((response) => response.allowOrigin === new URL(baseUrl).origin), true);
  assert.equal((await send("testudoLoadPackage", { bootstrap: {
    packageId: "London/testudo-package-2026-09-24-website-demo-v1",
    versionId: "32787055-7258-45f0-8593-f8c53e1cc788",
    manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
    artifactEndpoint: "/api/v1/view/32787055-7258-45f0-8593-f8c53e1cc788/artifact/",
  }, transport: { bearerToken: "signed-browser-token-123456" } })).ok, true);
  assert.deepEqual(descriptorRequests.slice(3).map((request) => request.path), ["manifest.json", "geolibre/package.json", "chunks/0.json.gz"]);
  assert.equal(descriptorRequests.slice(3).every((request) => request.authorization === "Bearer signed-browser-token-123456"), true);
  assert.equal(byteRequests.slice(3).every((request) => request.authorization === undefined && request.search === "?token=signed"), true);
  assert.equal(await page.evaluate(() => window.bridge.playbackUpdates.some((update) => update.available === true)), true);
  assert.equal(await page.evaluate(() => window.bridge.progressUpdates.some((update) => update.stage === "ready")), true);
  assert.equal(await page.evaluate(() => window.bridge.scenarioUpdates.some((update) => update.selectedScenario === 2)), false);
  assert.equal((await send("testudoSelectScenario", { scenarioId: 2 })).result.selectedScenario, 2);
  assert.equal(await page.evaluate(() => window.bridge.scenarioUpdates.some((update) => update.selectedScenario === 2)), true);
  assert.equal((await send("testudoOpenGeoAiChat", { open: true })).result.open, true);
  assert.equal((await send("testudoRequestInvestigation", { question: "Signed-in package question" })).result.accepted, true);
  await page.waitForFunction(() => window.bridge.updates.filter((update) => update.status === "complete").length >= 3, null, { timeout: 15_000 });
  assert.equal(chatRequests[2].url, "/api/v1/ai/chat");
  assert.equal(chatRequests[2].authorization, "Bearer signed-browser-token-123456");
  assert.equal(chatRequests[2].body.package_id, "London/testudo-package-2026-09-24-website-demo-v1");
  assert.equal(chatRequests[2].body.package_version_id, "32787055-7258-45f0-8593-f8c53e1cc788");
  assert.equal(chatRequests[2].body.viewer_context.package_version_id, "32787055-7258-45f0-8593-f8c53e1cc788");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    ok: true,
    source: "built dist iframe",
    camera: camera.result,
    control: control.result,
    playbackAvailable: loadedPlayback.result.available,
    measuredProgressAvailable: loadedProgress.result.available,
    geoAiStatus: geoAiStatus.result,
    chatPanelOpened: opened.result.open,
    chatRequestPaths: chatRequests.map((request) => request.url),
    investigation: investigation.summary,
  }, null, 2));
} finally {
  await browser.close();
}
