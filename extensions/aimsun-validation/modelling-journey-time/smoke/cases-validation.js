const ID = "modelling-journey-time";
const pkgUrl = (name) => `/pkg/${name}/manifest.json`;
const kpi = (ctx, p, id) => Number(ctx.$(p.container, `[data-kpi="${id}"]`)?.dataset.value);

async function load(ctx, name) {
  const p = await ctx.startPlugin(ID);
  await p.plugin.handleUrlParameters(p.app, new URLSearchParams({ aimsunPackage: pkgUrl(name) }));
  await ctx.waitFor(() => ctx.$(p.container, '[data-avp-state="ready"]'), "loaded package");
  return p;
}

async function realOnly(ctx) {
  const { assert, $, $$ } = ctx;
  const p = await load(ctx, "AMPK_3");
  const c = p.container;
  assert($$(c, '[data-avp="view-mode"] option').length === 3, "Journey Time, Validation, and Comparison shown");
  assert($(c, '[data-avp="view-mode"] option[value="validation"]').disabled, "Validation disabled without simulation");
  assert($(c, '[data-avp="view-mode"] option[value="comparison"]').disabled, "Comparison disabled without simulation");
  assert(/observed journey time only/.test($(c, '[data-avp="mode-unavailable"]').textContent), "specific observed-only disabled reason");
  assert($(c, '[data-testid="day-profile"] svg path'), "typical-day profile is available");
  assert(!$(c, '[data-testid="validation-kpis"]'), "no validation results without simulated data");
  return { run: p.plugin.getProjectState().run };
}

async function fixtureModes(ctx) {
  const { assert, $, $$, waitFor } = ctx;
  const p = await load(ctx, "FIXTURE");
  const c = p.container;
  assert($(c, '[data-testid="day-profile"] svg path'), "observed day-profile renders");
  assert($(c, '[data-testid="day-profile"] svg [data-sim-window]'), "simulated window is shaded");
  ctx.setValue($(c, '[data-avp="view-mode"]'), "validation");
  await waitFor(() => $(c, '[data-testid="validation-kpis"]'), "Validation dashboard");
  assert($(c, '[data-testid="error-histogram"] svg rect'), "relative-error histogram renders");
  assert($(c, '[data-testid="compliance-bar"] svg line'), "compliance bar and target marker render");
  const colors = new Set($$(c, '[data-testid="error-histogram"] svg rect').map((r) => r.getAttribute("fill")));
  assert(colors.has("#2e7d32") && colors.has("#f9a825") && colors.has("#c62828"), "histogram has pass, warn, fail colours");
  const before = $(c, '[data-testid="error-histogram"]').innerHTML;
  const pass = $(c, '[data-criteria="passPct"]');
  ctx.setValue(pass, "5");
  assert(before !== $(c, '[data-testid="error-histogram"]').innerHTML, "criteria change recolours dashboard live");
  const row = $(c, '[data-testid="worst-subpaths"] tbody tr');
  row.click();
  assert($(c, '[data-testid="day-profile"] svg path'), "worst-subpath selection opens its day profile");
  let saved = p.plugin.getProjectState();
  assert(saved.viewMode === "validation" && saved.criteria.passPct === 5 && saved.source === "monthly_15min", "criteria and view are persisted in project state");

  ctx.setValue($(c, '[data-avp="view-mode"]'), "comparison");
  await waitFor(() => $(c, '[data-testid="comparison-kpis"]'), "Comparison dashboard");
  assert($(c, '[data-testid="comparison-scatter"] svg circle'), "two-run comparison scatter renders");
  assert($(c, '[data-testid="comparison-coverage"]'), "one-sided subpath coverage is reported");
  assert($(c, '[data-testid="top-improved"] tbody tr') || $(c, '[data-testid="top-degraded"] tbody tr'), "top-N comparison rows render");
  saved = p.plugin.getProjectState();
  assert(saved.comparisonA && saved.comparisonB && saved.comparisonA !== saved.comparisonB, "comparison run choices persist");
  p.cleanup();
  p.plugin.deactivate(p.app);
  return { kpis: $(c, '[data-testid="comparison-kpis"]') ? true : false };
}

async function malformedSim(ctx) {
  const { assert, $, waitFor } = ctx;
  const p = await ctx.startPlugin(ID);
  await p.plugin.handleUrlParameters(p.app, new URLSearchParams({ aimsunPackage: pkgUrl("BADSIM") }));
  await waitFor(() => $(p.container, '[data-avp-state="error"]'), "malformed simulation table error");
  assert(/subpath_sim_jt is missing column/.test($(p.container, '[role="alert"]').textContent), "error identifies malformed sim schema");
  return {};
}

export { realOnly as "real-only", fixtureModes as "fixture-modes", malformedSim as "malformed-sim" };
