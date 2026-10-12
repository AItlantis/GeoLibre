// Browser-side smoke cases for aimsun-subpath-validation (run by the shared harness through smoke/run.mjs).
const ID = "aimsun-subpath-validation";
const pkgUrl = (n) => `/pkg/${n}/manifest.json`;

async function open(ctx, pkg, appOpts) {
  const p = await ctx.startPlugin(ID, appOpts);
  ctx.assert(p.plugin.urlParameterNames.includes("aimsunPackage"), "declares ?aimsunPackage");
  await p.plugin.handleUrlParameters(p.app, new URLSearchParams({ aimsunPackage: pkgUrl(pkg) }));
  return p;
}
const kpi = (ctx, p, id) => {
  const e = ctx.$(p.container, `[data-kpi="${id}"]`);
  return e && e.dataset.value !== "" ? Number(e.dataset.value) : null;
};
const rowsOf = (ctx, p) => ctx.$$(p.container, '[data-avp="route-table"] tbody tr');
const sel = (ctx, p, attr) => ctx.$(p.container, `[data-avp="${attr}"]`);

async function realNoSim(ctx) {
  const { assert, $, $$, waitFor } = ctx;
  const p = await open(ctx, "AMPK_3");
  await waitFor(() => $(p.container, '[data-avp-state="no-sim"]'), "no-sim state");
  const c = p.container;
  assert(/No simulated journey time in this package/.test($(c, '[data-avp="no-sim-banner"]').textContent), "clear no-sim banner");
  assert(/subpath_sim_jt\.parquet/.test($(c, '[data-avp="no-sim"]').textContent), "says which table switches the panel on");
  assert(/55 route\/direction\/source series/.test($(c, '[data-avp="obs-summary"]').textContent), "observed side summarised (30 monthly + 25 subnetwork)");
  assert($$(c, "[data-kpi]").length === 0 && !$(c, "svg"), "no KPIs or charts without simulated data");
  assert(p.st.layers.length === 0 && p.st.sources.size === 0, "no map output");
  return {};
}

async function fixtureEndToEnd(ctx) {
  const { assert, near, $, $$, waitFor, setValue } = ctx;
  const expected = await (await fetch("/smoke/expected.json")).json();
  const p = await open(ctx, "FIXTURE", { pseudoLocale: true });
  await waitFor(() => $(p.container, '[data-avp-state="ready"]') && $(p.container, '[data-avp="kpis"]'), "ready with KPIs");
  const c = p.container;

  // 1. route-level KPIs equal the independently computed expectation
  const e = expected.routeLevel;
  assert(kpi(ctx, p, "n") === 3, "3 routes compared");
  for (const [id, key] of [["rmse", "rmse"], ["bias", "bias"], ["r2", "r2"], ["slope", "slope"], ["within", "pctWithin"], ["ratio", "meanRatio"]]) {
    assert(near(kpi(ctx, p, id), e[key], 1e-6), `KPI ${id}: ${kpi(ctx, p, id)} vs ${e[key]}`);
  }
  assert(near(kpi(ctx, p, "within"), 100 / 3, 1e-6), "1 of 3 routes within +-15%");

  // 2. per-route table: obs / sim / delta / ratio and the within flag
  const rows = rowsOf(ctx, p);
  assert(rows.length === 3, "3 table rows");
  for (const exp of expected.perRoute) {
    const row = rows.find((r) => r.firstElementChild.textContent === `${exp.route} - ${exp.direction}`);
    assert(row, "row for " + exp.route);
    const cell = (n) => row.querySelector(`[data-col="${n}"]`).textContent;
    assert(cell("obs") === exp.obs.toFixed(1) && cell("sim") === exp.sim.toFixed(1), `${exp.route} obs/sim ${cell("obs")}/${cell("sim")}`);
    assert(near(Number(cell("ratio")), exp.ratio, 5e-4) && near(Number(cell("delta")), exp.sim - exp.obs, 0.06), "delta/ratio");
    assert(row.dataset.within === String(Math.abs(exp.ratio - 1) <= 0.15 + 1e-12), "within flag " + exp.route);
  }
  // normalisation proof: sim named 'route alpha'/'In' and 'Route  Beta' paired with 'Route Alpha'/'IB' and 'Route Beta'/'OB'
  assert(rows.some((r) => /Route Alpha - IB/.test(r.textContent)) && rows.some((r) => /Route Beta - OB/.test(r.textContent)), "sim names normalised onto the observed routes");

  // 3. scatter with identity + OLS lines; orphans listed
  const sc = sel(ctx, p, "scatter");
  assert(sc.dataset.points === "3" && $(sc, "svg circle"), "scatter points");
  assert($(sc, "svg line[stroke-dasharray]") && $(sc, 'svg line[stroke-width="1.5"]'), "identity (dashed) and OLS lines");
  const un = sel(ctx, p, "unmatched");
  assert(un.dataset.obsOnly === "1" && un.dataset.simOnly === "1", "one observed-only and one simulated-only route");
  assert(/Route Delta - IB/.test(un.textContent) && /Route Echo - IB/.test(un.textContent), "orphans named");
  assert(!$(c, '[data-avp="no-pairs"]'), "pairs exist");

  // 4. sorting
  $(c, 'th[data-sort="delta"]').click();
  assert(/^Route Gamma/.test(rowsOf(ctx, p)[0].textContent), "sorted by delta ascending: Gamma first");

  // 5. profile of the selected row (obs vs sim)
  rowsOf(ctx, p).find((r) => /Route Alpha/.test(r.textContent)).click();
  const prof = sel(ctx, p, "profile-chart");
  assert(prof && $$(prof, "svg path").length >= 2 && $(prof, "svg polygon"), "profile: observed + simulated lines and the observed band");

  // 6. level: one point per route and bucket
  setValue(sel(ctx, p, "level"), "bucket");
  assert(kpi(ctx, p, "n") === 24, "24 route-bucket points");
  for (const [id, key] of [["rmse", "rmse"], ["bias", "bias"], ["r2", "r2"], ["within", "pctWithin"]]) {
    assert(near(kpi(ctx, p, id), expected.bucketLevel[key], 1e-6), `bucket KPI ${id}`);
  }

  // 7. tolerance
  setValue(sel(ctx, p, "level"), "route");
  setValue(sel(ctx, p, "tolerance"), "25", "input");
  assert(near(kpi(ctx, p, "within"), 200 / 3, 1e-6), "+-25% admits Gamma (-20%) but not Beta (+50%)");
  setValue(sel(ctx, p, "tolerance"), "15", "input");

  // 8. bucket size 60 reloads the views (async): 2 hourly buckets x 3 routes
  setValue(sel(ctx, p, "level"), "bucket");
  setValue(sel(ctx, p, "bucket"), "60");
  await waitFor(() => kpi(ctx, p, "n") === 6, "6 hourly route-bucket points after the reload");
  setValue(sel(ctx, p, "bucket"), "15");
  await waitFor(() => kpi(ctx, p, "n") === 24, "back to 15-min buckets");

  // 9. time window 07:30-08:30 -> 4 buckets x 3 routes
  setValue(sel(ctx, p, "win-from"), "07:30");
  setValue(sel(ctx, p, "win-to"), "08:30");
  assert(kpi(ctx, p, "n") === 12, "window keeps 12 route-bucket points, got " + kpi(ctx, p, "n"));
  setValue(sel(ctx, p, "win-from"), "07:00");
  setValue(sel(ctx, p, "win-to"), "09:00");
  assert(kpi(ctx, p, "n") === 24, "full window again");

  // 10. observed sources are never mixed
  assert($(c, '[data-avp="unit-warning"]'), "unverified-unit warning for the monthly source");
  setValue(sel(ctx, p, "source"), "subnetwork_may2025");
  setValue(sel(ctx, p, "level"), "route");
  assert(kpi(ctx, p, "n") === 1 && !$(c, '[data-avp="unit-warning"]'), "subnetwork source: only Route Alpha, 999 s, no monthly warning");
  assert(kpi(ctx, p, "ratio") < 0.2, "ratio against the 999 s observation");
  setValue(sel(ctx, p, "source"), "monthly_15min");
  assert(kpi(ctx, p, "n") === 3, "monthly again");

  // 11. i18n through app.translate with namespaced keys; state survives a language switch
  assert(p.st.keys.size > 25 && [...p.st.keys].every((k) => k.startsWith("plugin." + ID + ".")), "namespaced keys");
  p.setLocale("xx");
  await waitFor(() => /«/.test($(c, "h3")?.textContent ?? ""), "re-render in the new locale");
  assert(kpi(ctx, p, "n") === 3, "results survive the language switch");

  p.cleanup();
  p.plugin.deactivate(p.app);
  assert(!p.st.panels.has(ID) && p.st.listeners.size === 0, "released on deactivate");
  assert(p.st.layers.length === 0 && p.st.sources.size === 0, "validation never writes to the map");
  return { n: 3, rmse: e.rmse };
}

async function filesMode(ctx) {
  const { assert, $, $$, pickFiles, waitFor } = ctx;
  const p = await ctx.startPlugin(ID);
  const inputs = $$(p.container, 'input[type="file"]');
  await pickFiles(inputs[1], ["/pkg/FIXTURE/subpath_obs_jt.parquet", "/pkg/FIXTURE/subpath_sim_jt.parquet", "/pkg/FIXTURE/manifest.json"]);
  await waitFor(() => $(p.container, '[data-avp-state="ready"]') && $(p.container, '[data-kpi="n"]'), "files loaded");
  assert(Number($(p.container, '[data-kpi="n"]').dataset.value) === 3, "same result from picked files (manifest honoured, sha256 verified)");
  return {};
}

async function badSimColumns(ctx) {
  const { assert, $, waitFor } = ctx;
  const p = await open(ctx, "BADSIM");
  await waitFor(() => $(p.container, '[data-avp-state="error"]'), "error state");
  const t = $(p.container, '[role="alert"]').textContent;
  assert(/ts_bucket/.test(t) && /missing/.test(t), "names the missing column: " + t);
  return {};
}

async function noPairs(ctx) {
  // sim and obs exist but the window excludes everything -> explicit message, no KPIs
  const { assert, $, waitFor, setValue } = ctx;
  const p = await open(ctx, "FIXTURE");
  await waitFor(() => $(p.container, '[data-kpi="n"]'), "ready");
  setValue($(p.container, '[data-avp="win-from"]'), "12:00");
  setValue($(p.container, '[data-avp="win-to"]'), "13:00");
  assert($(p.container, '[data-avp="no-pairs"]') && !$(p.container, "[data-kpi]"), "explicit empty result for an empty window");
  return {};
}

export {
  realNoSim as "real-no-sim",
  fixtureEndToEnd as "fixture-end-to-end",
  filesMode as "files-mode",
  badSimColumns as "bad-sim-columns",
  noPairs as "no-pairs",
};
