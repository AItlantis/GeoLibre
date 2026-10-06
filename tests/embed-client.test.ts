import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EMBED_API_SOURCE, EMBED_API_VERSION, connect } from "../packages/embed/src/index";

const originalWindow = (globalThis as { window?: unknown }).window;

class HostWindow extends EventTarget {
  setTimeout = setTimeout;
  clearTimeout = clearTimeout;
}

function harness() {
  const host = new HostWindow();
  const sent: Array<{ message: Record<string, unknown>; origin: string; transfer: Transferable[] }> = [];
  const frameWindow = {
    postMessage(message: Record<string, unknown>, origin: string, transfer: Transferable[] = []) {
      sent.push({ message, origin, transfer });
    },
  };
  (globalThis as { window?: unknown }).window = host;
  const iframe = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;
  const receive = (
    type: string,
    payload: Record<string, unknown>,
    origin = "https://app.test",
    source: unknown = frameWindow,
    protocolSource = EMBED_API_SOURCE,
  ) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: {
        value: { v: EMBED_API_VERSION, source: protocolSource, type, payload },
      },
      origin: { value: origin },
      source: { value: source },
    });
    host.dispatchEvent(event);
  };
  return { host, iframe, receive, sent };
}

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe("@geolibre/embed client", () => {
  it("round-trips Testudo commands with exact origin, child challenge, and typed ack", async () => {
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    const challenge = "0123456789abcdef0123456789abcdef";
    receive("ready", { version: "3.1.0", challenge });
    const client = await pending;
    const result = client.testudoSetScenario({ tviewId: "comparison:right", scenarioId: "proposal" });
    const request = sent.at(-1)!;
    assert.equal(request.origin, "https://app.test");
    assert.deepEqual(request.message, {
      v: EMBED_API_VERSION,
      source: "testudo",
      type: "testudoSetScenario",
      payload: { tviewId: "comparison:right", scenarioId: "proposal", challenge },
      requestId: request.message.requestId,
    });
    receive("ack", { requestId: request.message.requestId as string, ok: true, result: { id: "proposal", label: "Proposal", selected: true, replicationIds: [12, 13] } });
    assert.deepEqual(await result, { id: "proposal", label: "Proposal", selected: true, replicationIds: [12, 13] });
    client.disconnect();
  });

  it("sends every public host-to-iframe Testudo command through the authenticated envelope", async () => {
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    const challenge = "0123456789abcdef0123456789abcdef";
    receive("ready", { challenge });
    const client = await pending;
    const noArgumentCommands = new Set(["testudoGetTViews", "testudoGetActiveTView"]);
    const methodNames = Object.keys(client).filter((name) => name.startsWith("testudo"));
    const expected = [
      "testudoCreateTView", "testudoGetTViews", "testudoSetActiveTView", "testudoGetActiveTView",
      "testudoLoadPackage", "testudoOpenLocalPackage", "testudoSetPlugin", "testudoSetMode", "testudoSetPreset", "testudoGetState",
      "testudoSetScenario", "testudoSetPlaybackPlaying", "testudoRestartPlayback", "testudoSeekPlayback",
      "testudoSetPlaybackSpeed", "testudoGetPlaybackState", "testudoSetCameraView", "testudoGetCameraView",
      "testudoSetMapControl", "testudoSetViewMode", "testudoSetNetworkFilter", "testudoSetLegendVisibility",
      "testudoSetEsriWorldImagery", "testudoSetKpiGeometry", "testudoGetKpiGeometryState", "testudoSetRenderer",
      "testudoGetMapControlState", "testudoRequestInvestigation", "testudoRespondGeoAIRequest", "testudoOpenAnnotations", "testudoOpenRecordTour",
      "testudoOpenRecordVideo",
    ];
    assert.deepEqual(methodNames.sort(), expected.sort());
    for (const name of methodNames) {
      const method = (client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
      const payload = name === "testudoRespondGeoAIRequest"
        ? { requestId: "ai-1", tviewId: "main", generation: 1, content: "ok" }
        : { tviewId: "main" };
      const response = noArgumentCommands.has(name) ? method() : method(payload as never);
      const envelope = sent.at(-1)!.message;
      assert.equal(envelope.type, name);
      assertNoCredentialFields(envelope);
      assert.deepEqual(envelope.payload, noArgumentCommands.has(name)
        ? { challenge }
        : { ...payload, challenge });
      const result = name === "testudoCreateTView"
        ? { tviewId: "main", generation: 0, loaded: false }
        : name === "testudoGetTViews"
          ? []
          : name === "testudoLoadPackage"
            ? { tviewId: "main", generation: 1, status: "ready" }
            : name === "testudoOpenLocalPackage"
              ? { tviewId: "main", generation: 1, status: "ready", package: { packageId: "sample", versionId: null, label: "Sample", origin: "local" } }
            : null;
      receive("ack", { requestId: envelope.requestId, ok: true, result });
      await response;
    }
    client.disconnect();
  });

  it("fetches artifacts in the host and transfers only current correlated bytes", async () => {
    const { iframe, receive, sent } = harness();
    const received: Array<{ tviewId: string; generation: number; artifactRef: string; signal: AbortSignal }> = [];
    const hostMemoryCredential = "host-memory-only";
    const pendingBytes: Array<{ resolve: (bytes: ArrayBuffer) => void; signal: AbortSignal }> = [];
    const pending = connect(iframe, {
      origin: "https://app.test",
      fetchArtifact: async (request, signal) => {
        received.push({ ...request, signal });
        assert.equal(hostMemoryCredential, "host-memory-only");
        return new Promise<ArrayBuffer>((resolve) => pendingBytes.push({ resolve, signal }));
      },
    });
    const challenge = "0123456789abcdef0123456789abcdef";
    receive("ready", { challenge });
    const client = await pending;
    receive("testudoStateChanged", { tviewId: "left", generation: 3 });
    const request = {
      requestId: "artifact-left-3",
      tviewId: "left",
      generation: 3,
      artifactRef: "artifacts/manifest.json",
      challenge,
    };
    receive("testudoArtifactRequest", request, "https://other.test");
    receive("testudoArtifactRequest", request, "https://app.test", {});
    receive("testudoArtifactRequest", { ...request, challenge: "wrong" });
    receive("testudoArtifactRequest", { ...request, authorization: "Bearer never-send" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(received.length, 0);
    receive("testudoArtifactRequest", request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(received.length, 1);
    assert.deepEqual({ tviewId: received[0]!.tviewId, generation: received[0]!.generation, artifactRef: received[0]!.artifactRef }, {
      tviewId: "left", generation: 3, artifactRef: "artifacts/manifest.json",
    });
    const countAfterAcceptedRequest = sent.length;
    receive("testudoArtifactRequest", { ...request, requestId: "stale", generation: 2 });
    receive("testudoArtifactRequest", { ...request, requestId: "cross-view", tviewId: "right" });
    receive("testudoArtifactRequest", { ...request, requestId: request.requestId, artifactRef: "artifacts/other.json" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(received.length, 1);
    assert.equal(sent.length, countAfterAcceptedRequest);

    receive("testudoStateChanged", { tviewId: "left", generation: 4 });
    assert.equal(pendingBytes[0]!.signal.aborted, true);
    pendingBytes[0]!.resolve(new TextEncoder().encode("stale").buffer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, countAfterAcceptedRequest);

    receive("testudoArtifactRequest", { ...request, requestId: "current", generation: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const currentBytes = new TextEncoder().encode("current package").buffer;
    pendingBytes[1]!.resolve(currentBytes);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = sent.at(-1)!;
    assert.equal(response.origin, "https://app.test");
    assert.deepEqual(response.message, {
      v: EMBED_API_VERSION,
      source: "testudo",
      type: "testudoArtifactResponse",
      payload: {
        requestId: "current", tviewId: "left", generation: 4,
        artifactRef: "artifacts/manifest.json", challenge, bytes: currentBytes,
      },
    });
    assert.equal(response.transfer.length, 1);
    assert.equal(response.transfer[0], currentBytes);
    assertNoCredentialFields(response.message);
    client.disconnect();
  });

  it("correlates GeoAI requests to a TView and generation and sends replies to that owner", async () => {
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    const challenge = "abcdef0123456789abcdef0123456789";
    receive("ready", { challenge });
    const client = await pending;
    const seen: unknown[] = [];
    client.on("testudoGeoAIRequest", (request) => seen.push(request));
    const geoAIRequest = {
      requestId: "testudo-ai-1",
      messages: [{ role: "user" as const, content: "Explain this corridor" }],
      context: { tviewId: "comparison:left", generation: 7, packageId: "London/demo", versionId: "v1", pluginId: "scenario-comparison", scenarioId: "baseline" },
    };
    receive("testudoGeoAIRequest", geoAIRequest);
    assert.deepEqual(seen, [geoAIRequest]);
    const reply = client.testudoRespondGeoAIRequest({ requestId: geoAIRequest.requestId, tviewId: "comparison:left", generation: 7, content: "Travel time increases." });
    const message = sent.at(-1)!.message;
    assert.equal(message.type, "testudoRespondGeoAIRequest");
    assert.deepEqual(message.payload, { requestId: "testudo-ai-1", tviewId: "comparison:left", generation: 7, content: "Travel time increases.", challenge });
    receive("ack", { requestId: message.requestId as string, ok: true, result: { requestId: "testudo-ai-1", accepted: true } });
    assert.deepEqual(await reply, { requestId: "testudo-ai-1", accepted: true });
    client.disconnect();
  });

  it("rejects Testudo commands when the ready challenge is missing or malformed", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", { challenge: "not-a-challenge" });
    const client = await pending;
    await assert.rejects(client.testudoGetPlaybackState({ tviewId: "main" }), /challenge is unavailable/);
    client.disconnect();
  });

  it("refuses to send after a challenge from another frame origin", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", { challenge: "0123456789abcdef0123456789abcdef" }, "https://other.test");
    receive("ready", { challenge: "0123456789abcdef0123456789abcdef" }, "https://app.test", {});
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", { challenge: "0123456789abcdef0123456789abcdef" });
    const client = await pending;
    client.disconnect();
  });

  it("filters ready events by source, frame, and exact origin", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
    receive("ready", {}, "https://other.test");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {}, "https://app.test", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {}, "https://app.test", undefined, "another-app");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {});
    const client = await pending;
    client.disconnect();
  });

  it("correlates acknowledgements and returns result payloads", async () => {
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", {});
    const client = await pending;
    const layersPromise = client.listLayers();
    const request = sent.at(-1)!.message;
    receive("ack", {
      requestId: request.requestId,
      ok: true,
      result: [{ id: "roads", name: "Roads", type: "geojson", visible: true, opacity: 1 }],
    });
    assert.equal((await layersPromise)[0]?.id, "roads");
    client.disconnect();
  });

  it("delivers ack to subscribers as well as to the waiting command", async () => {
    // `ack` is a key of EmbedEventMap, so `on("ack", ...)` type-checks — it has
    // to actually fire, including for an ack no request is waiting on.
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", {});
    const client = await pending;
    const seen: Array<{ requestId: string; ok: boolean }> = [];
    const off = client.on("ack", (payload) => seen.push(payload));
    const viewport = client.getViewport();
    const requestId = sent.at(-1)!.message.requestId as string;
    receive("ack", { requestId, ok: true, result: { zoom: 4 } });
    await viewport;
    receive("ack", { requestId: "never-sent", ok: false, error: "stale" });
    assert.deepEqual(
      seen.map((entry) => [entry.requestId, entry.ok]),
      [
        [requestId, true],
        ["never-sent", false],
      ],
    );
    off();
    receive("ack", { requestId: "after-off", ok: true });
    assert.equal(seen.length, 2);
    client.disconnect();
  });

  it("rejects pending requests on disconnect", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", {});
    const client = await pending;
    const viewport = client.getViewport();
    client.disconnect();
    await assert.rejects(viewport, /disconnected/i);
  });

  it("rejects a bad origin instead of throwing out of the call", async () => {
    // `connect` is typed to return a Promise, so `connect(...).catch(...)` has
    // to see an origin failure — a synchronous throw would escape it entirely.
    const { iframe } = harness();
    for (const origin of ["not-a-url", "mailto:a@b.com"]) {
      let thrown: unknown = null;
      let pending: Promise<unknown> | null = null;
      try {
        pending = connect(iframe, { origin, timeoutMs: 5 });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown, null, `connect threw synchronously for "${origin}"`);
      await assert.rejects(pending as Promise<unknown>, /origin|Invalid URL/i);
    }
  });

  it("rejects an iframe that has no contentWindow", async () => {
    const iframe = { contentWindow: null } as unknown as HTMLIFrameElement;
    await assert.rejects(
      connect(iframe, { origin: "https://app.test", timeoutMs: 5 }),
      /contentWindow/,
    );
  });

  it("times out when the frame never becomes ready", async () => {
    const { iframe } = harness();
    await assert.rejects(
      connect(iframe, { origin: "https://app.test", timeoutMs: 5 }),
      /timed out/i,
    );
  });

  it("times out a command that receives no acknowledgement", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, {
      origin: "https://app.test",
      requestTimeoutMs: 5,
    });
    receive("ready", {});
    const client = await pending;
    await assert.rejects(client.listLayers(), /response to "listLayers"/i);
    client.disconnect();
  });
});

function assertNoCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /authorization|token|credential|password|secret/i);
    assertNoCredentialFields(child);
  }
}
