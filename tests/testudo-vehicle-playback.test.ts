import assert from "node:assert/strict";
import { test } from "node:test";
import { TestudoFeatureBridge, type TestudoPackageBootstrap } from "../packages/plugins/src/testudo-feature-bridge";
import { getTestudoPackageProvider } from "../packages/plugins/src/testudo-provider-registry";
import {
  registerTestudoVehiclePlaybackProvider,
  testudoVehiclePlaybackProvider,
} from "../packages/plugins/src/plugins/testudo-vehicle-playback";

const fixtureManifest = JSON.stringify({
  dt: 0.5,
  n_ticks: 12,
  scenarios: [{ scid: 42, name: "AM peak", replications: [{ did: 5, didname: "Run 5" }] }],
});
const bootstrap: TestudoPackageBootstrap = {
  packageId: "fixture/vehicle-playback",
  versionId: "fixture-v1",
  label: "Playback fixture",
  artifactEndpoint: "/package/fixture-v1/",
  capabilities: [{ id: "vehicle-playback", available: true }],
};

test("the built-in playback provider registers under its declared package capability", () => {
  const unregister = registerTestudoVehiclePlaybackProvider();
  try {
    assert.equal(getTestudoPackageProvider("vehicle-playback", bootstrap), testudoVehiclePlaybackProvider);
    assert.equal(getTestudoPackageProvider("vehicle-playback", {
      ...bootstrap,
      capabilities: [{ id: "vehicle-playback", available: false }],
    }), null);
  } finally {
    unregister();
  }
});

test("a fixture package loads through the host artifact proxy and supports correlated playback commands", async () => {
  const unregister = registerTestudoVehiclePlaybackProvider();
  const artifactRequests: Array<{ requestId: string; tviewId: string; generation: number; artifactRef: string }> = [];
  const fetchArtifact = async (request: (typeof artifactRequests)[number]) => {
    artifactRequests.push(request);
    assert.equal(request.artifactRef, "manifest.json");
    return new TextEncoder().encode(fixtureManifest).buffer;
  };
  const proxiedBridge = new TestudoFeatureBridge(
    (packageBootstrap) => getTestudoPackageProvider("vehicle-playback", packageBootstrap),
    async (request) => fetchArtifact(request),
  );
  try {
    proxiedBridge.createTView("vehicle-view");
    const context = await proxiedBridge.loadPackage("vehicle-view", bootstrap);
    assert.equal(context.generation, 1);
    assert.equal(proxiedBridge.getState("vehicle-view").status, "ready");
    assert.equal(artifactRequests.length, 1);
    assert.equal(artifactRequests[0]?.tviewId, "vehicle-view");
    assert.equal(artifactRequests[0]?.generation, context.generation);
    assert.match(artifactRequests[0]?.requestId ?? "", /^testudo-artifact-/);
    assert.equal(JSON.stringify(artifactRequests).toLowerCase().includes("authorization"), false);

    assert.deepEqual(proxiedBridge.sessions.get("vehicle-view")?.scenarios, [
      { id: "42", label: "AM peak", replications: [{ id: 5, label: "Run 5" }] },
    ]);
    assert.equal(await proxiedBridge.selectScenario("vehicle-view", "42"), "42");
    assert.deepEqual(await proxiedBridge.playback("vehicle-view", "play", undefined, context.generation), {
      available: true, loading: false, playing: true, tick: 0, maxTick: 11, speed: 1, dt: 0.5, loop: false,
    });
    assert.equal((await proxiedBridge.playback("vehicle-view", "pause", undefined, context.generation)).playing, false);
    assert.equal((await proxiedBridge.playback("vehicle-view", "seek", 7, context.generation)).tick, 7);
    assert.equal((await proxiedBridge.playback("vehicle-view", "speed", 2, context.generation)).speed, 2);
    assert.equal((await proxiedBridge.playback("vehicle-view", "restart", undefined, context.generation)).tick, 0);
    assert.equal(proxiedBridge.getPlaybackState("vehicle-view", context.generation).available, true);
  } finally {
    proxiedBridge.close("vehicle-view");
    unregister();
  }
});

test("playback rejects commands from a superseded generation", async () => {
  const unregister = registerTestudoVehiclePlaybackProvider();
  const bridge = new TestudoFeatureBridge(
    (packageBootstrap) => getTestudoPackageProvider("vehicle-playback", packageBootstrap),
    async () => new TextEncoder().encode(fixtureManifest).buffer,
  );
  try {
    bridge.createTView("replaceable");
    const original = await bridge.loadPackage("replaceable", bootstrap);
    await bridge.loadPackage("replaceable", { ...bootstrap, versionId: "fixture-v2" });
    await assert.rejects(bridge.playback("replaceable", "seek", 2, original.generation), /stale/);
    assert.throws(() => bridge.getPlaybackState("replaceable", original.generation), /stale/);
  } finally {
    bridge.close("replaceable");
    unregister();
  }
});
