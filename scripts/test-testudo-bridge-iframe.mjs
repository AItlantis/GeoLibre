import assert from "node:assert/strict";
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
    body: `window.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_EMBED_ORIGINS: ${JSON.stringify(new URL(baseUrl).origin)} };`,
  }));
  const chatRequests = [];
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
  await page.addInitScript((origin) => {
    window.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_EMBED_ORIGINS: origin };
  }, new URL(baseUrl).origin);
  await page.route("**/testudo-harness", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8"><title>Testudo plugin iframe smoke</title>
      <iframe id="viewer" src="/"></iframe>
      <script>
        window.bridge = { challenge: null, pending: new Map(), nextId: 1, updates: [] };
        window.addEventListener("message", event => {
          if (event.source !== document.querySelector("#viewer").contentWindow || event.data?.source !== "geolibre") return;
          if (event.data.type === "ready") { window.bridge.challenge = event.data.payload.challenge; return; }
          if (event.data.type === "testudoGeoAiInvestigationUpdate") { window.bridge.updates.push(event.data.payload); return; }
          if (event.data.type === "ack") {
            const waiter = window.bridge.pending.get(event.data.payload.requestId);
            if (waiter) { window.bridge.pending.delete(event.data.payload.requestId); waiter(event.data.payload); }
          }
        });
        window.sendBridge = (type, payload = {}) => new Promise((resolve, reject) => {
          const requestId = String(window.bridge.nextId++);
          const timer = setTimeout(() => reject(new Error("Bridge acknowledgement timed out: " + type)), 10000);
          window.bridge.pending.set(requestId, result => { clearTimeout(timer); resolve(result); });
          document.querySelector("#viewer").contentWindow.postMessage({
            v: 2, source: "testudo", type, requestId,
            payload: { ...payload, challenge: window.bridge.challenge },
          }, location.origin);
        });
      </script>`,
  }));
  await page.goto(`${baseUrl}/testudo-harness`);
  await page.waitForFunction(() => window.bridge.challenge !== null, null, { timeout: 90_000 });
  const send = (type, payload) => page.evaluate(([command, data]) => window.sendBridge(command, data), [type, payload]);

  const camera = await send("testudoSetCamera", { center: [12.5, 41.9], zoom: 7, bearing: 15, pitch: 20 });
  assert.equal(camera.ok, true, JSON.stringify(camera));
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
    packageId: "guest-package", packageVersionId: "guest-version",
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
  assert.equal(chatRequests[0].body.viewer_context.package_version_id, "guest-version");
  assert.equal(chatRequests[1].body.prompt, "What changed on this route?");
  assert.equal(investigation.summary.ollaya.status, "matched");
  assert.equal("private_trace" in investigation.summary.ollaya, false);

  assert.equal((await send("testudoLoadPackage", {
    bootstrap: { packageId: "signed-package", versionId: "signed-version" },
    transport: { bearerToken: "signed-browser-token-123456" },
  })).ok, true);
  assert.equal((await send("testudoOpenGeoAiChat", { open: true })).result.open, true);
  assert.equal((await send("testudoRequestInvestigation", { question: "Signed-in package question" })).result.accepted, true);
  await page.waitForFunction(() => window.bridge.updates.filter((update) => update.status === "complete").length >= 3, null, { timeout: 15_000 });
  assert.equal(chatRequests[2].url, "/api/v1/ai/chat");
  assert.equal(chatRequests[2].authorization, "Bearer signed-browser-token-123456");
  assert.equal(chatRequests[2].body.package_id, "signed-package");
  assert.equal(chatRequests[2].body.package_version_id, "signed-version");
  assert.equal(chatRequests[2].body.viewer_context.package_version_id, "signed-version");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    ok: true,
    source: "built dist iframe",
    camera: camera.result,
    control: control.result,
    playbackAvailable: false,
    measuredProgressAvailable: false,
    geoAiStatus: geoAiStatus.result,
    chatPanelOpened: opened.result.open,
    chatRequestPaths: chatRequests.map((request) => request.url),
    investigation: investigation.summary,
  }, null, 2));
} finally {
  await browser.close();
}
