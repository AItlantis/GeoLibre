import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";
import {
  acceptsTestudoMessage,
  isValidAnalysisBootstrap,
  TESTUDO_ANALYSIS_PLUGIN_IDS,
  TESTUDO_COMMANDS,
  validateTestudoBootstrap,
} from "../apps/geolibre-desktop/src/lib/testudo-protocol";
import { StaleAnalysisGenerationError, TestudoAnalysisController } from "../apps/geolibre-desktop/src/lib/testudo-analysis";
import { TESTUDO_BLOCKED_PLUGIN_IDS } from "../apps/geolibre-desktop/src/lib/testudo-mode";

const parent = {} as Window;
const origin = "https://app.testudo.live";
const challenge = "0123456789abcdef0123456789abcdef";
const BASE = "https://testudo.example/api/v1/view/v1/artifact/analysis/";
const MANIFEST = `${BASE}run1/analysis_manifest.json`;

function message(type: string, payload: Record<string, unknown>) {
  return { source: parent, origin, data: { v: 2, source: "testudo", requestId: "1", type, payload: { challenge, ...payload } } };
}
const accepts = (type: string, payload: Record<string, unknown>) => acceptsTestudoMessage(message(type, payload), parent, [origin], challenge);

function analysisBlock(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    baseUrl: BASE,
    runs: [{ run: "run1", label: "Run 1", available: true, manifest: "run1/analysis_manifest.json" }, { run: "run2", label: "Run 2", available: false, reason: "No data", manifest: "run2/analysis_manifest.json" }],
    plugins: {
      "analysis-counts": { pluginId: "modelling-count-manager", available: true },
      "analysis-od": { pluginId: "modelling-od-trips", available: false, reason: "No OD" },
      "analysis-journey-time": { pluginId: "modelling-journey-time", available: true },
    },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}
function bootstrap(extra: Record<string, unknown> = {}) {
  return {
    packageId: "pkg", versionId: "v1", label: "Package", origin: "published",
    manifestPath: "manifest.json", nativeManifestPath: "geolibre/package.json",
    artifactEndpoint: "/api/v1/view/v1/artifact/",
    capabilities: [{ id: "network-kpi", available: true }], presets: [], ...extra,
  } as unknown as Parameters<typeof validateTestudoBootstrap>[0];
}

describe("Analyse bootstrap validation", () => {
  it("still accepts an old bootstrap without `analysis`", () => {
    assert.doesNotThrow(() => validateTestudoBootstrap(bootstrap(), false));
  });
  it("accepts the three analysis capability ids and a well-formed analysis block", () => {
    const capabilities = Object.keys(TESTUDO_ANALYSIS_PLUGIN_IDS).map(id => ({ id, available: true }));
    assert.doesNotThrow(() => validateTestudoBootstrap(bootstrap({ capabilities, analysis: analysisBlock() }), false));
    assert.deepEqual(TESTUDO_ANALYSIS_PLUGIN_IDS, {
      "analysis-counts": "modelling-count-manager", "analysis-od": "modelling-od-trips", "analysis-journey-time": "modelling-journey-time",
    });
  });
  it("accepts an ISO expiresAt and http localhost", () => {
    assert.equal(isValidAnalysisBootstrap(analysisBlock({ expiresAt: "2099-01-01T00:00:00Z", baseUrl: "http://localhost:8080/a/" })), true);
  });
  it("rejects malformed analysis blocks", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["schemaVersion", { schemaVersion: 2 }],
      ["baseUrl without trailing slash", { baseUrl: BASE.slice(0, -1) }],
      ["relative baseUrl", { baseUrl: "/analysis/" }],
      ["http non-local baseUrl", { baseUrl: "http://evil.example/a/" }],
      ["baseUrl with credentials", { baseUrl: "https://user:pw@testudo.example/a/" }],
      ["runs not an array", { runs: {} }],
      ["run missing manifest", { runs: [{ run: "r", label: "R", available: true }] }],
      ["absolute manifest", { runs: [{ run: "r", label: "R", available: true, manifest: "https://evil.example/m.json" }] }],
      ["parent-dir manifest", { runs: [{ run: "r", label: "R", available: true, manifest: "../m.json" }] }],
      ["duplicate run", { runs: [{ run: "r", label: "R", available: true, manifest: "a.json" }, { run: "r", label: "R", available: true, manifest: "b.json" }] }],
      ["non-boolean available", { runs: [{ run: "r", label: "R", available: "yes", manifest: "a.json" }] }],
      ["unknown capability key", { plugins: { "analysis-other": { pluginId: "modelling-od-trips", available: true } } }],
      ["mismatched pluginId", { plugins: { "analysis-od": { pluginId: "modelling-count-manager", available: true } } }],
      ["plugin availability not boolean", { plugins: { "analysis-od": { pluginId: "modelling-od-trips" } } }],
      ["missing expiresAt", { expiresAt: undefined }],
      ["garbage expiresAt", { expiresAt: "soon" }],
    ];
    for (const [name, patch] of bad) {
      assert.equal(isValidAnalysisBootstrap(analysisBlock(patch)), false, name);
      assert.throws(() => validateTestudoBootstrap(bootstrap({ analysis: analysisBlock(patch) }), false), /Invalid Testudo package bootstrap/, name);
    }
    assert.equal(isValidAnalysisBootstrap(null), false);
    assert.equal(isValidAnalysisBootstrap([]), false);
  });
  it("still rejects an unknown capability id", () => {
    assert.throws(() => validateTestudoBootstrap(bootstrap({ capabilities: [{ id: "analysis-bogus", available: true }] }), false), /Invalid/);
  });
});

describe("Analyse commands in the protocol", () => {
  it("lists both commands", () => {
    assert.ok(TESTUDO_COMMANDS.includes("testudoOpenAnalysis" as never));
    assert.ok(TESTUDO_COMMANDS.includes("testudoCloseAnalysis" as never));
  });
  it("accepts well-formed open and close payloads for each plugin", () => {
    for (const plugin of Object.values(TESTUDO_ANALYSIS_PLUGIN_IDS)) {
      assert.equal(accepts("testudoOpenAnalysis", { plugin, manifestUrl: MANIFEST, run: "run1", generation: 1 }), true, plugin);
      assert.equal(accepts("testudoCloseAnalysis", { plugin }), true, plugin);
    }
  });
  it("rejects malformed or unauthenticated payloads", () => {
    const ok = { plugin: "modelling-od-trips", manifestUrl: MANIFEST, run: "run1", generation: 1 };
    for (const patch of [
      { plugin: "vehicle-playback" }, { plugin: "analysis-od" }, { plugin: undefined },
      { manifestUrl: "javascript:alert(1)" }, { manifestUrl: "http://evil.example/m.json" }, { manifestUrl: "/relative.json" }, { manifestUrl: 3 },
      { run: "" }, { run: 7 }, { generation: 0 }, { generation: 1.5 }, { generation: "1" }, { extra: true },
    ]) assert.equal(accepts("testudoOpenAnalysis", { ...ok, ...patch }), false, JSON.stringify(patch));
    assert.equal(accepts("testudoCloseAnalysis", { plugin: "nope" }), false);
    assert.equal(accepts("testudoCloseAnalysis", { plugin: "modelling-od-trips", extra: 1 }), false);
    assert.equal(accepts("testudoOpenAnalysis", { ...ok, challenge: "f".repeat(32) }), false);
    assert.equal(accepts("testudoOpenAnalysis", { ...ok, token: "x" }), false);
  });
  it("still rejects unknown commands", () => {
    assert.equal(accepts("testudoOpenAnalysisAll", { plugin: "modelling-od-trips" }), false);
  });
  it("does not block the analysis plugins in the Testudo layout", () => {
    for (const plugin of Object.values(TESTUDO_ANALYSIS_PLUGIN_IDS)) assert.ok(!(TESTUDO_BLOCKED_PLUGIN_IDS as readonly string[]).includes(plugin));
  });
});

type Call = { id: string; params?: Record<string, string> };
function stubHost(overrides: { open?: (id: string) => Promise<boolean> } = {}) {
  const opens: Call[] = [];
  const closes: string[] = [];
  return {
    opens, closes,
    host: {
      openWithParams: async (id: string, params: Record<string, string>) => { opens.push({ id, params }); return overrides.open ? overrides.open(id) : true; },
      deactivate: (id: string) => { closes.push(id); },
    },
  };
}
function controller(host: ReturnType<typeof stubHost>["host"], now = () => Date.now()) {
  const events: unknown[] = [];
  const c = new TestudoAnalysisController(host, {} as GeoLibreAppAPI, status => events.push(status), now);
  c.setPackage(analysisBlock() as never);
  return { c, events };
}
const open = (plugin: string, generation: number, extra: Record<string, unknown> = {}) =>
  ({ plugin, manifestUrl: MANIFEST, run: "run1", generation, ...extra }) as never;

describe("TestudoAnalysisController", () => {
  it("opens only the targeted plugin with the manifest and run and replies with a status", async () => {
    const { host, opens } = stubHost();
    const { c, events } = controller(host);
    const status = await c.open(open("modelling-count-manager", 1));
    assert.deepEqual(status, { plugin: "modelling-count-manager", status: "open", run: "run1", generation: 1 });
    assert.deepEqual(opens, [{ id: "modelling-count-manager", params: { aimsunPackage: MANIFEST, aimsunRun: "run1" } }]);
    assert.deepEqual(events, [status]);
    assert.equal(c.isOpen("modelling-count-manager"), true);
    assert.equal(c.isOpen("modelling-od-trips"), false);
  });

  it("rejects stale or repeated generations per plugin, independently across plugins", async () => {
    const { host, opens } = stubHost();
    const { c, events } = controller(host);
    await c.open(open("modelling-count-manager", 5));
    await assert.rejects(c.open(open("modelling-count-manager", 5)), StaleAnalysisGenerationError);
    await assert.rejects(c.open(open("modelling-count-manager", 4)), StaleAnalysisGenerationError);
    await c.open(open("modelling-journey-time", 1)); // another plugin keeps its own counter
    await c.open(open("modelling-count-manager", 6));
    assert.equal(opens.length, 3);
    assert.equal(events.filter(e => (e as { status: string }).status === "error").length, 0, "stale rejections are not announced");
  });

  it("keeps rejecting an old generation after the plugin was closed", async () => {
    const { host } = stubHost();
    const { c } = controller(host);
    await c.open(open("modelling-count-manager", 3));
    c.close({ plugin: "modelling-count-manager" });
    await assert.rejects(c.open(open("modelling-count-manager", 3)), StaleAnalysisGenerationError);
    await c.open(open("modelling-count-manager", 4));
  });

  it("tears down on testudoCloseAnalysis", async () => {
    const { host, closes } = stubHost();
    const { c, events } = controller(host);
    await c.open(open("modelling-journey-time", 1));
    const status = c.close({ plugin: "modelling-journey-time" });
    assert.deepEqual(status, { plugin: "modelling-journey-time", status: "closed" });
    assert.deepEqual(closes, ["modelling-journey-time"]);
    assert.equal(c.isOpen("modelling-journey-time"), false);
    assert.deepEqual(events.at(-1), status);
  });

  it("tears every open plugin down and resets generations on a package switch", async () => {
    const { host, closes } = stubHost();
    const { c } = controller(host);
    await c.open(open("modelling-count-manager", 7));
    await c.open(open("modelling-journey-time", 2));
    c.setPackage(analysisBlock() as never);
    assert.deepEqual([...closes].sort(), ["modelling-count-manager", "modelling-journey-time"]);
    assert.equal(c.isOpen("modelling-count-manager"), false);
    await c.open(open("modelling-count-manager", 1)); // counter restarted for the new package
    c.setPackage(null);
    await assert.rejects(c.open(open("modelling-count-manager", 2)), /declares no analysis/);
  });

  it("enforces the declared analysis: plugin, run, manifest origin and expiry", async () => {
    const { host, opens } = stubHost();
    const { c, events } = controller(host);
    await assert.rejects(c.open(open("modelling-od-trips", 1)), /No OD/);
    await assert.rejects(c.open(open("modelling-count-manager", 1, { run: "run2" })), /No data/);
    await assert.rejects(c.open(open("modelling-count-manager", 2, { run: "unknown" })), /unavailable/);
    await assert.rejects(c.open(open("modelling-count-manager", 3, { manifestUrl: "https://evil.example/analysis/run1/analysis_manifest.json" })), /outside/);
    assert.equal(opens.length, 0);
    assert.equal(events.filter(e => (e as { status: string }).status === "error").length, 4);
    const expired = controller(host, () => Date.now() + 3_600_000);
    await assert.rejects(expired.c.open(open("modelling-count-manager", 1)), /expired/);
  });

  it("reports an error status when the plugin cannot be opened or throws", async () => {
    const refused = controller(stubHost({ open: async () => false }).host);
    await assert.rejects(refused.c.open(open("modelling-count-manager", 1)), /could not be opened/);
    assert.equal((refused.events.at(-1) as { status: string }).status, "error");
    assert.equal(refused.c.isOpen("modelling-count-manager"), false);
    const failing = controller(stubHost({ open: async () => { throw new Error("boom"); } }).host);
    await assert.rejects(failing.c.open(open("modelling-count-manager", 1)), /boom/);
    assert.deepEqual(failing.events.at(-1), { plugin: "modelling-count-manager", status: "error", run: "run1", generation: 1, error: "boom" });
  });

  it("closes a plugin whose open was still loading when it was closed", async () => {
    let release!: (value: boolean) => void;
    const { host, closes } = stubHost({ open: () => new Promise<boolean>(resolve => { release = resolve; }) });
    const { c } = controller(host);
    const pending = c.open(open("modelling-count-manager", 1));
    c.close({ plugin: "modelling-count-manager" });
    release(true);
    await assert.rejects(pending, /superseded/);
    assert.equal(c.isOpen("modelling-count-manager"), false);
    assert.equal(closes.length >= 2, true, "deactivated again after the late activation");
  });
});

describe("PluginManager.openWithParams (targeted open)", () => {
  const app = {} as GeoLibreAppAPI;
  function plugin(id: string, log: string[]): GeoLibrePlugin {
    return {
      id, name: id, version: "0.0.1", urlParameterNames: ["aimsunPackage"],
      activate: () => { log.push(`activate:${id}`); },
      deactivate: () => { log.push(`deactivate:${id}`); },
      handleUrlParameters: (_app, params) => { log.push(`params:${id}:${params.get("aimsunPackage")}:${params.get("aimsunRun")}`); },
    };
  }
  it("activates and dispatches only the target although every plugin owns the parameter", async () => {
    const log: string[] = [];
    const manager = new PluginManager();
    for (const id of Object.values(TESTUDO_ANALYSIS_PLUGIN_IDS)) manager.register(plugin(id, log));
    const opened = await manager.openWithParams("modelling-od-trips", { aimsunPackage: MANIFEST, aimsunRun: "run1" }, app);
    assert.equal(opened, true);
    assert.deepEqual(log, ["activate:modelling-od-trips", `params:modelling-od-trips:${MANIFEST}:run1`]);
    assert.equal(manager.isActive("modelling-count-manager"), false);
    assert.equal(manager.isActive("modelling-journey-time"), false);
  });
  it("does not reactivate an active plugin, and re-dispatches for a new run", async () => {
    const log: string[] = [];
    const manager = new PluginManager();
    manager.register(plugin("modelling-count-manager", log));
    await manager.openWithParams("modelling-count-manager", { aimsunPackage: MANIFEST, aimsunRun: "run1" }, app);
    await manager.openWithParams("modelling-count-manager", { aimsunPackage: MANIFEST, aimsunRun: "run2" }, app);
    assert.deepEqual(log.filter(entry => entry.startsWith("activate")), ["activate:modelling-count-manager"]);
    assert.equal(log.filter(entry => entry.startsWith("params")).length, 2);
  });
  it("returns false for an unknown plugin or one without a URL handler", async () => {
    const manager = new PluginManager();
    manager.register({ id: "plain", name: "plain", version: "0", activate: () => undefined, deactivate: () => undefined });
    assert.equal(await manager.openWithParams("missing", {}, app), false);
    assert.equal(await manager.openWithParams("plain", {}, app), false);
    assert.equal(manager.isActive("plain"), false);
  });
  it("propagates a throwing handler", async () => {
    const manager = new PluginManager();
    manager.register({ ...plugin("modelling-count-manager", []), handleUrlParameters: () => { throw new Error("load failed"); } });
    await assert.rejects(manager.openWithParams("modelling-count-manager", {}, app), /load failed/);
  });
  it("integrates with the controller: teardown deactivates through the manager", async () => {
    const log: string[] = [];
    const manager = new PluginManager();
    for (const id of Object.values(TESTUDO_ANALYSIS_PLUGIN_IDS)) manager.register(plugin(id, log));
    const c = new TestudoAnalysisController(manager, app);
    c.setPackage(analysisBlock() as never);
    await c.open(open("modelling-journey-time", 1));
    assert.equal(manager.isActive("modelling-journey-time"), true);
    c.setPackage(null);
    assert.equal(manager.isActive("modelling-journey-time"), false);
    assert.ok(log.includes("deactivate:modelling-journey-time"));
  });
});

describe("TestudoControls wiring (source text)", () => {
  const source = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  it("lists the analysis capability ids but keeps them out of the map-plugin tables", () => {
    const ids = source.match(/const ids: TestudoCapabilityId\[\] = \[([^\]]+)\]/)![1];
    for (const id of Object.keys(TESTUDO_ANALYSIS_PLUGIN_IDS)) assert.ok(ids.includes(`"${id}"`), id);
    const feature = source.match(/const featureCapabilityIds: TestudoCapabilityId\[\] = \[([^\]]+)\]/)![1];
    assert.ok(!feature.includes("analysis-"));
    assert.match(source, /!isTestudoAnalysisCapabilityId\(id\)/);
  });
  it("routes the two commands to the analysis controller, never through the global URL loop", () => {
    assert.match(source, /request\.type === "testudoCloseAnalysis"\) return analysis\.close\(request\.payload\)/);
    assert.match(source, /return await analysis\.open\(request\.payload\)/);
    assert.match(source, /new TestudoAnalysisController\(analysisHost, app/);
    assert.match(source, /analysisManager\.openWithParams\(id, params, appApi\)/);
    assert.ok(!/handleUrlParameters/.test(source));
    assert.match(source, /analysis\.setPackage\(null\);/);
    assert.match(source, /analysis\.teardown\(\)/);
  });
});
