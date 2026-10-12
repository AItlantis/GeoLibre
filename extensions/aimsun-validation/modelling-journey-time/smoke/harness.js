// Headless-Chrome smoke harness that loads a BUILT drop-in plugin exactly the way GeoLibre does
// (apps/geolibre-desktop/src/lib/external-plugins.ts): fetch plugin.json -> fetch entry text -> Blob -> import(blobUrl),
// checks the exported plugin against the manifest, injects style.css, activates it with a mock GeoLibreAppAPI and
// renders the registered right panel. Query: ?cases=<module under /smoke/>&case=<name>
const out = document.getElementById("out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, msg) {
  if (!cond) throw new Error("assertion failed: " + msg);
}
export const near = (a, b, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps;

export async function waitFor(fn, what, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      /* not yet */
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for " + what);
    await sleep(100);
  }
}

/** Mock GeoLibreAppAPI recording what the plugin does. */
export function makeApp({ withMap = true, pseudoLocale = false } = {}) {
  const st = { panels: new Map(), opened: [], layers: [], calls: [], locale: "en", listeners: new Set(), keys: new Set(), setDataCalls: 0, sources: new Map(), mapLayers: new Map(), mapHandlers: new Map() };
  const map = {
    addSource(id, s) {
      st.sources.set(id, { ...s, setData(d) { this.data = d; st.setDataCalls++; } });
    },
    addLayer(l) {
      st.mapLayers.set(l.id, l);
    },
    getSource: (id) => st.sources.get(id),
    getLayer: (id) => st.mapLayers.get(id),
    removeLayer: (id) => st.mapLayers.delete(id),
    removeSource: (id) => st.sources.delete(id),
    on: (e, h) => st.mapHandlers.set(e, h),
    off: (e) => st.mapHandlers.delete(e),
  };
  const app = {
    addGeoJsonLayer(name, data) {
      st.layers.push({ name, data });
      return "layer-" + st.layers.length;
    },
    getMap: withMap ? () => map : () => null,
    fitBounds: (b) => st.calls.push(["fitBounds", b]),
    registerRightPanel(p) {
      st.panels.set(p.id, p);
      return () => st.panels.delete(p.id);
    },
    unregisterRightPanel: (id) => st.panels.delete(id),
    openRightPanel(id) {
      st.opened.push(id);
      return st.panels.has(id);
    },
    getLocale: () => st.locale,
    onLocaleChange(l) {
      st.listeners.add(l);
      return () => st.listeners.delete(l);
    },
    translate(key, def, params) {
      st.keys.add(key);
      const text = params ? def.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in params ? String(params[k]) : m)) : def;
      return pseudoLocale && st.locale !== "en" ? "«" + text + "»" : text;
    },
  };
  return { app, st, setLocale(l) { st.locale = l; for (const f of [...st.listeners]) f(l); } };
}

/** fetch -> Blob -> import, as the host does. */
export async function loadPlugin(id) {
  const manifestUrl = new URL(`/plugins/${id}/plugin.json`, location.href).href;
  const manifest = await (await fetch(manifestUrl)).json();
  const entrySource = await (await fetch(new URL(manifest.entry, manifestUrl))).text();
  assert(entrySource.length < 50 * 1024 * 1024, "entry under MAX_PLUGIN_ASSET_BYTES");
  const style = manifest.style ? await (await fetch(new URL(manifest.style, manifestUrl))).text() : null;
  const moduleUrl = URL.createObjectURL(new Blob([entrySource], { type: "text/javascript" }));
  let mod;
  try {
    mod = await import(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const plugin = mod.default ?? mod.plugin;
  assert(plugin && typeof plugin.id === "string" && typeof plugin.name === "string" && typeof plugin.version === "string", "default export is a plugin");
  assert(typeof plugin.activate === "function" && typeof plugin.deactivate === "function", "activate/deactivate");
  assert(plugin.id === manifest.id && plugin.name === manifest.name && plugin.version === manifest.version, "plugin matches plugin.json");
  assert(!plugin.activeByDefault, "no activeByDefault");
  if (style) {
    const el = document.createElement("style");
    el.dataset.plugin = id;
    el.textContent = style;
    document.head.append(el);
  }
  return { plugin, manifest, style };
}

/** loadPlugin + activate + render the registered panel into #host. */
export async function startPlugin(id, appOpts = {}) {
  const { plugin, manifest, style } = await loadPlugin(id);
  const ctl = makeApp(appOpts);
  await plugin.activate(ctl.app);
  const panel = ctl.st.panels.get(id);
  assert(panel, "panel registered");
  const container = document.createElement("div");
  container.id = "panel-" + id;
  document.getElementById("host").append(container);
  const cleanup = panel.render(container);
  return { plugin, manifest, style, panel, container, cleanup, ...ctl };
}

export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];

/** Dispatch a change on a form control like a user would. */
export function setValue(el, value, evt = "change") {
  el.value = value;
  el.dispatchEvent(new Event(evt, { bubbles: true }));
}

/** Put File objects (fetched from the server) into an <input type=file> and fire change. */
export async function pickFiles(input, urls) {
  const dt = new DataTransfer();
  for (const u of urls) {
    const r = await fetch(u);
    assert(r.ok, "fetch " + u);
    dt.items.add(new File([await r.arrayBuffer()], u.split("/").pop()));
  }
  Object.defineProperty(input, "files", { value: dt.files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const params = new URLSearchParams(location.search);
if (params.get("cases")) {
  try {
    const cases = await import(new URL(params.get("cases"), location.href).href);
    const name = params.get("case");
    assert(cases[name], "unknown case " + name);
    const result = await cases[name]({ assert, near, waitFor, startPlugin, loadPlugin, makeApp, $, $$, setValue, pickFiles, sleep });
    out.textContent = "OK " + name + " " + JSON.stringify(result ?? {});
  } catch (e) {
    out.textContent = "FAIL " + ((e && e.stack) || e);
  }
}
