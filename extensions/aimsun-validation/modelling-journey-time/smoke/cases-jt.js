// Browser-side smoke cases for Modelling Journey Time (run by harness.js through smoke/run.mjs).
const ID = "modelling-journey-time";
const OVERLAY = "aimsun-jt-overlay";
const pkgUrl = (n) => `/pkg/${n}/manifest.json`;

async function open(ctx, pkg, appOpts) {
  const p = await ctx.startPlugin(ID, appOpts);
  ctx.assert(p.plugin.urlParameterNames.includes("aimsunPackage"), "declares ?aimsunPackage");
  await p.plugin.handleUrlParameters(p.app, new URLSearchParams({ aimsunPackage: pkgUrl(pkg) }));
  return p;
}
const ready = (ctx, p) => ctx.waitFor(() => ctx.$(p.container, '[data-avp-state="ready"]'), "state ready");
const radios = (ctx, p) => ctx.$$(p.container, 'input[name="avp-source"]');
const pick = async (ctx, el) => {
  el.checked = true;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const overlayFeatures = (p) => p.st.sources.get(OVERLAY)?.data?.features ?? p.st.sources.get(OVERLAY)?.data?.features;

async function realDegraded(ctx) {
  const { assert, $, $$ } = ctx;
  const p = await open(ctx, "AMPK_3");
  await ready(ctx, p);
  const c = p.container;
  assert(p.st.opened.includes(ID), "panel opened");
  assert($(c, '[data-avp="degraded"]'), "chart-only banner shown without geometry");
  assert(/Chart-only mode/.test($(c, '[data-avp="degraded"]').textContent), "banner text");
  assert($(c, '[data-avp="unit-warning"]'), "unverified-unit warning for the monthly source");
  assert(/Unit unverified/.test($(c, '[data-avp="unit-warning"]').textContent), "warning text");
  const opts = $$(c, '[data-avp="route"] option');
  assert(opts.length === 30, "30 monthly route/direction pairs, got " + opts.length);
  assert($(c, '[data-avp="chart"]').dataset.points === "96", "96 quarter-hours in the profile");
  assert($(c, '[data-avp="chart"] svg path'), "profile line drawn");
  assert($(c, '[data-avp="chart"] svg polygon'), "min-max band drawn");
  assert(/Needs subpath geometry/.test($(c, '[data-avp="matching"]').textContent), "matching explains it needs names");
  assert(p.st.sources.size === 0 && p.st.layers.length === 0, "no map output in degraded mode");
  const before = $(c, '[data-avp="chart"]').innerHTML;
  // second route -> different chart
  const sel = $(c, '[data-avp="route"]');
  ctx.setValue(sel, sel.options[5].value);
  assert($(c, '[data-avp="chart"]').innerHTML !== before, "chart follows the route picker");
  // source toggle: never mixed
  const r = radios(ctx, p);
  assert(r.length === 2, "two sources");
  await pick(ctx, r[1]);
  assert($$(c, '[data-avp="route"] option').length === 25, "25 subnetwork pairs");
  assert(!$(c, '[data-avp="unit-warning"]') && $(c, '[data-avp="unit-note"]'), "warning only for the monthly source");
  assert(Number($(c, '[data-avp="chart"]').dataset.points) > 0, "subnetwork profile drawn");
  assert(/31 days|5 days|days/.test(c.textContent), "coverage shown");
  return { monthlyPairs: 30, subnetworkPairs: 25 };
}

async function realWithGeometry(ctx) {
  const { assert, near, $, $$, waitFor } = ctx;
  const p = await open(ctx, "AMPK_3_GEO", { pseudoLocale: true });
  await ready(ctx, p);
  const c = p.container;
  const det = $(c, '[data-avp="matching"]');
  assert(det.dataset.obsMatched === "24" && det.dataset.obsTotal === "30", "monthly: 24 of 30 observed routes matched");
  assert(det.dataset.subpathsMatched === "24" && det.dataset.subpathsDropped === "8" && det.dataset.subpathsTotal === "119", "monthly: 24 of 119 subpaths matched, 8 duplicates dropped");
  assert(/24 of 30 observed routes matched/.test($(c, '[data-avp="match-summary"]').textContent), "summary text");
  assert($$(c, '[data-avp="matched-table"] tbody tr').filter((r) => r.lastElementChild.textContent.includes("[subnetwork]")).length === 8, "8 rows list dropped duplicates from the subnetwork group");
  assert(/only group 'Journey Time routes - HSMe' used/.test($(c, '[data-avp="matched-table"]').textContent), "rule shown in the table");
  assert($$(c, '[data-avp="unmatched-obs"] tbody tr').length === 6, "6 unmatched observed routes listed");
  assert($$(c, '[data-avp="unmatched-subpaths"] tbody tr').length === 87, "87 unmatched subpaths listed");
  assert($$(c, '[data-avp="matched-table"] tbody tr').length === 24, "matched table rows");
  assert($$(c, '[data-avp="route"] option').some((o) => /no model subpath/.test(o.textContent)), "unmatched routes flagged in the picker");
  assert(!$(c, '[data-avp="degraded"]'), "no degraded banner when geometry exists");

  // Map overlay (plugin-owned MapLibre source, recoloured in place)
  assert($(c, '[data-avp="bucket-label"]').textContent === "08:00", "default bucket 08:00");
  let feats = overlayFeatures(p);
  assert(feats && feats.length === 24, "24 subpath lines drawn, got " + (feats && feats.length));
  assert(feats.every((f) => /^#[0-9a-f]{6}$/.test(f.properties.stroke)), "every line has a stroke colour");
  assert(feats.some((f) => f.properties.jt_s > 0) && feats.every((f) => f.properties.source === "monthly_15min"), "values from the monthly source only");
  assert(p.st.mapLayers.get(OVERLAY + "-line").paint["line-color"][1] === "stroke", "layer paints the stroke property");
  assert(p.st.calls.filter((x) => x[0] === "fitBounds").length === 1, "fitBounds once");
  const jt0800 = feats.find((f) => f.properties.route === "Al Ain Road" && f.properties.direction === "IB").properties.jt_s;

  const slider = $(c, '[data-avp="bucket"]');
  const before = p.st.setDataCalls;
  ctx.setValue(slider, "68", "input"); // 17:00
  assert($(c, '[data-avp="bucket-label"]').textContent === "17:00", "label follows the slider");
  assert(p.st.setDataCalls === before + 1, "overlay data replaced in place");
  feats = overlayFeatures(p);
  assert(feats.every((f) => f.properties.bucket === "17:00"), "overlay is for 17:00");
  const jt1700 = feats.find((f) => f.properties.route === "Al Ain Road" && f.properties.direction === "IB").properties.jt_s;
  assert(jt0800 !== jt1700, `colour data differs by bucket (${jt0800} vs ${jt1700})`);
  assert(/17:00: observed median/.test($(c, '[data-avp="readout"]').textContent), "readout for the bucket");
  assert($(c, '[data-avp="chart"] svg [data-marker]'), "profile marks the selected bucket");

  const col = $(c, '[data-avp="colour-by"]');
  ctx.setValue(col, "ratio");
  feats = overlayFeatures(p);
  assert(feats.every((f) => f.properties.value === null || (f.properties.value > 0.2 && f.properties.value < 5)), "ratio values are around 1");
  ctx.setValue(col, "seconds");

  assert(!$(c, '[data-avp="snapshot"]') && !/export|copy|csv/i.test(c.textContent), "statistics view has no export controls");

  // switch to subnetwork: matching and overlay follow, sources never mixed
  await pick(ctx, radios(ctx, p)[1]);
  const det2 = $(c, '[data-avp="matching"]');
  assert(det2.dataset.obsMatched === "23" && det2.dataset.obsTotal === "25" && det2.dataset.subpathsMatched === "23", "subnetwork: 23 of 25, 23 subpaths");
  feats = overlayFeatures(p);
  assert(feats.length === 23 && feats.every((f) => f.properties.source === "subnetwork_may2025"), "overlay switched to the subnetwork source");

  // i18n: every string goes through app.translate with namespaced keys and follows the locale
  assert(p.st.keys.size > 20 && [...p.st.keys].every((k) => k.startsWith("plugin." + ID + ".")), "namespaced keys: " + [...p.st.keys].slice(0, 3));
  p.setLocale("xx");
  await waitFor(() => /«/.test($(c, "h3")?.textContent ?? ""), "panel re-rendered in the new locale");
  assert(radios(ctx, p)[1].checked, "state survives the language switch");
  assert(p.panel.title().startsWith("«"), "panel title getter localised");

  // deactivation cleans up
  p.cleanup();
  p.plugin.deactivate(p.app);
  assert(p.st.sources.size === 0 && p.st.mapLayers.size === 0, "overlay removed on deactivate");
  assert(p.st.listeners.size === 0 && !p.st.panels.has(ID), "locale listener and panel released");
  return { jt0800, jt1700 };
}

async function noMapRenderer(ctx) {
  const { assert, $ } = ctx;
  const p = await open(ctx, "AMPK_3_GEO", { withMap: false });
  await ready(ctx, p);
  const c = p.container;
  assert(/No 2D map/.test($(c, '[data-avp="overlay-note"]').textContent), "explains the missing 2D map");
  assert(p.st.sources.size === 0, "nothing added to a map that does not exist");
  assert(!$(c, '[data-avp="snapshot"]') && p.st.layers.length === 0, "map overlay does not export a layer");
  return {};
}

async function badUrl(ctx) {
  const { assert, $ } = ctx;
  const p = await open(ctx, "NOPE");
  await ctx.waitFor(() => $(p.container, '[data-avp-state="error"]'), "error state");
  assert(/HTTP 404/.test($(p.container, '[role="alert"]').textContent), "HTTP 404 reported");
  return {};
}

async function filesMode(ctx) {
  const { assert, $, $$, pickFiles, waitFor } = ctx;
  const p = await ctx.startPlugin(ID);
  const c = p.container;
  const inputs = $$(c, 'input[type="file"]');
  assert(inputs.length === 1 && inputs[0].hasAttribute("webkitdirectory") && inputs[0].multiple, "single hidden directory picker supports multiple files");
  const open = $(c, '[data-testid="open-package-folder"]');
  assert(open && /Open package folder/.test(open.textContent), "package folder button exists");
  open.click();
  await pickFiles(inputs[0], ["/pkg/FIXTURE/manifest.json", "/pkg/FIXTURE/subpath_obs_jt.parquet", "/pkg/FIXTURE/subpath_sim_jt.parquet"]);
  await waitFor(() => $(c, '[data-avp-state="ready"]') && $(c, '[data-avp="view-mode"] option[value="comparison"]') && !$(c, '[data-avp="view-mode"] option[value="comparison"]').disabled, "files and manifest loaded");
  assert($(c, '[data-avp="view-mode"] option[value="comparison"]') && !$(c, '[data-avp="view-mode"] option[value="comparison"]').disabled, "picked manifest and sim file expose two-run Comparison");
  assert(/picked files/.test($(c, '[data-avp="package"] [role="status"]').textContent), "status names the origin");
  return {};
}

export { realDegraded as "real-degraded", realWithGeometry as "real-with-geometry", noMapRenderer as "no-map-renderer", badUrl as "bad-url", filesMode as "files-mode" };
