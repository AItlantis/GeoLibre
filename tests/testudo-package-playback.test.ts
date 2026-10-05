/* eslint-disable @typescript-eslint/no-explicit-any -- models the iframe host APIs. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import plugin from "../apps/geolibre-desktop/public/plugins/testudo-bridge/entry.js";
import { SharedFeatureRegistry } from "../packages/plugins/src/shared-features";

test("Testudo package command loads native package metadata and manifest-listed chunks into playback and progress handlers", async () => {
  const handlers = new Map<string, (event: any) => void>();
  const outbound: any[] = [];
  const parent = { location: { origin: "https://testudo.test", href: "https://testudo.test/demo" }, postMessage: (message: unknown) => outbound.push(message) };
  const savedWindow = (globalThis as any).window;
  const savedFetch = globalThis.fetch;
  const sources = new Map<string, any>();
  const layers = new Set<string>();
  const sharedFeatures = new SharedFeatureRegistry();
  const controls: Record<string, boolean> = { navigation: true };
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, value: any) => sources.set(id, { ...value, setData(data: unknown) { this.data = data; } }),
    getLayer: (id: string) => layers.has(id) ? { id } : undefined,
    addLayer: (layer: any) => layers.add(layer.id),
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
  };
  const fakeWindow = {
    parent,
    location: { origin: "https://app.testudo.test" },
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_TESTUDO_BYTE_ORIGINS: "https://bytes.testudo.live" },
    addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener),
    removeEventListener: (type: string) => handlers.delete(type),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  (globalThis as any).window = fakeWindow;
  const chunkBody = JSON.stringify({ events: {
    "1": [{ event: "spawn", id: 40, state: { WorldX: -0.12, WorldY: 51.5 } }],
    "7": [{ event: "update", id: 40, state: { WorldX: -0.13, WorldY: 51.51 } }],
  } });
  const chunkBytes = gzipSync(Buffer.from(chunkBody));
  const assets = new Map<string, unknown>([
    ["manifest.json", {
      metadata: { dt: 0.8, n_ticks: 12, trajectory_encoding: "events_v1" },
      chunks: [{ index: 0, path: "chunks/0.json.gz", start_tick: 0, end_tick: 12, compressed_size_bytes: chunkBytes.byteLength }],
    }],
    ["geolibre-package.json", {
      schemaVersion: "geolibre.package.v1",
      capabilities: { animation: { state: "available" } },
      scenarios: [
        { scid: 1, name: "Baseline", replications: [{ did: 11 }] },
        { scid: 2, name: "Roadworks North", replications: [{ did: 22 }] },
      ],
    }],
  ]);
  const requests: string[] = [];
  let nestedManifestStatus: number | undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    if (url.startsWith("https://app.testudo.test/api/v1/view/fixture-v1/artifact/")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer signed-test-token-123456");
      const path = url.slice("https://app.testudo.test/api/v1/view/fixture-v1/artifact/".length);
      const descriptorUrls: Record<string, string> = {
        "manifest.json": "https://bytes.testudo.live/artifact-bytes/manifest",
        "geolibre-package.json": "https://bytes.testudo.live/artifact-bytes/native",
        "chunks/0.json.gz": "https://bytes.testudo.live/artifact-bytes/chunk",
      };
      if (path === "geolibre/package.json" && nestedManifestStatus) return new Response("not found", { status: nestedManifestStatus });
      if (!descriptorUrls[path]) return new Response("not found", { status: 404 });
      return Response.json({ url: descriptorUrls[path], expires_at: Math.floor(Date.now() / 1000) + 60 });
    }
    if (url.startsWith("https://bytes.testudo.live/")) assert.equal(new Headers(init?.headers).get("Authorization"), null);
    if (url === "https://bytes.testudo.live/artifact-bytes/manifest") return new Response(JSON.stringify(assets.get("manifest.json")), { status: 200 });
    if (url === "https://bytes.testudo.live/artifact-bytes/native") return new Response(JSON.stringify(assets.get("geolibre-package.json")), { status: 200 });
    if (url === "https://bytes.testudo.live/artifact-bytes/chunk") return new Response(chunkBytes, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    plugin.activate({
      getEmbedAllowedOrigins: () => ["https://testudo.test"],
      getMap: () => map,
      getMapRenderer: () => "maplibre",
      getBuiltInMapControlVisible: (id: string) => Boolean(controls[id]),
      setBuiltInMapControlVisible: (id: string, visible: boolean) => { controls[id] = visible; return true; },
      sharedFeatures,
      registerSharedFeatures: (contribution: any, options: any) => sharedFeatures.register("testudo-bridge", contribution, options),
      registerFloatingPanel: () => () => undefined,
      openFloatingPanel: () => true,
      closeFloatingPanel: () => undefined,
    } as any);
    const parentWindow = parent;
    let challenge = outbound.find((message) => message.type === "ready").payload.challenge;
    const send = async (type: string, payload: Record<string, unknown> = {}) => {
      const requestId = `${outbound.length}`;
      await handlers.get("message")!({
        source: parentWindow,
        origin: "https://testudo.test",
        data: { v: 2, source: "testudo-geolibre-plugin", type, requestId, payload: { ...payload, challenge } },
      });
      return outbound.filter((message) => message.type === "ack").at(-1);
    };
    const loaded = await send("testudoLoadPackage", {
      bootstrap: { packageId: "london-demo", versionId: "fixture-v1", manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json", artifactEndpoint: "/api/v1/view/fixture-v1/artifact/" },
      transport: { bearerToken: "signed-test-token-123456" },
    });
    assert.equal(loaded.payload.ok, true, loaded.payload.error);
    assert.deepEqual(requests, [
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/manifest.json",
      "https://bytes.testudo.live/artifact-bytes/manifest",
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/geolibre/package.json",
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/geolibre-package.json",
      "https://bytes.testudo.live/artifact-bytes/native",
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/chunks/0.json.gz",
      "https://bytes.testudo.live/artifact-bytes/chunk",
    ]);
    const state = await send("testudoGetState");
    assert.equal(state.payload.result.capabilities.playback, true);
    assert.equal(state.payload.result.capabilities.measuredProgress, true);
    const mapControls = await send("testudoGetMapControlState");
    assert.equal(mapControls.payload.result.available, true);
    assert.equal((await send("testudoSetBuiltInMapControl", { control: "navigation", visible: false })).payload.result.visible, false);
    const playback = await send("testudoGetPlaybackState");
    assert.deepEqual(playback.payload.result, { available: true, playing: false, tick: 0, maxTick: 12, speed: 1, dt: 0.8, loop: true, loading: false });
    assert.equal((await send("testudoSetPlaybackPlaying", { playing: true })).payload.result.playing, true);
    assert.equal((await send("testudoSetPlaybackSpeed", { speed: 2 })).payload.result.speed, 2);
    assert.equal((await send("testudoSeekPlayback", { tick: 6 })).payload.result.tick, 6);
    assert.deepEqual(sources.get("testudo-package-playback-vehicles").data.features[0].geometry.coordinates, [-0.12, 51.5]);
    assert.equal((await send("testudoSeekPlayback", { tick: 8 })).payload.result.tick, 8);
    assert.deepEqual(sources.get("testudo-package-playback-vehicles").data.features[0].geometry.coordinates, [-0.13, 51.51]);
    assert.equal((await send("testudoRestartPlayback")).payload.result.tick, 0);
    const scenarios = await send("testudoGetScenarioState");
    assert.deepEqual(scenarios.payload.result.scenarios.map((item: any) => item.label), ["Baseline", "Roadworks North"]);
    assert.equal((await send("testudoSelectScenario", { scenarioId: 2 })).payload.result.selectedScenario, 2);
    assert.equal(sharedFeatures.getSnapshot().scenario?.selectedScenario, 2);
    assert.equal(sharedFeatures.getSnapshot().mapControls?.controls.navigation, false);
    const progress = await send("testudoGetProgressState");
    assert.equal(progress.payload.result.stage, "ready");
    assert.equal(progress.payload.result.loaded, 1);
    assert.equal(progress.payload.result.total, 1);
    assert.equal(progress.payload.result.value, 1);
    assert.equal(progress.payload.result.loadedBytes, progress.payload.result.totalBytes);
    assert.equal(outbound.some((message) => message.type === "testudoProgressChanged" && message.payload.stage === "ready"), true);
    assert.equal(outbound.some((message) => message.type === "testudoPlaybackChanged" && message.payload.available === true), true);
    assert.equal(outbound.some((message) => message.type === "testudoScenarioChanged" && message.payload.selectedScenario === 2), true);

    nestedManifestStatus = 403;
    const requestStart = requests.length;
    const deniedLegacyFallback = await send("testudoLoadPackage", {
      bootstrap: { packageId: "london-demo", versionId: "fixture-v1", manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json", artifactEndpoint: "/api/v1/view/fixture-v1/artifact/" },
      transport: { bearerToken: "signed-test-token-123456" },
    });
    assert.equal(deniedLegacyFallback.payload.ok, false);
    assert.match(deniedLegacyFallback.payload.error, /lookup failed \(403\)/);
    assert.deepEqual(requests.slice(requestStart), [
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/manifest.json",
      "https://bytes.testudo.live/artifact-bytes/manifest",
      "https://app.testudo.test/api/v1/view/fixture-v1/artifact/geolibre/package.json",
    ]);
  } finally {
    plugin.deactivate({} as any);
    globalThis.fetch = savedFetch;
    (globalThis as any).window = savedWindow;
  }
});
