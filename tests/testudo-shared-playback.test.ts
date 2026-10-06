import assert from "node:assert/strict";
import test, { after } from "node:test";
import { TestudoFeatureBridge } from "../packages/plugins/src/testudo-feature-bridge";
import { getTestudoPackageProvider, getTestudoPackageProviderSuite } from "../packages/plugins/src/testudo-provider-registry";
import { registerTestudoVehiclePlaybackProvider } from "../packages/plugins/src/plugins/testudo-vehicle-playback";
import { registerTestudoTimeSeriesProviders } from "../packages/plugins/src/plugins/testudo-time-series-providers";

const capabilities = ["vehicle-playback", "network-kpi", "emissions-h3", "scenario-comparison"] as const;
const bootstrap = {
  packageId: "fixture/all-testudo-capabilities", versionId: "v1", label: "All capabilities",
  artifactEndpoint: "/fixture/", capabilities: capabilities.map((id) => ({ id, available: true })),
};
const fixture = {
  dt: 100, n_ticks: 20,
  scenarios: [{ scid: 101, name: "Reference" }, { scid: 202, name: "Proposal" }],
  kpiTimeSeries: { flow: [10, 11, 12, 13], speed: [40, 41, 42, 43] },
  emissionsTimeSeries: { h3a: [1, 2, 3, 4] },
  comparisonTimeSeries: { "101": [{ flow: 10 }, { flow: 11 }, { flow: 12 }, { flow: 13 }], "202": [{ flow: 8 }, { flow: 9 }, { flow: 10 }, { flow: 11 }] },
};
const bytes = new TextEncoder().encode(JSON.stringify(fixture)).buffer;
let activeBridge: TestudoFeatureBridge | undefined;
after(async () => {
  if (activeBridge?.sessions.get("primary")) await activeBridge.playback("primary", "pause").catch(() => {});
});

test("all four registered providers share one clock across capability switches", async () => {
  const unregisterVehicle = registerTestudoVehiclePlaybackProvider();
  const unregisterOthers = registerTestudoTimeSeriesProviders();
  try {
    for (const id of capabilities) assert.ok(getTestudoPackageProvider(id, bootstrap), `${id} registered`);
    const bridge = activeBridge = new TestudoFeatureBridge(getTestudoPackageProviderSuite, async () => bytes);
    await bridge.createTView("primary");
    const loaded = await bridge.loadPackage("primary", bootstrap);
    assert.equal(loaded.generation, 1);
    assert.deepEqual(bridge.sessions.get("primary")?.capabilities?.map((item) => item.id), [...capabilities]);

    const seek = await bridge.playback("primary", "seek", 2, loaded.generation);
    assert.equal(seek.tick, 2);
    await bridge.selectPlugin("primary", "network-kpi");
    assert.deepEqual(bridge.sessions.get("primary")?.getPlaybackValues?.(), {
      tick: 2, values: { flow: 12, speed: 42 },
    });
    assert.deepEqual(bridge.sessions.get("primary")?.getComparisonAtTick?.(["101", "202"]), {
      tick: 2, scenarioIds: ["101", "202"], values: [{ flow: 12 }, { flow: 10 }],
    });
    await bridge.selectPlugin("primary", "scenario-comparison");

    await bridge.playback("primary", "speed", 2, loaded.generation);
    const playing = await bridge.playback("primary", "play", undefined, loaded.generation);
    assert.equal(playing.playing, true);
    for (const capability of ["network-kpi", "emissions-h3", "scenario-comparison"] as const) {
      await bridge.selectPlugin("primary", capability);
      const state = bridge.getPlaybackState("primary", loaded.generation);
      assert.equal(state.available, true);
      assert.equal(state.tick, 2);
      assert.equal(state.speed, 2);
      assert.equal(state.playing, true);
      assert.equal(state.activeCapability, capability);
      assert.equal(bridge.getPlaybackState("primary", loaded.generation).available, true);
      assert.deepEqual(state.tickFollowers?.map((entry) => entry.following), [true, true, true, true]);
      if (capability === "emissions-h3") {
        assert.deepEqual(bridge.sessions.get("primary")?.getPlaybackValues?.(), { tick: 2, values: { h3a: 3 } });
      }
    }
    await bridge.playback("primary", "seek", 3, loaded.generation);
    await bridge.selectPlugin("primary", "scenario-comparison");
    const comparison = bridge.sessions.get("primary")?.getComparisonAtTick?.(["101", "202"]);
    assert.equal(comparison?.tick, 3);
    assert.deepEqual(comparison?.scenarioIds, ["101", "202"]);
    assert.deepEqual(comparison?.values, [{ flow: 13 }, { flow: 11 }]);

    await bridge.createTView("secondary");
    const other = await bridge.loadPackage("secondary", bootstrap);
    await bridge.playback("secondary", "seek", 1, other.generation);
    assert.equal(bridge.getPlaybackState("primary", loaded.generation).tick, 3);
    await assert.rejects(bridge.sessions.get("primary")?.onPlaybackTick?.("secondary", loaded.generation, playing), /stale/);
    await bridge.loadPackage("primary", { ...bootstrap, versionId: "v2" });
    await assert.rejects(bridge.playback("primary", "seek", 0, loaded.generation), /stale/);
  } finally {
    unregisterOthers();
    unregisterVehicle();
  }
});

test("results capability has a shared playback clock when vehicle-playback is not declared", async () => {
  const unregister = registerTestudoTimeSeriesProviders();
  try {
    const resultsPackage = { ...bootstrap, capabilities: [{ id: "network-kpi" as const, available: true }] };
    const bridge = new TestudoFeatureBridge(getTestudoPackageProviderSuite, async () => bytes);
    await bridge.createTView("results-only");
    const loaded = await bridge.loadPackage("results-only", resultsPackage);
    const state = await bridge.playback("results-only", "seek", 3, loaded.generation);
    assert.equal(state.available, true);
    assert.equal(state.tick, 3);
    assert.equal(state.activeCapability, "network-kpi");
    assert.deepEqual(bridge.sessions.get("results-only")?.getPlaybackValues?.(), {
      tick: 3, values: { flow: 13, speed: 43 },
    });
    bridge.sessions.remove("results-only");
  } finally { unregister(); }
});

test("capabilities without time-series data explicitly report that they cannot follow values", async () => {
  const unregister = registerTestudoTimeSeriesProviders();
  try {
    const noSeries = new TextEncoder().encode(JSON.stringify({ dt: 1, n_ticks: 2, kpiTimeSeries: {} })).buffer;
    const factory = getTestudoPackageProvider("network-kpi", { ...bootstrap, capabilities: [{ id: "network-kpi", available: true }] });
    assert.ok(factory);
    const session = await factory.open({ ...bootstrap, capabilities: [{ id: "network-kpi", available: true }] }, {
      tviewId: "no-series", packageId: bootstrap.packageId, versionId: "v1", pluginId: "network-kpi", generation: 1,
    }, () => {}, async () => noSeries);
    assert.equal(session.timeSeriesAvailable, false);
    assert.equal(session.getPlaybackValues?.().values, undefined);
    await session.dispose?.();
  } finally { unregister(); }
});
