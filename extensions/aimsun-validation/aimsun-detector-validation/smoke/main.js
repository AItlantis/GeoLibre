// Headless smoke: loads the BUILT drop-ins the way GeoLibre does (fetch plugin.json -> fetch entry
// text -> Blob -> import(blobUrl)), activates them against a mock host, loads the real AMPK_3 /
// PMPK_3 parquet through ?aimsunPackage-style URL handling and asserts what the panels show.
const out = document.getElementById("out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}
const check = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT ${msg}`);
};

async function loadPlugin(id) {
  const manifestUrl = `/plugins/${id}/plugin.json`;
  const manifest = await (await fetch(manifestUrl, { cache: "no-cache" })).json();
  const entry = await (await fetch(new URL(manifest.entry, new URL(manifestUrl, location.href)).href, { cache: "no-cache" })).text();
  const style = manifest.style ? await (await fetch(new URL(manifest.style, new URL(manifestUrl, location.href)).href)).text() : null;
  if (style) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
  const url = URL.createObjectURL(new Blob([entry], { type: "text/javascript" }));
  const mod = await import(url);
  URL.revokeObjectURL(url);
  const plugin = mod.default ?? mod.plugin;
  check(plugin.id === manifest.id && plugin.name === manifest.name && plugin.version === manifest.version, `${id}: plugin matches plugin.json`);
  check(!plugin.activeByDefault, "no activeByDefault");
  return plugin;
}

function mockMap(container) {
  const handlers = new Map();
  const m = {
    sources: new Map(),
    layers: new Map(),
    flights: [],
    handlers,
    addSource(id, spec) { m.sources.set(id, { ...spec, data: spec.data }); },
    getSource(id) {
      const s = m.sources.get(id);
      return s ? { setData: (d) => { s.data = d; } } : undefined;
    },
    removeSource(id) { m.sources.delete(id); },
    addLayer(spec) { m.layers.set(spec.id, spec); },
    getLayer: (id) => m.layers.get(id),
    removeLayer(id) { m.layers.delete(id); },
    setPaintProperty(l, p, v) { const ly = m.layers.get(l); if (ly) ly.paint[p] = v; },
    setLayoutProperty() {},
    on(type, a, b) { handlers.set(typeof a === "string" ? `${type}|${a}` : type, b ?? a); },
    off(type, a) { handlers.delete(typeof a === "string" ? `${type}|${a}` : type); },
    getContainer: () => container,
    getCanvas: () => document.createElement("canvas"),
    getZoom: () => 10,
    flyTo(o) { m.flights.push(o); },
  };
  return m;
}

function mockApp(name) {
  const mapEl = document.getElementById("mapbox");
  const app = {
    name,
    map: mockMap(mapEl),
    native: [],
    menus: [],
    panel: null,
    panelEl: null,
    getMap: () => app.map,
    registerExternalNativeLayer: (l) => app.native.push(l),
    unregisterExternalNativeLayer: (id) => { app.native = app.native.filter((l) => l.id !== id); },
    registerRightPanel(p) { app.panel = p; return () => { app.panel = null; }; },
    openRightPanel(id) {
      if (!app.panel || app.panel.id !== id) return false;
      if (!app.panelEl) {
        app.panelEl = document.createElement("div");
        app.panelEl.dataset.plugin = name;
        document.body.append(app.panelEl);
        app.panel.render(app.panelEl);
      }
      return true;
    },
    closeRightPanel() {},
    registerToolbarMenu(m) { app.menus.push(m); return () => {}; },
    getLocale: () => "en",
    translate: (key, def, params) => def.replace(/\{\{\s*(\w+)\s*\}\}/g, (x, k) => (params && k in params ? String(params[k]) : x)),
  };
  return app;
}

const q = (app, sel) => app.panelEl?.querySelector(sel);
const kpi = (app, key) => q(app, `[data-kpi-value="${key}"]`)?.textContent;
const changeSelect = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
// the controls grid: run, observed source, from, to, bucket (in that order)
const control = (app, i) => app.panelEl.querySelectorAll("section.av-grid select")[i];
const idle = (app) => !app.panelEl?.textContent.includes("Loading");

try {
  const log = {};
  const val = { plugin: await loadPlugin("aimsun-detector-validation"), app: mockApp("val") };
  const cnt = { plugin: await loadPlugin("aimsun-detector-counts"), app: mockApp("cnt") };
  // the second plugin gets its own map container so tooltips do not mix
  cnt.app.map = mockMap(Object.assign(document.createElement("div"), { style: "position:relative" }));
  document.body.append(cnt.app.map.getContainer());

  for (const x of [val, cnt]) {
    check(x.plugin.urlParameterNames.includes("aimsunPackage"), "declares aimsunPackage");
    await x.plugin.activate(x.app);
    await waitFor(() => x.app.panelEl, "panel opened");
    check(x.app.menus.length === 1, "toolbar menu registered");
    check(typeof x.app.panel.title === "function" && x.app.panel.title().length > 0, "reactive title");
  }

  // ---- concurrent loads of DIFFERENT runs through the shared DuckDB (exercises the view lock)
  await Promise.all([
    val.plugin.handleUrlParameters(val.app, new URLSearchParams("aimsunPackage=/data/manifest_geo.json&aimsunRun=AMPK_3")),
    cnt.plugin.handleUrlParameters(cnt.app, new URLSearchParams("aimsunPackage=/data/manifest_geo.json&aimsunRun=PMPK_3")),
  ]);
  await waitFor(() => kpi(val.app, "n"), "validation KPIs");
  await waitFor(() => kpi(cnt.app, "detectors"), "counts KPIs");

  // ---- validation: AMPK_3 summary
  log.validation = { n: kpi(val.app, "n"), r2: kpi(val.app, "r2"), pctGeh: kpi(val.app, "pctGeh"), rmse: kpi(val.app, "rmse"), slope: kpi(val.app, "slope") };
  check(kpi(val.app, "n") === "509", `n=509, got ${kpi(val.app, "n")}`);
  check(kpi(val.app, "r2").startsWith("0.989"), `r2~0.989, got ${kpi(val.app, "r2")}`);
  check(kpi(val.app, "pctGeh") === "54.4%", `pct_geh_lt5=54.4%, got ${kpi(val.app, "pctGeh")}`);
  check(q(val.app, '[data-kpi="pctGeh"].av-bad'), "54.4% against the 85% target is flagged");
  check(q(val.app, '[data-testid="scatter"] svg line[stroke-dasharray]'), "scatter has the dashed identity line");
  check(q(val.app, '[data-testid="geh-hist"] svg rect'), "GEH histogram drawn");
  check(!q(val.app, '[data-testid="degraded"]'), "not degraded when geometry is present");
  const uw = q(val.app, '[data-testid="unmatched-warning"]');
  check(uw && /^51 simulated detectors with flow have no external id and are excluded from validation$/.test(uw.textContent.trim()), `unmatched warning (51 for AMPK_3): ${uw?.textContent}`);
  check(q(val.app, '[data-testid="unmatched-table"] tr[data-status="unmatched"]'), "unmatched detectors listed");

  // map layer: status colouring
  const vs = val.app.map.sources.get("aimsun-detector-validation-layer-src");
  check(vs && vs.data.features.length > 400, "validation map source has detector points");
  const vl = val.app.map.layers.get("aimsun-detector-validation-layer-pts");
  check(JSON.stringify(vl.paint["circle-color"]).includes('"match"'), "status colour expression");
  check(val.app.native.length >= 1 && val.app.native[0].nativeLayerIds.length === 2, "layer mirrored into the Layers panel");
  log.validation.located = vs.data.features.length;

  // worst-N: first row is the highest GEH; selecting zooms
  const worstRows = [...val.app.panelEl.querySelectorAll("tr.av-tr")];
  check(worstRows.length === 20, `worst-20 rows, got ${worstRows.length}`);
  const gehs = worstRows.map((r) => parseFloat(r.children[4].textContent.replace(",", "")));
  check(gehs.every((g, i) => i === 0 || gehs[i - 1] >= g), "worst-N sorted by GEH desc");
  const firstId = worstRows[0].dataset.id;
  worstRows[0].click();
  await waitFor(() => val.app.map.flights.length > 0, "flyTo on select");
  const c = val.app.map.flights.at(-1).center;
  check(Array.isArray(c) && c[0] > 50 && c[0] < 60 && c[1] > 20 && c[1] < 30, `flyTo centre plausible ${JSON.stringify(c)}`);
  await waitFor(() => val.app.map.sources.get("aimsun-detector-validation-layer-sel-src").data.features.length === 1, "selection highlight");
  check(val.app.panelEl.querySelector("tr.av-selected")?.dataset.id === firstId, "row marked selected");
  log.validation.worstFirst = { id: firstId, geh: gehs[0], flyTo: c };

  // ---- counts: PMPK_3
  check(control(cnt.app, 0).value === "PMPK_3", "counts run = PMPK_3");
  check(control(val.app, 0).value === "AMPK_3", "validation run = AMPK_3");
  const nDet = Number(kpi(cnt.app, "detectors").replace(/[^\d]/g, ""));
  log.counts = { detectors: nDet, simTotal: kpi(cnt.app, "simTotal"), obsTotal: kpi(cnt.app, "obsTotal"), ratio: kpi(cnt.app, "ratio") };
  check(nDet > 400, `counts detectors > 400, got ${nDet}`);
  const cs = cnt.app.map.sources.get("aimsun-detector-counts-layer-src");
  check(cs && cs.data.features.length > 400, "counts map source has detector points");
  const cl = cnt.app.map.layers.get("aimsun-detector-counts-layer-pts");
  check(JSON.stringify(cl.paint["circle-radius"]).includes("interpolate"), "size expression");
  check(cnt.app.panelEl.querySelectorAll("tr.av-tr").length >= 400, "counts table rows");
  check(q(cnt.app, '[data-testid="scatter"] svg circle'), "counts scatter");
  check(q(cnt.app, '[data-testid="bars"] svg rect'), "counts bars");
  // hover tooltip carries both values
  cnt.app.map.handlers.get("mousemove|aimsun-detector-counts-layer-pts")({ features: [{ properties: { eid: "X1", sim: 1200, obs: 1000, diff: 200 } }], point: { x: 20, y: 20 } });
  const tip = cnt.app.map.getContainer().querySelector(".av-tip");
  check(tip && tip.textContent.includes("Simulated: 1,200") && tip.textContent.includes("Observed: 1,000"), `tooltip text: ${tip?.textContent}`);
  // size/colour options change the paint expressions
  const colorSel = [...cnt.app.panelEl.querySelectorAll("section.av-grid select")].find((s) => [...s.options].some((o) => o.value === "diff"));
  changeSelect(colorSel, "diff");
  await waitFor(() => JSON.stringify(cnt.app.map.layers.get("aimsun-detector-counts-layer-pts").paint["circle-color"]).includes("#2166ac"), "diverging colour for difference");
  // clicking a map point selects it in the panel
  cnt.app.map.handlers.get("click|aimsun-detector-counts-layer-pts")({ features: [{ properties: { eid: cs.data.features[0].properties.eid } }] });
  await waitFor(() => q(cnt.app, '[data-testid="selected"]'), "selected card");

  // ---- the two plugins share one DuckDB: simultaneous, DIFFERENT observed sources must not leak
  changeSelect(control(val.app, 1), "validation");
  await waitFor(() => idle(val.app) && Number(kpi(val.app, "n")) < 509, "validation obs source applied");
  const nValOnly = Number(kpi(val.app, "n"));
  changeSelect(control(cnt.app, 1), "calibration");
  await waitFor(() => idle(cnt.app), "counts idle");
  await sleep(500);
  const nCalOnly = Number(kpi(cnt.app, "detectors").replace(/[^\d]/g, ""));
  changeSelect(control(val.app, 1), "both");
  changeSelect(control(cnt.app, 1), "both");
  await waitFor(() => kpi(val.app, "n") === "509" && idle(val.app) && idle(cnt.app), "both restored");
  await sleep(500);
  changeSelect(control(val.app, 1), "validation");
  changeSelect(control(cnt.app, 1), "calibration");
  await sleep(300);
  await waitFor(() => idle(val.app) && idle(cnt.app), "simultaneous refresh settled");
  await sleep(500);
  check(Number(kpi(val.app, "n")) === nValOnly, `validation unaffected by the other panel: ${kpi(val.app, "n")} vs ${nValOnly}`);
  check(Number(kpi(cnt.app, "detectors").replace(/[^\d]/g, "")) === nCalOnly, "counts unaffected by the other panel");
  log.lock = { nValOnly, nCalOnly };

  // ---- degraded mode: manifest without geometry (the real manifest_tabular.json)
  val.plugin.deactivate(val.app);
  check(!val.app.map.sources.has("aimsun-detector-validation-layer-src"), "deactivate removes the map source");
  check(val.app.native.length === 0, "deactivate unregisters the native layer");
  const deg = { plugin: val.plugin, app: mockApp("deg") };
  await deg.plugin.activate(deg.app);
  await waitFor(() => deg.app.panelEl, "degraded panel");
  await deg.plugin.handleUrlParameters(deg.app, new URLSearchParams("aimsunPackage=/data/manifest_tabular.json"));
  await waitFor(() => kpi(deg.app, "n"), "degraded KPIs");
  check(q(deg.app, '[data-testid="degraded"]'), "degraded banner shown");
  check(kpi(deg.app, "n") === "509", "degraded mode still validates (n=509)");
  check(deg.app.map.sources.size === 0, "no map layer in degraded mode");
  check(!control(deg.app, 0).textContent.includes("PMPK_3b"), "unavailable run PMPK_3b not offered");
  log.degraded = true;

  // error path: a bad URL surfaces a visible alert, no crash
  await deg.plugin.handleUrlParameters(deg.app, new URLSearchParams("aimsunPackage=/data/nope.json"));
  await waitFor(() => q(deg.app, '.av-alert[role="alert"]'), "error alert");
  log.error = q(deg.app, '.av-alert[role="alert"]').textContent;

  cnt.plugin.deactivate(cnt.app);
  deg.plugin.deactivate(deg.app);
  out.textContent = "OK " + JSON.stringify(log);
} catch (e) {
  out.textContent = "FAIL " + ((e && e.stack) || e);
}
