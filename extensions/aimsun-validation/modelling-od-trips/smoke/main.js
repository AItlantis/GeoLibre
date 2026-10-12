// OD plugin smoke, driven by run-chrome.mjs: ?plugin=<id>&mode=url|files
// Loads the BUILT plugin the way GeoLibre does (fetch plugin.json -> fetch entry -> Blob -> import(blobUrl)), activates it
// against a fake app/map, loads REAL AMPK_3 data (manifest URL or a folder of File objects), then asserts totals and timings.
const out = document.getElementById("out");
const q = new URLSearchParams(location.search);
const id = q.get("plugin");
const mode = q.get("mode") ?? "url";
const report = { id, mode, timings: {}, checks: [] };
let rafRequested=0, rafCancelled=0;
const nativeRaf=window.requestAnimationFrame.bind(window), nativeCancelRaf=window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame=(callback)=>{rafRequested++;return nativeRaf(callback);};
window.cancelAnimationFrame=(id)=>{rafCancelled++;return nativeCancelRaf(id);};
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, extra) => {
  report.checks.push({ name, ok: !!ok, ...(extra === undefined ? {} : { extra }) });
  if (!ok) failures.push(`${name}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
};
const waitFor = async (fn, what, timeout = 300000) => {
  const t = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(150);
  }
};
const digits = (s) => Number(String(s ?? "").replace(/[^\d]/g, ""));

try {
  // ---- load like GeoLibre
  const base = new URL(`/plugins/${id}/`, location.href);
  const manifest = await (await fetch(new URL("plugin.json", base))).json();
  const css = await (await fetch(new URL(manifest.style, base))).text();
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  const src = await (await fetch(new URL(manifest.entry, base))).text();
  const blobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const mod = await import(blobUrl);
  const plugin = mod.default;
  check("plugin id matches manifest", plugin.id === manifest.id && plugin.id === id, plugin.id);
  report.entryBytes = src.length;

  // ---- fake app + map
  const sources = new Map();
  const layers = new Map();
  const map = {
    addSource: (sid, spec) => sources.set(sid, { spec, data: spec.data }),
    getSource: (sid) => (sources.has(sid) ? { setData: (d) => (sources.get(sid).data = d) } : undefined),
    removeSource: (sid) => sources.delete(sid),
    addLayer: (spec) => layers.set(spec.id, spec),
    getLayer: (lid) => layers.get(lid),
    removeLayer: (lid) => layers.delete(lid),
    setPaintProperty() {}, setLayoutProperty() {}, on() {}, off() {},
    getContainer: () => document.body, getCanvas: () => document.createElement("canvas"), getZoom: () => 8, flyTo() {},
  };
  const reg = { panels: [], menus: [], native: [], bounds: [] };
  const app = {
    getMap: () => map,
    fitBounds: (b) => reg.bounds.push(b),
    registerExternalNativeLayer: (l) => reg.native.push(l.id),
    unregisterExternalNativeLayer() {},
    registerRightPanel: (p) => (reg.panels.push(p), () => {}),
    openRightPanel: () => true,
    closeRightPanel() {},
    registerToolbarMenu: (m) => (reg.menus.push(m), () => {}),
    getLocale: () => "en",
    onLocaleChange: () => () => {},
    translate: (_k, en, params) => (params ? en.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in params ? String(params[k]) : m)) : en),
  };
  await plugin.activate(app);
  check("registers one right panel + toolbar menu", reg.panels.length === 1 && reg.menus.length === 1);
  check("declares aimsunPackage url parameter", plugin.urlParameterNames?.includes("aimsunPackage"));
  const host = document.getElementById("host");
  const dispose = reg.panels[0].render(host);
  check("panel title", typeof reg.panels[0].title === "function" && reg.panels[0].title().length > 0, reg.panels[0].title());
  const text = () => host.textContent ?? "";

  // ---- load the package
  const t0 = performance.now();
  if (mode === "url" || mode === "assignment") {
    const manifestUrl = mode === "assignment" ? "/smoke/assignment-only/manifest.json" : "/data/manifest_tabular.json";
    await plugin.handleUrlParameters(app, new URLSearchParams({ aimsunPackage: new URL(manifestUrl, location.href).href, aimsunRun: mode === "assignment" ? "ASSIGNMENT_FIXTURE" : "AMPK_3" }));
  } else {
    const dt = new DataTransfer();
    for (const f of ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"]) {
      const blob = await (await fetch(`/data/AMPK_3/${f}`)).blob();
      const file = new File([blob], f);
      Object.defineProperty(file, "webkitRelativePath", { value: `data/AMPK_3/${f}` });
      dt.items.add(file);
    }
    const input = host.querySelector('input[type="file"]');
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  }
  await waitFor(() => /Run (AMPK_3|ASSIGNMENT_FIXTURE) ready/.test(text()) || /ao-bad/.test(host.innerHTML), "package ready");
  report.timings.loadTotalMs = Math.round(performance.now() - t0);
  report.timings.firstLoadMs = report.timings.loadTotalMs;
  check("package ready without error", !host.querySelector(".ao-alert.ao-bad"), host.querySelector(".ao-alert.ao-bad")?.textContent);
  const runSel = [...host.querySelectorAll("select")][0];
  report.runs = runSel ? [...runSel.options].map((o) => o.value) : [];
  if (id === "aimsun-trips" && mode === "url") check("tabular manifest lists 3 runs (convention probe)", JSON.stringify(report.runs) === JSON.stringify(["AMPK_3", "AMPK_3b", "PMPK_3"]), report.runs);
  report.status = host.querySelector(".ao-status")?.textContent;
  const groupingSel = [...host.querySelectorAll("select")][1];
  if (mode !== "assignment") check("default grouping is Centroids (Abu Dhabi Island)", groupingSel?.value === "Centroids (Abu Dhabi Island)", groupingSel?.value);

  // ---- direct DuckDB checks through the shared singleton (same instance the plugin uses)
  const h0 = await globalThis[Symbol.for("aimsun.validation.duckdb")].promise;
  // the controller works in its own attached catalog (aimsun_od_<unique>), never in the shared default one
  const cat = (await h0.query("SELECT database_name AS n FROM duckdb_databases() WHERE database_name LIKE 'aimsun_od_%'"))[0]?.n;
  check("controller owns a private catalog", !!cat, cat);
  const leaked = (await h0.query("SELECT count(*) AS n FROM duckdb_views() WHERE database_name = 'memory' AND (view_name LIKE 'od_%' OR view_name LIKE 'v_od_%' OR view_name = 'v_centroids_norm')"))[0].n;
  check("no OD relation leaked into the shared default catalog", Number(leaked) === 0, leaked);
  // direct checks run on a connection of their own, USEing the controller's catalog (fixed relation names live there)
  const hc = await h0.db.connect();
  await hc.query(`USE ${cat}`);
  const h = {
    query: async (sql) => (await hc.query(sql)).toArray().map((r) => Object.fromEntries(Object.entries(r.toJSON()).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]))),
  };
  const timed = async (name, sql) => {
    const t = performance.now();
    const rows = await h.query(sql);
    report.timings[name] = Math.round(performance.now() - t);
    return rows;
  };
  const b = (await timed("sumBeforeMs", "SELECT count(*) AS n, sum(value) AS s FROM " + cat + ".main.od_before_raw"))[0];
  const a = (await timed("sumAfterMs", "SELECT count(*) AS n, sum(value) AS s FROM " + cat + ".main.od_after_raw"))[0];
  report.cells = b.n;
  if (mode === "assignment") {
    check("assignment fixture has two OD rows", b.n === 2, b.n);
    check("assignment fixture total is 19", Math.abs(b.s - 19) < 1e-9, b.s);
    check("assignment fixture does not invent an after matrix", Number(a.s ?? 0) === 0, a.s);
  } else {
    check("od_before rows 4,422,092", b.n === 4422092, b.n);
    check("od_before total 411,943", Math.abs(b.s - 411942.63) < 1, b.s);
    check("od_after total 334,560", Math.abs(a.s - 334560.38) < 1, a.s);
  }
  const gg = await timed(
    "groupXgroupStreamingMs",
    "SELECT co.grp AS og, cd.grp AS dg, sum(x.trips) AS s FROM v_od_before_norm x JOIN v_centroids_norm co ON co.id = x.origin JOIN v_centroids_norm cd ON cd.id = x.destination GROUP BY 1, 2",
  );
  check("group x group aggregation conserves total", Math.abs(gg.reduce((s, r) => s + r.s, 0) - (mode === "assignment" ? 19 : 411942.63)) < 1);
  report.groupCells = gg.length;
  const ggTwice = await timed("groupXgroupStreamingWarmMs", "SELECT co.grp AS og, cd.grp AS dg, sum(x.trips) AS s FROM v_od_before_norm x JOIN v_centroids_norm co ON co.id = x.origin JOIN v_centroids_norm cd ON cd.id = x.destination GROUP BY 1, 2");
  void ggTwice;

  // ---- plugin specific
  const kpi = (label) => [...host.querySelectorAll(".ao-kpi")].find((k) => k.querySelector(".ao-kpi-l")?.textContent === label)?.querySelector(".ao-kpi-v")?.textContent;
  const srcData = (suffix) => sources.get(`${id}-layer-${suffix}`)?.data;
  const ctl = (label) => [...host.querySelectorAll("label.ao-field")].find((l) => l.querySelector(".ao-label")?.textContent.startsWith(label));
  const setInput = async (label, value) => {
    const i = ctl(label).querySelector("input");
    i.value = value;
    i.dispatchEvent(new Event("change"));
  };
  const setSelect = async (label, value) => {
    const s = ctl(label).querySelector("select");
    s.value = value;
    s.dispatchEvent(new Event("change"));
  };

  const modeTabs = () => host.querySelector('[data-testid="view-mode"]');
  if (mode === "assignment") {
    const options = [...(modeTabs()?.querySelectorAll('[role="tab"]') ?? [])].map((o) => o.textContent);
    const enabled = [...(modeTabs()?.querySelectorAll('[role="tab"]:not([disabled])') ?? [])].map((o) => o.textContent);
    check("assignment package enables only single-matrix views", JSON.stringify(enabled) === JSON.stringify(["OD Trips", "Balance", "Trip length", "Flow matrix"]) && modeTabs().querySelectorAll('[role="tab"][disabled]').length === 3, options);
    const t1 = performance.now();
    await waitFor(() => kpi("Trips in selection") && host.querySelector(".ao-chart svg"), "assignment trips results");
    check("assignment trips total is 19", digits(kpi("Trips in selection")) === 19, kpi("Trips in selection"));
    report.timings.firstResultsMs = Math.round(performance.now() - t1);
    check("assignment desire lines render", (srcData("lines")?.features?.length ?? 0) === 2, srcData("lines")?.features?.length);
    const setMode = async (label) => { [...modeTabs().querySelectorAll('[role="tab"]')].find(b=>b.textContent===label)?.click(); await sleep(40); };
    await setMode("Balance"); await waitFor(()=>host.textContent.includes("Generation vs attraction"),"assignment balance view");
    check("assignment Balance renders",host.textContent.includes("Total productions")&&host.textContent.includes("Total attractions"));
    await setMode("Trip length"); await waitFor(()=>host.textContent.includes("Trip length distribution"),"assignment trip length view");
    check("assignment Trip length renders",host.textContent.includes("straight-line distance")&&host.textContent.includes("median"));
    await setMode("Flow matrix"); await waitFor(()=>host.querySelector('[data-testid="flow-selection"]'),"assignment flow matrix view");
    const cell=host.querySelector(".ao-matrix-cell"); cell?.click(); await sleep(40);
    check("assignment Flow matrix renders and cell updates scope",!!cell&&host.querySelector('[data-testid="flow-selection"]')?.textContent!=="All origins → all destinations");
  } else if (id === "modelling-od-trips") {
    const t1 = performance.now();
    await waitFor(() => kpi("Trips in selection") && host.querySelector(".ao-chart svg") && !host.textContent.includes("Querying"), "trips results");
    report.timings.tripsFirstResultsMs = Math.round(performance.now() - t1);
    const expect = (await h.query("SELECT sum(value) AS s FROM " + cat + ".main.od_before_raw WHERE origin_id <> destination_id AND value >= 1"))[0].s;
    check("default KPI = before trips excl. intrazonal, >= 1", Math.abs(digits(kpi("Trips in selection")) - Math.round(expect)) <= 1, [kpi("Trips in selection"), expect]);
    check("group desire lines on the map (default detail = Groups)", (srcData("lines")?.features?.length ?? 0) > 0 && srcData("lines").features.length <= 200, srcData("lines")?.features?.length);
    check("group nodes on the map (default detail = Groups)", (srcData("groups")?.features?.length ?? 0) >= 2, srcData("groups")?.features?.length);
    check("endpoint circles on the map", (srcData("ends")?.features?.length ?? 0) > 20);
    check("layers registered in the Layers panel", reg.native.includes(`${id}-layer`));
    check("top pairs table has rows", host.querySelectorAll(".ao-table tbody tr").length >= 100, host.querySelectorAll(".ao-table tbody tr").length);
    check("straight-line label present", /not route length/.test(host.textContent));
    const barLabel=[...host.querySelectorAll("label.ao-check")].find(l=>l.textContent.includes("Bars"));
    barLabel?.querySelector("input")?.click();
    await waitFor(()=> (srcData("bars")?.features?.length ?? 0)>0,"Trips bars source");
    check("Trips bars layer has two features per displayed node", (srcData("bars")?.features?.length ?? 0) >= 2 && (srcData("bars")?.features?.length ?? 0) % 2 === 0, srcData("bars")?.features?.length);
    [...host.querySelectorAll(".ao-tabs button")].find(b=>b.textContent==="3D")?.click();
    await waitFor(()=> (srcData("ribbons")?.features?.length ?? 0)>0,"3D desire line ribbons");
    check("3D desire line extrusion features exist",srcData("ribbons").features.length>0,srcData("ribbons").features.length);
    const pauseFlow=[...host.querySelectorAll("label.ao-check")].find(l=>l.textContent.includes("Pause flow animation"));
    pauseFlow?.querySelector("input")?.click();
    check("3D animation RAF is cancelled when paused",rafRequested>0&&rafCancelled>0,[rafRequested,rafCancelled]);
    pauseFlow?.querySelector("input")?.click();
    await sleep(60);
    const detail=ctl("Map detail")?.querySelector("select");
    if(detail){detail.value="centroids";detail.dispatchEvent(new Event("change"));await waitFor(()=> (srcData("centroids")?.features?.length ?? 0)>0,"centroid detail source");detail.value="groups";detail.dispatchEvent(new Event("change"));await waitFor(()=> (srcData("groups")?.features?.length ?? 0)>0,"group detail source");}
    check("scope detail updates group map source",(srcData("groups")?.features?.length ?? 0)>0,srcData("groups")?.features?.length);
    // full matrix: include intrazonal + no min threshold -> exact before total
    const chk = [...host.querySelectorAll("label.ao-check")].find((l) => l.textContent.includes("intrazonal"))?.querySelector("input");
    chk.checked = true;
    chk.dispatchEvent(new Event("change"));
    await setInput("Min trips", "0");
    await waitFor(() => digits(kpi("Trips in selection")) === 411943, "411,943 before total");
    check("before total 411,943 in the plugin", digits(kpi("Trips in selection")) === 411943, kpi("Trips in selection"));
    check("view mode tabs are present and trips selected", modeTabs()?.getAttribute("role") === "tablist" && modeTabs().querySelector('[aria-selected="true"]')?.textContent === "OD Trips");
    check("new analytic tabs are enabled for AMPK_3",["Comparison","Balance","Trip length","Flow matrix"].every(label=>[...modeTabs().querySelectorAll('[role=tab]')].some(b=>b.textContent===label&&!b.disabled)));
    const setMode = async (label) => { [...modeTabs().querySelectorAll('[role="tab"]')].find(b=>b.textContent===label)?.click(); await sleep(25); };
    const tMode1 = performance.now();
    await setMode("Before/After");
    await waitFor(() => kpi("Total before") && host.querySelectorAll(".ao-table").length >= 4, "before-after mode");
    report.timings.modeBeforeAfterMs = Math.round(performance.now() - tMode1);
    check("switching modes disposes the active 3D animation RAF",rafCancelled>1,[rafRequested,rafCancelled]);
    check("before/after totals after mode switch", digits(kpi("Total before")) === 411943 && digits(kpi("Total after")) === 334560);
    const checks=host.querySelector(".ao-checks");checks?.querySelector("summary")?.click();
    await waitFor(()=>checks?.querySelector(".ao-checks-badge")?.textContent!=="Checks not run","conservation checks");
    check("real package conservation badge is OK",checks?.querySelector(".ao-checks-badge")?.textContent==="OK",checks?.textContent);
    check("before/after scatter with identity and OLS", host.querySelectorAll(".ao-chart svg circle").length > 10 && host.querySelectorAll(".ao-chart svg line[clip-path]").length === 2);
    check("Trips point and desire line layers removed in before/after mode", !layers.has(`${id}-layer-centroids`) && !layers.has(`${id}-layer-lines`) && !layers.has(`${id}-layer-ends`));
    check("Before/After mode has four bars per mapped node", (srcData("bars")?.features?.length ?? 0) > 0 && srcData("bars").features.length % 4 === 0, srcData("bars")?.features?.length);
    const cellsBeforeSwitch = Number((await h.query("SELECT count(*) AS n FROM od_cell"))[0].n);
    const tMode2 = performance.now();
    await setMode("Difference");
    await waitFor(() => kpi("Total before") && host.querySelectorAll(".ao-table").length >= 2 && !host.textContent.includes("Querying"), "difference mode");
    report.timings.modeDifferenceMs = Math.round(performance.now() - tMode2);
    check("difference totals after mode switch", digits(kpi("Total before")) === 411943 && digits(kpi("Total after")) === 334560);
    check("difference gains/losses tabs, bands and map layers", host.querySelectorAll("[role=tab]").length >= 2 && host.querySelectorAll(".ao-chart svg rect").length >= 5 && (srcData("net")?.features?.length ?? 0) > 1000 && (srcData("lines")?.features?.length ?? 0) === 150);
    check("before/after layers removed in difference mode", !layers.has(`${id}-layer-centroids`) && !layers.has(`${id}-layer-ends`));
    const initialDiffColors=JSON.stringify((srcData("net")?.features??[]).map(f=>f.properties?.c));
    const legendScale=ctl("Scale")?.querySelector("select");
    if(legendScale){legendScale.value="manual";legendScale.dispatchEvent(new Event("change"));}
    const neutral=ctl("Neutral band (+/-)")?.querySelector("input"); if(neutral){neutral.value="10";neutral.dispatchEvent(new Event("change"));}
    const saturation=ctl("Saturation at (+/-)")?.querySelector("input"); if(saturation){saturation.value="500";saturation.dispatchEvent(new Event("change"));}
    check("manual +/-500 legend controls are present and update map colours",!!neutral&&!!saturation&&!!srcData("net")?.features?.length&&JSON.stringify(srcData("net").features.map(f=>f.properties?.c))!==initialDiffColors,initialDiffColors);
    const tMode3 = performance.now();
    await setMode("OD Trips");
    await waitFor(() => kpi("Trips in selection") && host.querySelector(".ao-chart svg"), "return to trips mode");
    report.timings.modeTripsMs = Math.round(performance.now() - tMode3);
    check("od_cell retained across mode switches", cellsBeforeSwitch > 0 && Number((await h.query("SELECT count(*) AS n FROM od_cell"))[0].n) === cellsBeforeSwitch);
    check("difference layers removed when returning to trips", !layers.has(`${id}-layer-net`) && !layers.has(`${id}-layer-diff-lines`));
    const t2 = performance.now();
    await setSelect("Matrix", "after");
    await waitFor(() => digits(kpi("Trips in selection")) === 334560, "334,560 after total");
    report.timings.tripsSwitchToAfterMs = Math.round(performance.now() - t2);
    check("after total 334,560 in the plugin", true);
    // group origin
    const originSel = [...host.querySelectorAll("label.ao-field")].find((l) => l.querySelector(".ao-label")?.textContent === "Origin");
    originSel.querySelector("select").value = "group";
    originSel.querySelector("select").dispatchEvent(new Event("change"));
    await waitFor(() => digits(kpi("Trips in selection")) > 0 && digits(kpi("Trips in selection")) < 334560, "group-origin selection");
    check("origin group selection narrows the trips", digits(kpi("Trips in selection")) < 334560, kpi("Trips in selection"));
    await setMode("Balance"); await waitFor(()=>host.textContent.includes("Generation vs attraction"),"balance view");
    check("Balance view renders",host.textContent.includes("Total productions")&&host.textContent.includes("Most unbalanced"));
    await setMode("Trip length"); await waitFor(()=>host.textContent.includes("Trip length distribution"),"trip length view");
    check("Trip length view renders with overlay KPIs",host.textContent.includes("median")&&host.textContent.includes("straight-line distance"));
    await setMode("Flow matrix"); await waitFor(()=>host.querySelector('[data-testid="flow-selection"]'),"flow matrix view");
    const flowCell=host.querySelector(".ao-matrix-cell");flowCell?.click();await sleep(40);
    check("flow matrix cell scopes origin and destination",!!flowCell&&host.querySelector('[data-testid="flow-selection"]')?.textContent!=="All origins → all destinations");
    await setMode("Comparison");await waitFor(()=>host.textContent.includes("Largest group-pair changes")||/alert|error|fail/i.test(host.querySelector(".ao-alert.ao-bad")?.textContent??""),"comparison runs",60000).catch(()=>{});report.comparisonDump=host.textContent.slice(-900);
    check("Comparison contains all package runs",["AMPK_3","AMPK_3b","PMPK_3"].every(run=>host.textContent.includes(run)));
    await setMode("OD Trips");
  }
  report.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
  dispose?.();
  plugin.deactivate(app);
  check("deactivate removes layers", layers.size === 0, layers.size);
  out.textContent = (failures.length ? "FAIL " + failures.join("; ") + " " : "OK ") + JSON.stringify(report);
} catch (e) {
  out.textContent = "FAIL " + ((e && e.stack) || e) + " " + JSON.stringify(report);
}
