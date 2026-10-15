// Smoke the single bundled plugin through the same fetch -> blob import path used by GeoLibre.
const out = document.getElementById("out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 90000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const value = fn(); if (value) return value; } catch { /* wait */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const check = (condition, message) => { if (!condition) throw new Error(`ASSERT ${message}`); };

async function loadPlugin() {
  const manifestUrl = "/plugins/modelling-count-manager/plugin.json";
  const manifest = await (await fetch(manifestUrl, { cache: "no-cache" })).json();
  const entryUrl = new URL(manifest.entry, new URL(manifestUrl, location.href));
  const source = await (await fetch(entryUrl, { cache: "no-cache" })).text();
  const style = manifest.style ? await (await fetch(new URL(manifest.style, new URL(manifestUrl, location.href)))).text() : "";
  if (style) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const mod = await import(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const plugin = mod.default;
  check(plugin.id === "modelling-count-manager" && plugin.name === "Modelling Count Manager", "single plugin matches manifest identity");
  return plugin;
}

function mockMap(container) {
  const handlers = new Map();
  const m = {
    sources: new Map(), layers: new Map(), flights: [], handlers,
    addSource(id, spec) { m.sources.set(id, { ...spec, data: spec.data }); },
    getSource(id) { const s = m.sources.get(id); return s ? { setData: (d) => { s.data = d; } } : undefined; },
    removeSource(id) { m.sources.delete(id); },
    addLayer(spec) { m.layers.set(spec.id, spec); },
    getLayer: (id) => m.layers.get(id), removeLayer(id) { m.layers.delete(id); },
    setPaintProperty(l, p, v) { const layer = m.layers.get(l); if (layer) layer.paint[p] = v; },
    setLayoutProperty() {},
    on(type, a, b) { handlers.set(typeof a === "string" ? `${type}|${a}` : type, b ?? a); },
    off(type, a) { handlers.delete(typeof a === "string" ? `${type}|${a}` : type); },
    getContainer: () => container, getCanvas: () => document.createElement("canvas"), getZoom: () => 10,
    flyTo(options) { m.flights.push(options); },
  };
  return m;
}

function mockApp() {
  const container = Object.assign(document.createElement("div"), { style: "position:relative" });
  document.body.append(container);
  const app = { map: mockMap(container), native: [], panel: null, panelEl: null,
    getMap: () => app.map,
    registerExternalNativeLayer: (layer) => app.native.push(layer),
    unregisterExternalNativeLayer: (id) => { app.native = app.native.filter((layer) => layer.id !== id); },
    registerRightPanel(panel) { app.panel = panel; return () => { app.panel = null; }; },
    openRightPanel(id) { if (!app.panel || app.panel.id !== id) return false; if (!app.panelEl) { app.panelEl = document.createElement("div"); document.body.append(app.panelEl); app.panel.render(app.panelEl); } return true; },
    closeRightPanel() {}, registerToolbarMenu() { return () => {}; }, getLocale: () => "en",
    translate: (_key, fallback, params) => fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => key in (params ?? {}) ? String(params[key]) : m),
  };
  return app;
}

const query = (app, selector) => app.panelEl?.querySelector(selector);
const kpi = (app, key) => query(app, `[data-kpi-value="${key}"]`)?.textContent;
const mode = (app, name) => [...app.panelEl.querySelectorAll('[role="tab"]')].find((b) => b.textContent.trim() === name);

try {
  const plugin = await loadPlugin();
  const app = mockApp();
  await plugin.activate(app);
  await waitFor(() => app.panelEl, "panel");
  await plugin.handleUrlParameters(app, new URLSearchParams("aimsunPackage=/data/manifest_geo.json&aimsunRun=AMPK_3"));
  await waitFor(() => mode(app, "Validation") && !mode(app, "Validation").disabled, "Validation availability");
  mode(app, "Validation").click();
  await waitFor(() => kpi(app, "n"), "validation KPIs");
  const log = { validation: { n: kpi(app, "n"), r2: kpi(app, "r2"), pctGeh: kpi(app, "pctGeh") } };
  check(kpi(app, "n") === "509", `validation n=509, got ${kpi(app, "n")}`);
  check(kpi(app, "r2").startsWith("0.989"), `validation r2~0.989, got ${kpi(app, "r2")}`);
  check(kpi(app, "pctGeh") === "54.4%", `validation %GEH<5=54.4%, got ${kpi(app, "pctGeh")}`);
  const warning = query(app, '[data-testid="unmatched-warning"]')?.textContent.trim();
  check(warning === "51 simulated detectors with flow have no external id and are excluded from validation", `exact unmatched warning: ${warning}`);
  const mapId = "modelling-count-manager-layer-src";
  const source = app.map.sources.get(mapId);
  check(source?.data.features.length === 560, `560 map points, got ${source?.data.features.length}`);
  check(query(app, '[data-testid="scatter"] svg line[stroke-dasharray]'), "Validation scatter identity line");
  check(query(app, '[data-testid="geh-hist"] svg rect'), "Validation GEH histogram");
  const histFills = [...query(app, '[data-testid="geh-hist"] svg').querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
  check(["#2e7d32", "#f9a825", "#c62828"].every((color) => histFills.includes(color)), "GEH histogram uses pass/warn/fail ramp");
  check(query(app, '[data-testid="compliance-bar"] svg rect') && query(app, '[data-testid="compliance"] [data-kpi="compliancePct"]'), "compliance bar and KPI are rendered");
  check(query(app, '[data-testid="criteria"]'), "criteria controls render");
  const greenBinsBefore = query(app, '[data-testid="geh-hist"] svg').querySelectorAll('rect[fill="#2e7d32"]').length;
  const passWidthBefore = Number(query(app, '[data-testid="compliance-bar"] svg rect').getAttribute("width"));
  const passInput = query(app, '[data-testid="criteria"] input[data-criteria="gehPass"]');
  passInput.value = "3";
  passInput.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => query(app, '[data-testid="geh-hist"] svg line[stroke-dasharray] title')?.textContent.includes("GEH 3 pass threshold"), "live GEH criteria repaint");
  check(query(app, '[data-testid="criteria"] input[data-criteria="gehPass"]')?.value === "3", "criteria change remains active without reloading data");
  const greenBinsAfter = query(app, '[data-testid="geh-hist"] svg').querySelectorAll('rect[fill="#2e7d32"]').length;
  const passWidthAfter = Number(query(app, '[data-testid="compliance-bar"] svg rect').getAttribute("width"));
  check(greenBinsAfter < greenBinsBefore && passWidthAfter < passWidthBefore, "criteria change recolours GEH histogram bins and compliance bar");
  const criteriaSaved = plugin.getProjectState();
  check(criteriaSaved.criteria.gehPass === 3, "criteria are persisted through project state");
  // Restore the default threshold before the Counts and Comparison checks.
  query(app, '[data-testid="criteria"] button')?.click();
  log.validation.mapPoints = source.data.features.length;

  mode(app, "Counts").click();
  await waitFor(() => kpi(app, "detectors"), "Counts KPIs");
  check(app.panelEl.querySelectorAll("tr.av-tr").length >= 400, "Counts table populated");
  check(query(app, '[data-testid="day-profile"] svg'), "Counts day profile is rendered");
  check(!query(app, '[data-testid="unmatched-table"]'), "Counts mode has no unmatched table");
  check(query(app, '[data-testid="scatter"] svg circle'), "Counts scatter populated");
  const pointLayer = app.map.layers.get("modelling-count-manager-layer-pts");
  app.map.handlers.get("mousemove|modelling-count-manager-layer-pts")({ features: [{ properties: { eid: "X1", sim: 1200, obs: 1000, diff: 200 } }], point: { x: 20, y: 20 } });
  const tooltip = app.map.getContainer().querySelector(".av-tip");
  check(tooltip?.textContent.includes("Simulated: 1,200") && tooltip.textContent.includes("Observed: 1,000"), "Counts hover tooltip shows both series");
  check(JSON.stringify(pointLayer.paint["circle-color"]).length > 0, "Counts map color is configured");
  log.counts = { detectors: kpi(app, "detectors"), tableRows: app.panelEl.querySelectorAll("tr.av-tr").length, tooltip: tooltip.textContent };

  mode(app, "Comparison").click();
  await waitFor(() => query(app, '[data-testid="comparison-kpis"]'), "comparison dashboard");
  check(query(app, '[data-comparison-run="a"]')?.value === "AMPK_3" && query(app, '[data-comparison-run="b"]')?.value === "AMPK_3b", "comparison defaults to AMPK_3 versus AMPK_3b");
  check(query(app, '[data-testid="comparison-scatter"] svg circle') && query(app, '[data-testid="most-improved"]') && query(app, '[data-testid="most-degraded"]'), "comparison scatter and ranked detector tables render");
  const runB = query(app, '[data-comparison-run="b"]');
  runB.value = "PMPK_3";
  runB.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => query(app, '[data-testid="period-differs"]'), "period difference warning");
  log.comparison = { runs: [query(app, '[data-comparison-run="a"]').value, runB.value], warning: query(app, '[data-testid="period-differs"]').textContent };

  mode(app, "Counts").click();
  await waitFor(() => kpi(app, "detectors"), "Counts KPIs after comparison");

  // Persist every shared setting plus the active view, then restore through a fresh activation.
  const colorSelect = [...app.panelEl.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "diff"));
  colorSelect.value = "diff";
  colorSelect.dispatchEvent(new Event("change", { bubbles: true }));
  const saved = plugin.getProjectState();
  check(saved.viewMode === "counts" && saved.colorMode === "diff" && saved.run === "AMPK_3", "project state contains view, colour and run");
  mode(app, "Validation").click();
  check(plugin.getProjectState().viewMode === "validation", "active view mode persisted");
  plugin.deactivate(app);
  const restoredApp = mockApp();
  await plugin.activate(restoredApp);
  await waitFor(() => restoredApp.panelEl, "restored panel");
  plugin.applyProjectState(restoredApp, { ...saved, viewMode: "validation" });
  await waitFor(() => kpi(restoredApp, "n"), "restored validation view");
  check(plugin.getProjectState().viewMode === "validation", "project state restores the active validation view");
  log.persistence = true;
  plugin.deactivate(restoredApp);

  // Sim-only synthetic manifest: Validation is disabled with its missing-table reason; Counts still works.
  const simApp = mockApp();
  await plugin.activate(simApp);
  await waitFor(() => simApp.panelEl, "sim-only panel");
  await plugin.handleUrlParameters(simApp, new URLSearchParams("aimsunPackage=/data/manifest_sim_only.json"));
  await waitFor(() => kpi(simApp, "detectors"), "sim-only Counts");
  check(mode(simApp, "Validation").disabled, "Validation disabled without observations");
  check(query(simApp, ".av-hint")?.textContent.includes("detectors_obs.parquet"), "missing table reason displayed");
  check(simApp.panelEl.querySelectorAll("tr.av-tr").length > 0, "sim-only Counts table works");
  const fallback = plugin.getProjectState();
  check(fallback.viewMode === "counts", "unavailable saved view falls back to Counts");
  log.simOnly = { countsRows: simApp.panelEl.querySelectorAll("tr.av-tr").length, reason: query(simApp, ".av-hint").textContent };
  plugin.deactivate(simApp);
  out.textContent = "OK " + JSON.stringify(log);
} catch (error) {
  out.textContent = "FAIL " + ((error && error.stack) || error);
}

