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
  const sent: Array<{ message: Record<string, unknown>; origin: string }> = [];
  const frameWindow = {
    postMessage(message: Record<string, unknown>, origin: string) {
      sent.push({ message, origin });
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


it("Testudo commands use existing origin-checked acknowledgement and state events", async () => {
  const { iframe, receive, sent } = harness();
  const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
  const challenge = "0123456789abcdef0123456789abcdef";
  receive("ready", { challenge });
  const client = await pending;
  for (const method of ["testudoGetMapControlState", "testudoGetKpiGeometryState", "testudoSetKpiGeometry", "testudoSetLegendVisibility", "testudoSetEsriWorldImagery", "testudoSetRenderer", "testudoOpenAnnotations", "testudoOpenRecordTour", "testudoOpenRecordVideo", "testudoRecordTour", "testudoRecordVideo", "testudoSetViewMode", "testudoSetNetworkFilter"]) {
    assert.equal(typeof client[method as keyof typeof client], "function", `${method} is part of the typed embed client`);
  }
  const state = { package: null, selectedPlugin: null, capabilities: [], status: "empty" };
  const result = client.testudoSetPlugin({ id: "network-kpi" });
  const request = sent.at(-1)!.message;
  assert.equal(request.type, "testudoSetPlugin");
  assert.deepEqual(request.payload, { id: "network-kpi", challenge });
  receive("ack", { requestId: request.requestId, ok: true, result: state });
  assert.deepEqual(await result, state);
  let observed: unknown;
  client.on("testudoStateChanged", value => { observed = value; });
  receive("testudoStateChanged", state);
  assert.deepEqual(observed, state);
  client.disconnect();
});

it("Testudo commands reject when the ready event carries no valid challenge", async () => {
  const { iframe, receive } = harness();
  const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
  receive("ready", {});
  const client = await pending;
  await assert.rejects(client.testudoSetPlugin({ id: "network-kpi" }), /challenge is unavailable/i);
  client.disconnect();
});

it("rejects credential fields from Testudo client payloads", async () => {
  const { iframe, receive } = harness();
  const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
  receive("ready", { challenge: "0123456789abcdef0123456789abcdef" });
  const client = await pending;
  await assert.rejects(client.testudoOpenGeoAiChat({ open: true, bearerToken: "secret" } as unknown as { open: boolean }), /cannot carry credentials/);
  client.disconnect();
});

it("correlates host artifact fetches to the current TView generation", async () => {
  const { iframe, receive, sent } = harness();
  let fetched = "";
  const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100, fetchArtifact: async request => { fetched = request.artifactRef; return new Uint8Array([1, 2]); } });
  const challenge = "0123456789abcdef0123456789abcdef";
  receive("ready", { challenge });
  const client = await pending;
  const views = client.testudoGetTViews();
  const requestId = sent.at(-1)!.message.requestId as string;
  receive("ack", { requestId, ok: true, result: [{ tviewId: "main", generation: 3, loaded: true }] });
  await views;
  receive("testudoArtifactRequest", { challenge, requestId: "artifact-1", tviewId: "main", generation: 3, artifactRef: "data/file.bin" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fetched, "data/file.bin");
  assert.equal(sent.at(-1)?.message.type, "testudoArtifactResponse");
  client.disconnect();
});

it("sends a correlated investigation request and exposes its later update event", async () => {
  const { iframe, receive, sent } = harness();
  const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
  const challenge = "0123456789abcdef0123456789abcdef";
  receive("ready", { challenge });
  const client = await pending;
  let update: unknown;
  client.on("testudoGeoAiInvestigationUpdate", value => { update = value; });
  const accepted = client.testudoRequestInvestigation("Compare scenario 2");
  const request = sent.at(-1)!.message;
  assert.equal(request.type, "testudoRequestInvestigation");
  assert.deepEqual(request.payload, { question: "Compare scenario 2", challenge });
  receive("ack", { requestId: request.requestId, ok: true, result: { requestId: request.requestId, accepted: true } });
  assert.deepEqual(await accepted, { requestId: request.requestId, accepted: true });
  const result = { requestId: request.requestId, question: "Compare scenario 2", status: "complete", summary: { reply: "Done", selectedScenario: { id: 2, name: "Roadworks" } } };
  receive("testudoGeoAiInvestigationUpdate", result);
  assert.deepEqual(update, result);
  const failure = { requestId: request.requestId, question: "Compare scenario 2", status: "error", error: "GeoAI request timed out." };
  receive("testudoGeoAiInvestigationUpdate", failure);
  assert.deepEqual(update, failure);
  client.disconnect();
});
