import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../apps/geolibre-desktop/public/plugins/testudo-bridge/entry.js";
import { SharedFeatureRegistry } from "../packages/plugins/src/shared-features";

test("Testudo plugin round-trips camera and map control state and negotiates missing package capabilities", async () => {
  const handlers = new Map<string, (event: any) => void>();
  const outbound: any[] = [];
  const parent = { postMessage: (message: unknown) => outbound.push(message) };
  const savedWindow = (globalThis as any).window;
  const savedFetch = globalThis.fetch;
  const fakeWindow = {
    parent,
    addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener),
    removeEventListener: (type: string) => handlers.delete(type),
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  (globalThis as any).window = fakeWindow;

  const camera = { center: [0, 0] as [number, number], zoom: 2, bearing: 0, pitch: 0 };
  const controls: Record<string, boolean> = { navigation: true, terrain: false };
  let floatingPanel: any = null;
  let openFloatingPanelId: string | null = null;
  const map = {
    getCenter: () => ({ lng: camera.center[0], lat: camera.center[1] }),
    getZoom: () => camera.zoom,
    getBearing: () => camera.bearing,
    getPitch: () => camera.pitch,
    jumpTo: (next: Partial<typeof camera>) => Object.assign(camera, next),
  };
  const app: any = {
    getEmbedAllowedOrigins: () => ["https://testudo.example"],
    getMapRenderer: () => "maplibre",
    getMap: () => map,
    getBuiltInMapControlVisible: (id: string) => Boolean(controls[id]),
    setBuiltInMapControlVisible: (id: string, visible: boolean) => { controls[id] = visible; return true; },
    registerFloatingPanel: (panel: any) => { floatingPanel = panel; return () => { floatingPanel = null; }; },
    openFloatingPanel: (id: string) => { openFloatingPanelId = id; return Boolean(floatingPanel && floatingPanel.id === id); },
    closeFloatingPanel: (id: string) => { if (openFloatingPanelId === id) openFloatingPanelId = null; },
  };

  try {
    plugin.activate(app);
    const ready = outbound.find((message) => message.type === "ready");
    assert.ok(ready);
    let challenge = ready.payload.challenge;
    assert.match(challenge, /^[a-f0-9]{32}$/);
    let listener = handlers.get("message")!;
    const send = async (type: string, payload: Record<string, unknown> = {}) => {
      const requestId = `${outbound.length}`;
      await listener({
        source: parent,
        origin: "https://testudo.example",
        data: { v: 2, source: "testudo", type, requestId, payload: { ...payload, challenge } },
      });
      return outbound.filter((message) => message.type === "ack").at(-1);
    };

    const moved = await send("testudoSetCamera", { center: [12.5, 41.9], zoom: 7, bearing: 15, pitch: 20 });
    assert.equal(moved.payload.ok, true);
    assert.deepEqual(moved.payload.result, { available: true, center: [12.5, 41.9], zoom: 7, bearing: 15, pitch: 20 });
    const cameraState = await send("testudoGetCameraState");
    assert.deepEqual(cameraState.payload.result, moved.payload.result);

    const control = await send("testudoSetBuiltInMapControl", { control: "terrain", visible: true });
    assert.equal(control.payload.result.visible, true);
    const mapState = await send("testudoGetMapControlState");
    assert.equal(mapState.payload.result.controls.terrain, true);
    assert.equal(mapState.payload.result.renderer, "maplibre");

    const state = await send("testudoGetState");
    assert.equal(state.payload.result.capabilities.camera, true);
    assert.equal(state.payload.result.capabilities.mapControls, true);
    assert.equal(state.payload.result.capabilities.playback, false);
    assert.equal(state.payload.result.capabilities.measuredProgress, false);
    assert.equal(state.payload.result.capabilities.ollayaScenarioMatching, false);
    assert.equal((await send("testudoGetOllayaScenarioStatus")).payload.result.available, false);
    const playback = await send("testudoGetPlaybackState");
    assert.equal(playback.payload.result.available, false);
    const progress = await send("testudoGetProgressState");
    assert.equal(progress.payload.result.available, false);
    const unsupportedPlay = await send("testudoSetPlaybackPlaying", { playing: true });
    assert.equal(unsupportedPlay.payload.ok, false);
    assert.match(unsupportedPlay.payload.error, /no active plugin provides package-backed playback/);

    const posted: any[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      posted.push({ url: String(input), init });
      return new Response(JSON.stringify({
        reply: "Traffic is worsening on the tested corridor.",
        ai_available: true,
        scenario_analysis: {
          scenario: { scenario_id: "plan-1", name: "Plan" },
          subpath_impact: {
            comparable_interval_count: 1,
            expected_baseline_comparisons: 2,
            baseline_comparison_coverage: 0.5,
            paths: [{ origin: 1, destination: 2, section_ids: [10], journey_times: [{
              interval_id: "current-1", baseline_interval_id: "baseline-1", time_window: "09:00",
              current: { journey_time: 12, count: 3 }, baseline: { journey_time: 8, count: 4 },
              delta: 4, percentage_delta: 50, comparable: true, raw_table: "must not cross the bridge",
            }] }],
          },
          od_evidence: { status: "available", source_table: "journey_times", capabilities: { od_journey_time: true }, raw: "discard" },
        },
        ollaya: { status: "matched", intent: "scenario_comparison", matched: true, internal_trace: "discard" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const expiry = Date.now() + 60_000;
    const capability = await send("testudoSetGuestCapability", {
      protocol: 1, guestEmbedToken: "a".repeat(48), expiresAt: expiry, packageId: "guest-pkg", packageVersionId: "guest-version",
    });
    assert.equal(capability.payload.ok, true);
    const geoAiStatus = await send("testudoGetGeoAiStatus");
    assert.equal(geoAiStatus.payload.result.configured, true);
    assert.equal(geoAiStatus.payload.result.providerReady, null);
    assert.equal(geoAiStatus.payload.result.ollayaScenarioMatchingAvailable, true);
    const accepted = await send("testudoRequestInvestigation", { question: "What changed on this route?" });
    assert.equal(accepted.payload.result.accepted, true);
    let update: any;
    for (let attempt = 0; attempt < 20 && !update; attempt += 1) {
      update = outbound.find((message) => message.type === "testudoGeoAiInvestigationUpdate");
      if (!update) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(update.payload.status, "complete");
    assert.equal(update.payload.summary.reply, "Traffic is worsening on the tested corridor.");
    assert.equal(update.payload.summary.subpath_impact.paths[0].journey_times[0].current.journey_time, 12);
    assert.equal(update.payload.summary.subpath_impact.baseline_comparison_coverage, 0.5);
    assert.equal(update.payload.summary.od_evidence.capabilities.od_journey_time, true);
    assert.equal(update.payload.summary.ollaya.status, "matched");
    assert.equal(update.payload.summary.ollaya.intent, "scenario_comparison");
    assert.equal("internal_trace" in update.payload.summary.ollaya, false);
    assert.equal("raw_table" in update.payload.summary.subpath_impact.paths[0].journey_times[0], false);
    assert.equal("raw" in update.payload.summary.od_evidence, false);
    assert.equal(posted[0].url, "https://testudo.example/api/public/demo/geoai-chat");
    assert.equal(posted[0].init.headers.Authorization, `Testudo-Embed ${"a".repeat(48)}`);
    assert.equal(posted[0].init.credentials, "omit");
    const guestBody = JSON.parse(posted[0].init.body);
    assert.equal(guestBody.viewer_context.package_id, "guest-pkg");
    assert.equal(guestBody.viewer_context.package_version_id, "guest-version");
    assert.doesNotMatch(posted[0].url, /localhost:11434/);

    const loaded = await send("testudoLoadPackage", {
      bootstrap: { packageId: "pkg-1", versionId: "version-7" },
      transport: { bearerToken: "signed-test-token-1234567890" },
    });
    assert.equal(loaded.payload.ok, true);
    assert.deepEqual(loaded.payload.result, { configured: true, packageId: "pkg-1", packageVersionId: "version-7" });
    assert.equal((await send("testudoOpenGeoAiChat", { open: true })).payload.result.open, true);
    assert.equal(openFloatingPanelId, "testudo-geoai-chat");
    assert.equal((await send("testudoOpenGeoAiChat", { open: false })).payload.result.open, false);
    assert.equal(openFloatingPanelId, null);
    assert.equal((await send("testudoRequestInvestigation", { question: "Compare this package" })).payload.result.accepted, true);
    for (let attempt = 0; attempt < 20 && posted.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(posted[1].url, "https://testudo.example/api/v1/ai/chat");
    assert.equal(posted[1].init.headers.Authorization, "Bearer signed-test-token-1234567890");
    const signedBody = JSON.parse(posted[1].init.body);
    assert.equal(signedBody.package_id, "pkg-1");
    assert.equal(signedBody.package_version_id, "version-7");
    assert.equal(signedBody.viewer_context.package_version_id, "version-7");
    assert.equal("bearerToken" in signedBody, false);

    plugin.deactivate(app);
    const sharedFeatures = new SharedFeatureRegistry();
    const live = {
      playback: { available: true, playing: false, tick: 0, maxTick: 9, speed: 1, dt: 0.5, loop: true },
      scenario: { available: true, scenarios: [{ id: 1, label: "Base" }, { id: 2, label: "Plan" }], selectedScenario: 1 as string | number },
      progress: { available: true, stage: "artifact-download", loadedBytes: 32 },
    };
    const releaseProvider = sharedFeatures.register("package-model", {
      playback: {
        getState: () => live.playback,
        setPlaying: (playing) => { live.playback.playing = playing; },
        restart: () => { live.playback.playing = false; live.playback.tick = 0; },
        seek: (tick) => { live.playback.tick = tick; },
        setSpeed: (speed) => { live.playback.speed = speed; },
      },
      scenario: {
        getState: () => live.scenario,
        select: (id) => { live.scenario.selectedScenario = id; },
      },
      progress: { getState: () => live.progress },
    });
    app.sharedFeatures = sharedFeatures;
    plugin.activate(app);
    challenge = outbound.filter((message) => message.type === "ready").at(-1).payload.challenge;
    listener = handlers.get("message")!;
    const livePlayback = await send("testudoGetPlaybackState");
    assert.equal(livePlayback.payload.result.available, true);
    assert.equal((await send("testudoSetPlaybackPlaying", { playing: true })).payload.result.playing, true);
    assert.equal((await send("testudoSeekPlayback", { tick: 5 })).payload.result.tick, 5);
    assert.equal((await send("testudoSetPlaybackSpeed", { speed: 2 })).payload.result.speed, 2);
    assert.equal((await send("testudoRestartPlayback")).payload.result.tick, 0);
    assert.equal((await send("testudoGetScenarioState")).payload.result.selectedScenario, 1);
    assert.equal((await send("testudoSelectScenario", { scenarioId: 2 })).payload.result.selectedScenario, 2);
    const measured = await send("testudoGetProgressState");
    assert.equal(measured.payload.result.stage, "artifact-download");
    assert.equal(measured.payload.result.loadedBytes, 32);
    assert.equal("totalBytes" in measured.payload.result, false);
    assert.equal(outbound.some((message) => message.type === "testudoProgressChanged"), true);
    plugin.deactivate(app);
    releaseProvider();
  } finally {
    plugin.deactivate(app);
    globalThis.fetch = savedFetch;
    (globalThis as any).window = savedWindow;
  }
});
