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
  const generations = /* @__PURE__ */ new Map();
  const artifactRequests = /* @__PURE__ */ new Map();
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
    testudoCreateTView: (payload) => sendTestudo("testudoCreateTView", payload),
    testudoDestroyTView: (payload) => sendTestudo("testudoDestroyTView", payload).then((view) => {
      generations.set(view.tviewId, view.generation);
      return view;
    }),
    testudoGetTView: (payload) => sendTestudo("testudoGetTView", payload).then((view) => {
      generations.set(view.tviewId, view.generation);
      return view;
    }),
    testudoGetTViews: () => sendTestudo("testudoGetTViews").then((views) => {
      for (const view of views) generations.set(view.tviewId, view.generation);
      return views;
    }),
    testudoSetActiveTView: (payload) => sendTestudo("testudoSetActiveTView", payload),
    testudoGetActiveTView: () => sendTestudo("testudoGetActiveTView"),
    testudoSetGuestCapability: (payload) => sendTestudo("testudoSetGuestCapability", payload),
    testudoLoadPackage: (payload) => sendTestudo("testudoLoadPackage", { ...payload, tviewId: payload.tviewId ?? "main" }),
    testudoOpenLocalPackage: () => sendTestudo("testudoOpenLocalPackage"),
    testudoSetPlugin: (payload) => sendTestudo("testudoSetPlugin", payload),
    testudoSetMode: (payload) => sendTestudo("testudoSetMode", payload),
    testudoOpenGeoAiChat: (payload) => sendTestudo("testudoOpenGeoAiChat", payload),
    testudoRequestInvestigation: (question) => {
      if (typeof question !== "string" || !question.trim() || question.length > 4e3) {
        return Promise.reject(new Error("Investigation question must be nonblank and at most 4000 characters"));
      }
      return sendTestudo("testudoRequestInvestigation", { question });
    },
    testudoSetPreset: (payload) => sendTestudo("testudoSetPreset", payload),
    testudoGetState: () => sendTestudo("testudoGetState"),
    testudoSetScenario: (payload) => sendTestudo("testudoSetScenario", payload),
    testudoSetScenarioPair: (payload) => sendTestudo("testudoSetScenarioPair", payload),
    testudoSetPlaybackPlaying: (payload) => sendTestudo("testudoSetPlaybackPlaying", payload),
    testudoRestartPlayback: (payload) => sendTestudo("testudoRestartPlayback", payload),
    testudoSeekPlayback: (payload) => sendTestudo("testudoSeekPlayback", payload),
    testudoSetPlaybackSpeed: (payload) => sendTestudo("testudoSetPlaybackSpeed", payload),
    testudoGetPlaybackState: (payload) => sendTestudo("testudoGetPlaybackState", payload),
    testudoSetCameraView: (payload) => sendTestudo("testudoSetCameraView", payload),
    testudoGetCameraView: (payload) => sendTestudo("testudoGetCameraView", payload),
    testudoFeatureRequestInvestigation: (payload) => sendTestudo("testudoFeatureRequestInvestigation", payload),
    testudoRespondGeoAIRequest: (payload) => sendTestudo("testudoRespondGeoAIRequest", payload),
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
      for (const operation of artifactRequests.values()) operation.controller.abort();
      artifactRequests.clear();
    }
  };
  const sendTestudo = (type, payload = {}) => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    if (!testudoChallenge || !/^[a-f0-9]{32}$/.test(testudoChallenge)) return Promise.reject(new Error("The Testudo viewer challenge is unavailable"));
    if (type !== "testudoSetGuestCapability" && containsCredentialField(payload)) return Promise.reject(new Error("Embed messages cannot carry credentials."));
    if (type === "testudoLoadPackage" && typeof payload.tviewId === "string") generations.set(payload.tviewId, (generations.get(payload.tviewId) ?? 0) + 1);
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
    if (type === "testudoArtifactRequest") {
      void handleArtifactRequest(data);
      return;
    }
    if (type === "testudoStateChanged" && typeof payload.tviewId === "string" && typeof payload.generation === "number") generations.set(payload.tviewId, payload.generation);
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
  const handleArtifactRequest = async (message) => {
    const payload = message.payload;
    if (!isRecord(payload) || !testudoChallenge || payload.challenge !== testudoChallenge || containsCredentialField(payload)) return;
    const { requestId, tviewId, generation, artifactRef } = payload;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200 || typeof tviewId !== "string" || !tviewId || tviewId.length > 120 || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || typeof artifactRef !== "string" || !isSafeArtifactReference(artifactRef) || generations.get(tviewId) !== generation || artifactRequests.has(requestId)) return;
    const request = { requestId, tviewId, generation, artifactRef };
    const operation = { request, controller: new AbortController() };
    artifactRequests.set(requestId, operation);
    let bytes;
    let error;
    try {
      if (!options.fetchArtifact) throw new Error("The host has no artifact fetcher configured.");
      const fetched = await options.fetchArtifact({ tviewId, generation, artifactRef }, operation.controller.signal);
      if (operation.controller.signal.aborted || artifactRequests.get(requestId) !== operation || generations.get(tviewId) !== generation) return;
      bytes = fetched instanceof ArrayBuffer ? fetched : fetched instanceof Blob ? await fetched.arrayBuffer() : fetched.buffer.slice(fetched.byteOffset, fetched.byteOffset + fetched.byteLength);
    } catch (caught) {
      error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 1e3);
    }
    if (operation.controller.signal.aborted || artifactRequests.get(requestId) !== operation || generations.get(tviewId) !== generation || !testudoChallenge) return;
    artifactRequests.delete(requestId);
    const response = { v: EMBED_API_VERSION, source: "testudo", type: "testudoArtifactResponse", payload: { ...request, challenge: testudoChallenge, ...bytes ? { bytes } : { error: error ?? "Artifact fetch failed." } } };
    try {
      target.postMessage(response, origin, bytes ? [bytes] : []);
    } catch {
      target.postMessage(response, origin);
    }
  };
  window.addEventListener("message", receive);
  const timer = window.setTimeout(() => {
    client.disconnect();
    readyReject?.(new Error("Timed out waiting for GeoLibre"));
  }, options.timeoutMs ?? 15e3);
  return ready.finally(() => window.clearTimeout(timer));
}
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function containsCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /authorization|token|credential|password|secret/i.test(key) || containsCredentialField(child));
}
function isSafeArtifactReference(value) {
  if (!value.trim() || value.length > 2048 || /[?#\\\u0000-\u001f]/.test(value) || value.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  try {
    return !decodeURIComponent(value).split("/").some((part) => part === "..");
  } catch {
    return false;
  }
}
export {
  EMBED_API_SOURCE,
  EMBED_API_VERSION,
  connect
};
