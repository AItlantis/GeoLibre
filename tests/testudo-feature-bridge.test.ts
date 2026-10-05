import assert from "node:assert/strict";
import { test } from "node:test";
import { TestudoFeatureBridge, type TestudoPackageBootstrap } from "../packages/plugins/src/testudo-feature-bridge";
import type { TestudoFeatureContext, TestudoFeatureSession } from "../packages/plugins/src/shared/testudo-feature-session";

const bootstrap: TestudoPackageBootstrap = {
  packageId: "London/demo",
  versionId: "v1",
  label: "London",
  artifactEndpoint: "/api/view/v1/artifact/",
};

function provider(context: TestudoFeatureContext, delivered: string[] = []): TestudoFeatureSession {
  let selectedScenarioId = "baseline";
  let playbackState = { available: true, loading: false, playing: false, tick: 4, maxTick: 30, speed: 2, dt: 1, loop: false };
  return {
    context,
    scenarios: [
      { id: "baseline", label: "Baseline", replications: [{ id: 101 }] },
      { id: "proposal", label: "Proposal", replications: [{ id: 201 }, { id: 202 }] },
    ],
    selectedScenarioId,
    selectScenario: (id) => { selectedScenarioId = id; return id; },
    playback: {
      getState: () => ({ ...playbackState }),
      setPlaying: (playing) => (playbackState = { ...playbackState, playing }),
      restart: () => (playbackState = { ...playbackState, playing: false, tick: 0 }),
      seek: (tick) => (playbackState = { ...playbackState, tick }),
      setSpeed: (speed) => (playbackState = { ...playbackState, speed }),
    },
    getCameraView: () => ({ center: [0, 0], zoom: 8 }),
    setCameraView: () => {},
    setMapControl: () => true,
    setViewMode: (mode) => mode,
    setNetworkFilter: () => {},
    requestGeoAI: () => {},
    deliverGeoAIReply: (id) => delivered.push(id),
  };
}

async function createAndLoad(bridge: TestudoFeatureBridge, tviewId: string, pkg = bootstrap) {
  bridge.createTView(tviewId);
  return bridge.loadPackage(tviewId, pkg);
}

test("provider scenarios and playback are addressed to the requested TView", async () => {
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context) });
  await createAndLoad(bridge, "left");
  await createAndLoad(bridge, "right", { ...bootstrap, versionId: "v2" });

  assert.equal(await bridge.selectScenario("left", "proposal"), "proposal");
  await assert.rejects(bridge.selectScenario("left", "missing"), /not declared/);
  assert.equal((await bridge.playback("left", "seek", 9)).tick, 9);
  assert.equal((await bridge.playback("right", "play")).playing, true);
  assert.equal(bridge.getPlaybackState("left").playing, false);
});

test("host must create an explicit TView id before loading and can query its status", async () => {
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context) });
  await assert.rejects(bridge.loadPackage("main", bootstrap), /has not been created/);
  assert.deepEqual(bridge.createTView("main"), { tviewId: "main", generation: 0, loaded: false });
  assert.throws(() => bridge.createTView("main"), /already exists/);
  assert.deepEqual(bridge.getTViews(), [{ tviewId: "main", generation: 0, loaded: false }]);
  await bridge.loadPackage("main", bootstrap);
  assert.deepEqual(bridge.getTViews(), [{ tviewId: "main", generation: 1, loaded: true }]);
  assert.deepEqual(bridge.setActiveTView("main"), { tviewId: "main" });
  assert.deepEqual(bridge.getActiveTView(), { tviewId: "main" });
  bridge.close("main");
  assert.deepEqual(bridge.getTViews(), []);
  assert.deepEqual(bridge.getActiveTView(), { tviewId: null });
});

test("guest capability stays in memory and is exposed only as expiring artifact authorization", async () => {
  let readAuthorization: (() => string | null) | undefined;
  const bridge = new TestudoFeatureBridge({
    open: async (_bootstrap, context, _progress, getArtifactAuthorizationHeader) => {
      readAuthorization = getArtifactAuthorizationHeader;
      return provider(context);
    },
  });
  bridge.createTView("main");
  const expiresAt = Date.now() + 60_000;
  assert.deepEqual(bridge.setGuestCapability("guest-secret", expiresAt), { accepted: true, expiresAt });
  await bridge.loadPackage("main", bootstrap);
  assert.equal(readAuthorization?.(), "Bearer guest-secret");
  assert.equal(JSON.stringify(bridge.getState("main")).includes("guest-secret"), false);
  bridge.clearGuestCapability();
  assert.equal(readAuthorization?.(), null);
  assert.throws(() => bridge.setGuestCapability("expired", Date.now() - 1), /invalid or expired/);
});

test("comparison edge cases keep scenario selection independent and reject stale session writes", async () => {
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context) });
  const leftContext = await createAndLoad(bridge, "left");
  const rightContext = await createAndLoad(bridge, "right");
  assert.notEqual(leftContext.tviewId, rightContext.tviewId);

  await bridge.selectScenario("left", "proposal");
  assert.equal(bridge.sessions.get("left")?.selectedScenarioId, "proposal");
  assert.equal(bridge.sessions.get("right")?.selectedScenarioId, "baseline");
  await bridge.loadPackage("left", { ...bootstrap, versionId: "v2" });
  assert.notEqual(bridge.sessions.get("left")?.context.generation, leftContext.generation);
  assert.equal(bridge.sessions.get("right")?.context.generation, rightContext.generation);
});

test("three-way scenario comparisons keep each selected scenario and playback state isolated", async () => {
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context) });
  await createAndLoad(bridge, "baseline");
  await createAndLoad(bridge, "proposal-a", { ...bootstrap, versionId: "v2" });
  await createAndLoad(bridge, "proposal-b", { ...bootstrap, versionId: "v3" });

  await bridge.selectScenario("baseline", "baseline");
  await bridge.selectScenario("proposal-a", "proposal");
  await bridge.selectScenario("proposal-b", "baseline");
  await bridge.playback("proposal-a", "seek", 19);
  await bridge.playback("proposal-b", "speed", 3);

  assert.deepEqual(["baseline", "proposal-a", "proposal-b"].map((id) => bridge.sessions.get(id)?.selectedScenarioId),
    ["baseline", "proposal", "baseline"]);
  assert.deepEqual(["baseline", "proposal-a", "proposal-b"].map((id) => bridge.getPlaybackState(id).tick), [4, 19, 4]);
  assert.deepEqual(["baseline", "proposal-a", "proposal-b"].map((id) => bridge.getPlaybackState(id).speed), [2, 2, 3]);
});

test("reloading one comparison side invalidates only its pending answer and keeps the other side live", async () => {
  const delivered: string[] = [];
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context, delivered) });
  const left = await createAndLoad(bridge, "left");
  const right = await createAndLoad(bridge, "right", { ...bootstrap, versionId: "v2" });
  const leftRequest = await bridge.requestInvestigation("left", "Compare the west route", "proposal");
  const rightRequest = await bridge.requestInvestigation("right", "Compare the east route", "baseline");

  await bridge.loadPackage("left", { ...bootstrap, versionId: "v3" });
  assert.deepEqual(await bridge.respondGeoAIRequestTuple(leftRequest.requestId, "left", left.generation, { content: "stale left" }),
    { requestId: leftRequest.requestId, accepted: false });
  assert.deepEqual(await bridge.respondGeoAIRequest(rightRequest.requestId, { ...right, scenarioId: "baseline" }, { content: "current right" }),
    { requestId: rightRequest.requestId, accepted: true });
  assert.deepEqual(delivered, [rightRequest.requestId]);
});

test("GeoAI reply tuple binds to the originating TView and generation", async () => {
  const deliveredLeft: string[] = [];
  const deliveredRight: string[] = [];
  const bridge = new TestudoFeatureBridge({
    open: async (_bootstrap, context) => provider(context, context.tviewId === "left" ? deliveredLeft : deliveredRight),
  });
  const left = await createAndLoad(bridge, "left");
  await createAndLoad(bridge, "right");
  const accepted = await bridge.requestInvestigation("left", "Why is the west corridor slow?", "proposal");
  assert.equal(accepted.tviewId, "left");
  assert.equal(accepted.generation, left.generation);
  assert.deepEqual(await bridge.respondGeoAIRequestTuple(accepted.requestId, "right", accepted.generation, { content: "wrong view" }), {
    requestId: accepted.requestId,
    accepted: false,
  });
  assert.deepEqual(await bridge.respondGeoAIRequestTuple(accepted.requestId, "left", accepted.generation + 1, { content: "stale" }), {
    requestId: accepted.requestId,
    accepted: false,
  });
  assert.deepEqual(await bridge.respondGeoAIRequestTuple(accepted.requestId, "left", accepted.generation, { content: "The baseline is slower." }), {
    requestId: accepted.requestId,
    accepted: true,
  });
  assert.deepEqual(deliveredLeft, [accepted.requestId]);
  assert.deepEqual(deliveredRight, []);
});

test("reload invalidates pending GeoAI replies from the previous generation", async () => {
  const delivered: string[] = [];
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context) => provider(context, delivered) });
  const original = await createAndLoad(bridge, "main");
  const request = await bridge.requestInvestigation("main", "Explain the KPI.");
  await bridge.loadPackage("main", { ...bootstrap, versionId: "v2" });
  assert.deepEqual(await bridge.respondGeoAIRequestTuple(request.requestId, "main", original.generation, { content: "late" }), {
    requestId: request.requestId,
    accepted: false,
  });
  assert.deepEqual(delivered, []);
});

test("measured progress is forwarded during provider loading and invalid counters fail", async () => {
  const bridge = new TestudoFeatureBridge({ open: async (_bootstrap, context, onProgress) => {
    onProgress({ loaded: 16, total: 64, label: "Manifest and metadata" });
    return { ...provider(context), loadPackage: async (report) => report({ loaded: 48, total: 64 }) };
  } });
  const progress: Array<{ value: number; loaded: number; total: number; label: string }> = [];
  bridge.createTView("main");
  await bridge.loadPackage("main", bootstrap, (item) => progress.push(item));
  assert.deepEqual(progress, [
    { value: 25, loaded: 16, total: 64, label: "Manifest and metadata" },
    { value: 75, loaded: 48, total: 64, label: "London" },
  ]);
  bridge.createTView("bad");
  await assert.rejects(bridge.loadPackage("bad", { ...bootstrap, artifactEndpoint: "" }), /bootstrap is incomplete/);
});
