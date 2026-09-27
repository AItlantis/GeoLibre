// packages/embed/src/index.ts
var EMBED_API_VERSION = 2;
var EMBED_API_SOURCE = "geolibre";
function validOrigin(value) {
  const origin = new URL(value).origin;
  if (origin === "null") throw new Error("origin must be an http(s) origin");
  return origin;
}
function connect(iframe, options) {
  let origin;
  try {
    origin = validOrigin(options.origin);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const target = iframe.contentWindow;
  if (!target) return Promise.reject(new Error("The iframe has no contentWindow"));
  let sequence = 0;
  let testudoChallenge = null;
  let disconnected = false;
  const pending = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Map();
  const send = (type, payload = {}) => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    const requestId = `geolibre-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, type, payload, requestId }, origin);
    return new Promise((resolve, reject) => {
      const timer2 = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for a response to "${type}"`));
      }, options.requestTimeoutMs ?? 15e3);
      pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer2);
          resolve(value);
        },
        reject: (reason) => {
          window.clearTimeout(timer2);
          reject(reason);
        }
      });
    });
  };
  let readyResolve = null;
  let readyReject = null;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const client = {
    testudoSetGuestCapability: (payload) => sendTestudo("testudoSetGuestCapability", payload),
    testudoLoadPackage: (payload) => sendTestudo("testudoLoadPackage", { ...payload }),
    testudoSetPlugin: (payload) => sendTestudo("testudoSetPlugin", payload),
    testudoSetMode: (payload) => sendTestudo("testudoSetMode", payload),
    testudoSetPreset: (payload) => sendTestudo("testudoSetPreset", payload),
    testudoGetState: () => sendTestudo("testudoGetState"),
    loadProject: (url) => send("loadProject", { url }),
    setView: (target2) => send("setView", target2),
    highlightFeature: (payload) => send("highlightFeature", payload),
    openTool: (id, params = {}) => send("openTool", { id, params }),
    setLayerVisibility: (layerId, visible) => send("setLayerVisibility", { layerId, visible }),
    listLayers: () => send("listLayers"),
    setFilter: (layerId, expression) => send("setFilter", { layerId, expression }),
    setRenderer: (renderer) => send("setRenderer", { renderer }),
    getRenderer: () => send("getRenderer"),
    getViewport: () => send("getViewport"),
    addLayer: (spec) => send("addLayer", { spec }),
    addData: (url, options2 = {}) => send("addData", { url, ...options2 }),
    exportImage: () => send("exportImage"),
    on: (type, listener) => {
      const set = listeners.get(type) ?? /* @__PURE__ */ new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    },
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      window.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(new Error("Client disconnected"));
      pending.clear();
      listeners.clear();
    }
  };
  const sendTestudo = (type, payload = {}) => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    if (!testudoChallenge || !/^[a-f0-9]{32}$/.test(testudoChallenge)) return Promise.reject(new Error("The Testudo viewer challenge is unavailable"));
    const requestId = `testudo-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, source: "testudo", type, payload: { ...payload, challenge: testudoChallenge }, requestId }, origin);
    return new Promise((resolve, reject) => {
      const timer2 = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for a response to "${type}"`));
      }, options.requestTimeoutMs ?? 15e3);
      pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer2);
          resolve(value);
        },
        reject: (reason) => {
          window.clearTimeout(timer2);
          reject(reason);
        }
      });
    });
  };
  const receive = (event) => {
    if (event.source !== target || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.source !== EMBED_API_SOURCE || data.v !== EMBED_API_VERSION) return;
    const type = data.type;
    const payload = data.payload ?? {};
    if (type === "ack") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
      const request = requestId ? pending.get(requestId) : void 0;
      if (requestId && request) {
        pending.delete(requestId);
        if (payload.ok === true) request.resolve(payload.result);
        else request.reject(new Error(String(payload.error ?? "GeoLibre request failed")));
      }
    } else if (type === "ready") {
      const challenge = typeof payload.challenge === "string" ? payload.challenge : null;
      testudoChallenge = challenge && /^[a-f0-9]{32}$/.test(challenge) ? challenge : null;
      readyResolve?.(client);
    }
    for (const listener of listeners.get(type) ?? []) listener(payload);
  };
  window.addEventListener("message", receive);
  const timer = window.setTimeout(() => {
    client.disconnect();
    readyReject?.(new Error("Timed out waiting for GeoLibre"));
  }, options.timeoutMs ?? 15e3);
  return ready.finally(() => window.clearTimeout(timer));
}
export {
  EMBED_API_SOURCE,
  EMBED_API_VERSION,
  connect
};
