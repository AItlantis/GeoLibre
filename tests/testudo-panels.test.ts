import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_DESKTOP_LAYOUT_SETTINGS } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { layoutOptionsFromLocation } from "../apps/geolibre-desktop/src/hooks/useLayoutOptions";
import { acceptsTestudoMessage, isSetPanelsPayload, TESTUDO_COMMANDS } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
import { getTestudoPanels, resetTestudoPanels, setTestudoPanels, TESTUDO_PANELS_DEFAULT, testudoPanelsFromPayload } from "../apps/geolibre-desktop/src/lib/testudo-panels";
import { connect, EMBED_API_SOURCE, EMBED_API_VERSION } from "../packages/embed/src/index";

const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  resetTestudoPanels();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});
const withSearch = (search: string) => { (globalThis as { window?: unknown }).window = { location: { search } }; };
const parent = {} as Window;
const origin = "https://app.testudo.live";
const challenge = "0123456789abcdef0123456789abcdef";
const msg = (payload: Record<string, unknown>) => ({ source: parent, origin, data: { v: 2, source: "testudo", requestId: "1", type: "testudoSetPanels", payload: { challenge, ...payload } } });

describe("testudoSetPanels protocol", () => {
  it("is an allowlisted command", () => assert.ok((TESTUDO_COMMANDS as readonly string[]).includes("testudoSetPanels")));
  it("accepts strict booleans and optional flags", () => {
    assert.equal(acceptsTestudoMessage(msg({ layers: true, plugins: true, comments: true, layersCollapsed: true }), parent, [origin], challenge), true);
    assert.equal(acceptsTestudoMessage(msg({ tviewId: "main", layers: false, plugins: false, comments: true, hostGeoAi: true }), parent, [origin], challenge), true);
    assert.equal(acceptsTestudoMessage(msg({ layers: false, plugins: false, comments: false, results: true }), parent, [origin], challenge), true);
  });
  it("rejects non-booleans, missing keys, unknown keys, other TViews and a bad challenge", () => {
    for (const bad of [
      { layers: "true", plugins: true, comments: true }, { layers: 1, plugins: true, comments: true },
      { layers: true, plugins: true }, { layers: true, plugins: true, comments: true, extra: true },
      { layers: true, plugins: true, comments: true, layersCollapsed: "yes" }, { layers: true, plugins: true, comments: true, tviewId: "other" },
      { layers: true, plugins: true, comments: null },
    ]) assert.equal(acceptsTestudoMessage(msg(bad), parent, [origin], challenge), false, JSON.stringify(bad));
    assert.equal(acceptsTestudoMessage(msg({ layers: true, plugins: true, comments: true, challenge: "x" }), parent, [origin], challenge), false);
    assert.equal(isSetPanelsPayload(null), false);
    assert.equal(isSetPanelsPayload([]), false);
  });
});

describe("panels store and layout", () => {
  it("defaults to all hidden and latest call wins; reset restores the default", () => {
    assert.deepEqual(getTestudoPanels(), TESTUDO_PANELS_DEFAULT);
    assert.equal(testudoPanelsFromPayload({ layers: true, plugins: true, comments: true }).layersCollapsed, true);
    setTestudoPanels(testudoPanelsFromPayload({ layers: true, plugins: true, comments: true, layersCollapsed: false }));
    setTestudoPanels(testudoPanelsFromPayload({ layers: false, plugins: false, comments: true, results: true, hostGeoAi: true }));
    assert.deepEqual(getTestudoPanels(), { layers: false, plugins: false, comments: true, results: true, layersCollapsed: true, hostGeoAi: true });
    resetTestudoPanels();
    assert.deepEqual(getTestudoPanels(), TESTUDO_PANELS_DEFAULT);
  });
  it("layout=testudo is identical to before when the command was never sent", () => {
    withSearch("?layout=testudo");
    const o = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS, TESTUDO_PANELS_DEFAULT);
    assert.deepEqual([o.panelsHidden, o.layerPanelVisible, o.stylePanelVisible, o.attributePanelVisible, o.panelsCollapsed, o.toolbarVisible, o.statusBarVisible], [true, false, false, false, false, false, false]);
  });
  it("Analyse panels show Layers collapsed (rail entry kept) and keep toolbar restrictions", () => {
    withSearch("?layout=testudo");
    const o = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS, testudoPanelsFromPayload({ layers: true, plugins: true, comments: true, layersCollapsed: true }));
    assert.deepEqual([o.panelsHidden, o.layerPanelVisible, o.panelsCollapsed, o.stylePanelVisible, o.attributePanelVisible, o.toolbarVisible, o.statusBarVisible], [false, true, true, false, false, false, false]);
  });
  it("Present panels: Results and Comments keep the docks reachable without Layers", () => {
    withSearch("?layout=testudo");
    const o = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS, testudoPanelsFromPayload({ layers: false, plugins: false, comments: false, results: true }));
    assert.deepEqual([o.panelsHidden, o.layerPanelVisible, o.panelsCollapsed], [false, false, false]);
  });
  it("panels are ignored outside layout=testudo", () => {
    withSearch("");
    const o = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS, testudoPanelsFromPayload({ layers: false, plugins: false, comments: false }));
    assert.equal(o.panelsHidden, false);
    assert.equal(o.layerPanelVisible, true);
  });
});

describe("embed client testudoSetPanels", () => {
  it("sends a strict command and rejects bad payloads locally", async () => {
    class Host extends EventTarget { setTimeout = setTimeout; clearTimeout = clearTimeout; }
    const host = new Host();
    const sent: Array<Record<string, unknown>> = [];
    const frameWindow = { postMessage: (m: Record<string, unknown>) => { sent.push(m); } };
    (globalThis as { window?: unknown }).window = host;
    const iframe = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;
    const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
    const ready = new Event("message");
    Object.defineProperties(ready, { data: { value: { v: EMBED_API_VERSION, source: EMBED_API_SOURCE, type: "ready", payload: { challenge } } }, origin: { value: "https://app.test" }, source: { value: frameWindow } });
    host.dispatchEvent(ready);
    const client = await pending;
    await assert.rejects(client.testudoSetPanels({ layers: "x", plugins: true, comments: true } as never), /booleans/);
    await assert.rejects(client.testudoSetPanels({ layers: true, plugins: true, comments: true, bogus: 1 } as never), /accepts only/);
    void client.testudoSetPanels({ layers: true, plugins: false, comments: true, layersCollapsed: true }).catch(() => undefined);
    const request = sent.at(-1)!;
    assert.equal(request.type, "testudoSetPanels");
    assert.deepEqual(request.payload, { layers: true, plugins: false, comments: true, layersCollapsed: true, challenge });
    client.disconnect();
  });
});
