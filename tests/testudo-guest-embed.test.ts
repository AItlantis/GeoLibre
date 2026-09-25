import test from "node:test";
import assert from "node:assert/strict";
import { acceptsTestudoMessage, availableTestudoModes, hasDeclaredPathIndex, TESTUDO_CHALLENGE_RE, validateTestudoBootstrap } from "../apps/geolibre-desktop/src/lib/testudo-protocol.ts";
import { createSignedPackageSource } from "../apps/geolibre-desktop/src/lib/testudo-source.ts";
import type { TestudoBootstrap } from "../packages/embed/src/testudo.ts";
import { connect } from "../packages/embed/src/index.ts";

const parentOrigin = "https://www.testudo.live";
const childOrigin = "https://app.testudo.live";
const challenge = "0123456789abcdef0123456789abcdef";
const token = "guest_capability_0123456789abcdef";
const parent = {} as Window;
const event = (type: string, payload: unknown, origin = parentOrigin, source: MessageEventSource | null = parent) => ({
  origin, source, data: { v: 2, source: "testudo", type, requestId: "r1", payload },
}) as MessageEvent;

test("guest protocol requires exact source/origin, nonce, narrow command and bounded capability expiry", () => {
  assert.equal(TESTUDO_CHALLENGE_RE.test(challenge), true);
  const capability = { protocol: 1, challenge, guestEmbedToken: token, expiresAt: Date.now() + 60_000 };
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", capability), parent, [parentOrigin], challenge), true);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", { ...capability, challenge: "bad" }), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", { ...capability, expiresAt: Date.now() - 1 }), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", { ...capability, expiresAt: Date.now() + 11 * 60_000 }), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", { ...capability, guestEmbedToken: "x" }), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", capability, "https://evil.test"), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoSetGuestCapability", capability, parentOrigin, {} as Window), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("loadProject", { challenge }), parent, [parentOrigin], challenge), false);
  assert.equal(acceptsTestudoMessage(event("testudoGetState", { challenge }), parent, [parentOrigin], challenge), true);
  assert.equal(acceptsTestudoMessage(event("testudoSetMode", { challenge, mode: "animation" }), parent, [parentOrigin], challenge), true);
  assert.equal(acceptsTestudoMessage(event("testudoSetMode", { challenge, mode: "arbitrary-plugin" }), parent, [parentOrigin], challenge), false);
  assert.deepEqual(availableTestudoModes({ animation: true, flow: true, paths: true, density: true }), ["animation", "flow", "paths", "density"]);
  assert.deepEqual(availableTestudoModes({ animation: false, flow: true, paths: true, density: false }), ["flow", "paths"]);
  assert.notEqual(childOrigin, parentOrigin);
});

test("Paths availability recognizes a multi-scenario path_indices map", () => {
  const pathIndices = { "101": "paths/scenario-101.json", "202": "paths/scenario-202.json" };
  assert.equal(hasDeclaredPathIndex(pathIndices), true);
  assert.equal(hasDeclaredPathIndex("indexed_paths"), true);
  assert.equal(hasDeclaredPathIndex({}), false);
});

test("bootstrap validation preserves every package-declared capability and preset", () => {
  const capabilities = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"]
    .map(id => ({ id, available: true }));
  const presets = [
    { id: "default", plugin: "network-kpi", settings: { metric: "flow" } },
    { id: "routes", plugin: "path-analysis", settings: { visible: true } },
  ];
  const bootstrap = {
    packageId: "London/testudo-package-2026-09-24-website-demo-v1",
    versionId: "32787055-7258-45f0-8593-f8c53e1cc788", label: "London", origin: "published",
    manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
    artifactEndpoint: "/api/v1/view/32787055-7258-45f0-8593-f8c53e1cc788/artifact/",
    capabilities, presets,
  } as TestudoBootstrap;
  const validated = validateTestudoBootstrap(bootstrap, true);
  assert.strictEqual(validated, bootstrap);
  assert.strictEqual(validated.capabilities, capabilities);
  assert.strictEqual(validated.presets, presets);
  assert.equal(validated.capabilities.length, 5);
  assert.equal(validated.presets.length, 2);
  assert.throws(() => validateTestudoBootstrap({ ...bootstrap, versionId: "other", artifactEndpoint: "/api/v1/view/other/artifact/" }, true), /London demo/);
});

test("typed Testudo embed client sends source and challenge for capability and mode commands", async () => {
  const oldWindow = globalThis.window;
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Array<{ message: any; targetOrigin: string }> = [];
  const target = { postMessage(message: any, targetOrigin: string) { sent.push({ message, targetOrigin }); } } as unknown as Window;
  const fakeWindow = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.add(listener as (event: MessageEvent) => void); },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.delete(listener as (event: MessageEvent) => void); },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window;
  Object.assign(globalThis, { window: fakeWindow });
  try {
    const challenge = "0123456789abcdef0123456789abcdef";
    const connection = connect({ contentWindow: target } as HTMLIFrameElement, { origin: childOrigin, timeoutMs: 1000 });
    for (const listener of listeners) listener({ source: target, origin: childOrigin, data: { v: 2, source: "geolibre", type: "ready", payload: { version: "testudo-v1", challenge } } } as MessageEvent);
    const client = await connection;
    const capability = client.testudoSetGuestCapability({ protocol: 1, guestEmbedToken: token, expiresAt: Date.now() + 60_000 });
    assert.equal(sent[0].targetOrigin, childOrigin);
    assert.equal(sent[0].message.v, 2);
    assert.equal(sent[0].message.source, "testudo");
    assert.equal(sent[0].message.type, "testudoSetGuestCapability");
    assert.equal(typeof sent[0].message.requestId, "string");
    assert.deepEqual(sent[0].message.payload, { protocol: 1, guestEmbedToken: token, expiresAt: sent[0].message.payload.expiresAt, challenge });
    const requestId = sent[0].message.requestId;
    for (const listener of listeners) listener({ source: target, origin: childOrigin, data: { v: 2, source: "geolibre", type: "ack", payload: { requestId, ok: true, result: { protocol: 1, challenge, expiresAt: sent[0].message.payload.expiresAt } } } } as MessageEvent);
    assert.deepEqual(await capability, { protocol: 1, challenge, expiresAt: sent[0].message.payload.expiresAt });
    const mode = client.testudoSetMode({ mode: "density" });
    assert.equal(sent[1].message.type, "testudoSetMode");
    assert.equal(sent[1].message.source, "testudo");
    assert.deepEqual(sent[1].message.payload, { challenge, mode: "density" });
    const modeRequestId = sent[1].message.requestId;
    const viewerState = { package: null, selectedPlugin: null, capabilities: [], availableModes: ["density"], status: "ready" };
    for (const listener of listeners) listener({ source: target, origin: childOrigin, data: { v: 2, source: "geolibre", type: "ack", payload: { requestId: modeRequestId, ok: true, result: viewerState } } } as MessageEvent);
    assert.deepEqual(await mode, viewerState);
    client.disconnect();
  } finally { Object.assign(globalThis, { window: oldWindow }); }
});

test("guest package source sends only Testudo-Embed and keeps credential out of URLs", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
    calls.push({ url, authorization });
    if (url.includes("artifact-bytes")) return new Response(new Uint8Array([1, 2, 3]));
    return Response.json({ url: "https://bytes.testudo.live/artifact-bytes/artifact-1", expires_at: Math.floor(Date.now() / 1000) + 60 });
  };
  const source = createSignedPackageSource({
    origin: childOrigin,
    artifactEndpoint: "/api/v1/view/32787055-7258-45f0-8593-f8c53e1cc788/artifact/",
    guestEmbedToken: token,
    byteOrigins: ["https://bytes.testudo.live"],
    signal: new AbortController().signal,
    fetch: mockFetch,
  });
  assert.equal(source.baseUrl, null);
  assert.deepEqual([...new Uint8Array(await source.read("geometry/net.geojson"))], [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.authorization === `Testudo-Embed ${token}`));
  assert.ok(calls.every(call => !call.url.includes(token) && !call.url.includes("token=")));
  assert.equal(calls[0].url, `${childOrigin}/api/v1/view/32787055-7258-45f0-8593-f8c53e1cc788/artifact/geometry/net.geojson`);
  assert.equal(calls[1].url, "https://bytes.testudo.live/artifact-bytes/artifact-1");
});

test("guest source rejects malformed credentials, bearer fallback and credential-bearing byte URLs", async () => {
  const common = { origin: childOrigin, artifactEndpoint: "/api/v1/view/v/artifact/", byteOrigins: ["https://bytes.testudo.live"], signal: new AbortController().signal };
  assert.throws(() => createSignedPackageSource({ ...common, guestEmbedToken: "short" }), /credential/);
  assert.throws(() => createSignedPackageSource({ ...common, bearerToken: "bearer", guestEmbedToken: token }), /exactly one/);
  assert.throws(() => createSignedPackageSource({ ...common }), /exactly one/);
  const source = createSignedPackageSource({ ...common, guestEmbedToken: token, fetch: (async () => Response.json({
    url: "https://bytes.testudo.live/artifact-bytes/id?token=secret", expires_at: Math.floor(Date.now() / 1000) + 60,
  })) as typeof fetch });
  await assert.rejects(source.read("manifest.json"), /Untrusted package byte origin/);
});
