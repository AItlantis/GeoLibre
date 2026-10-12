// OD plugin smoke, driven by run-chrome.mjs: ?plugin=<id>&mode=url|files
// Loads the BUILT plugin the way GeoLibre does (fetch plugin.json -> fetch entry -> Blob -> import(blobUrl)), activates it
// against a fake app/map, loads REAL AMPK_3 data (manifest URL or a folder of File objects), then asserts totals and timings.
const out = document.getElementById("out");
const q = new URLSearchParams(location.search);
const id = q.get("plugin");
const mode = q.get("mode") ?? "url";
const report = { id, mode, timings: {}, checks: [] };
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
  if (mode === "url") {
    const manifestUrl = id === "aimsun-trips" ? "/data/manifest_tabular.json" : "/data/AMPK_3/manifest_aconsole.json";
    await plugin.handleUrlParameters(app, new URLSearchParams({ aimsunPackage: new URL(manifestUrl, location.href).href, aimsunRun: "AMPK_3" }));
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
  await waitFor(() => /Run AMPK_3 ready/.test(text()) || /ao-bad/.test(host.innerHTML), "package ready");
  report.timings.loadTotalMs = Math.round(performance.now() - t0);
  check("package ready without error", !host.querySelector(".ao-alert.ao-bad"), host.querySelector(".ao-alert.ao-bad")?.textContent);
  const runSel = [...host.querySelectorAll("select")][0];
  report.runs = runSel ? [...runSel.options].map((o) => o.value) : [];
  if (id === "aimsun-trips" && mode === "url") check("tabular manifest lists 3 runs (convention probe)", JSON.stringify(report.runs) === JSON.stringify(["AMPK_3", "AMPK_3b", "PMPK_3"]), report.runs);
  report.status = host.querySelector(".ao-status")?.textContent;
  const groupingSel = [...host.querySelectorAll("select")][1];
  check("default grouping is Centroids (Abu Dhabi Island)", groupingSel?.value === "Centroids (Abu Dhabi Island)", groupingSel?.value);

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
  check("od_before rows 4,422,092", b.n === 4422092, b.n);
  check("od_before total 411,943", Math.abs(b.s - 411942.63) < 1, b.s);
  check("od_after total 334,560", Math.abs(a.s - 334560.38) < 1, a.s);
  const gg = await timed(
    "groupXgroupStreamingMs",
    "SELECT co.grp AS og, cd.grp AS dg, sum(x.trips) AS s FROM v_od_before_norm x JOIN v_centroids_norm co ON co.id = x.origin JOIN v_centroids_norm cd ON cd.id = x.destination GROUP BY 1, 2",
  );
  check("group x group aggregation conserves total", Math.abs(gg.reduce((s, r) => s + r.s, 0) - 411942.63) < 1);
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

  if (id === "aimsun-trips") {
    const t1 = performance.now();
    await waitFor(() => kpi("Trips in selection") && host.querySelector(".ao-chart svg") && !host.textContent.includes("Querying"), "trips results");
    report.timings.tripsFirstResultsMs = Math.round(performance.now() - t1);
    const expect = (await h.query("SELECT sum(value) AS s FROM " + cat + ".main.od_before_raw WHERE origin_id <> destination_id AND value >= 1"))[0].s;
    check("default KPI = before trips excl. intrazonal, >= 1", Math.abs(digits(kpi("Trips in selection")) - Math.round(expect)) <= 1, [kpi("Trips in selection"), expect]);
    check("200 desire lines on the map", srcData("lines")?.features?.length === 200, srcData("lines")?.features?.length);
    check("centroid points on the map", (srcData("centroids")?.features?.length ?? 0) > 3000, srcData("centroids")?.features?.length);
    check("endpoint circles on the map", (srcData("ends")?.features?.length ?? 0) > 20);
    check("layers registered in the Layers panel", reg.native.includes(`${id}-layer`));
    check("top pairs table has rows", host.querySelectorAll(".ao-table tbody tr").length >= 100, host.querySelectorAll(".ao-table tbody tr").length);
    check("straight-line label present", /not route length/.test(host.textContent));
    // full matrix: include intrazonal + no min threshold -> exact before total
    const chk = host.querySelector('input[type="checkbox"]');
    chk.checked = true;
    chk.dispatchEvent(new Event("change"));
    await setInput("Min trips", "0");
    await waitFor(() => digits(kpi("Trips in selection")) === 411943, "411,943 before total");
    check("before total 411,943 in the plugin", digits(kpi("Trips in selection")) === 411943, kpi("Trips in selection"));
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
  } else if (id === "aimsun-od-before-after") {
    const t1 = performance.now();
    await waitFor(() => kpi("Total before") && host.querySelector(".ao-chart svg"), "before/after results");
    report.timings.baFirstResultsMs = Math.round(performance.now() - t1);
    check("KPI total before 411,943", digits(kpi("Total before")) === 411943, kpi("Total before"));
    check("KPI total after 334,560", digits(kpi("Total after")) === 334560, kpi("Total after"));
    check("heat tables + group totals", host.querySelectorAll(".ao-table").length >= 4, host.querySelectorAll(".ao-table").length);
    check("scatter svg with circles", host.querySelectorAll(".ao-chart svg circle").length > 10, host.querySelectorAll(".ao-chart svg circle").length);
    check("identity + trend lines in scatter", host.querySelectorAll(".ao-chart svg line[clip-path]").length === 2, host.querySelectorAll(".ao-chart svg line[clip-path]").length);
    report.timingsText = [...host.querySelectorAll(".ao-hint")].map((x) => x.textContent).find((x) => x.startsWith("Timings"));
    // focus an origin group by clicking its first matrix row
    const row = host.querySelector(".ao-table tbody tr.ao-click");
    const before = digits(kpi("Total before"));
    row.dispatchEvent(new Event("click"));
    await waitFor(() => digits(kpi("Total before")) !== before && digits(kpi("Total before")) > 0, "origin group focus");
    check("origin-group focus narrows the KPIs", digits(kpi("Total before")) < 411943, kpi("Total before"));
  } else if (id === "aimsun-od-diff") {
    const t1 = performance.now();
    await waitFor(() => kpi("Total before") && host.querySelector(".ao-chart svg"), "diff results");
    report.timings.diffFirstResultsMs = Math.round(performance.now() - t1);
    check("KPI total before 411,943", digits(kpi("Total before")) === 411943, kpi("Total before"));
    check("KPI total after 334,560", digits(kpi("Total after")) === 334560, kpi("Total after"));
    const tables = [...host.querySelectorAll(".ao-table")];
    check("gains, losses and group tables", tables.length === 3, tables.length);
    check("gain/loss tables have 25 rows", tables[0].querySelectorAll("tbody tr").length === 25 && tables[1].querySelectorAll("tbody tr").length === 25);
    check("deviation band bars", host.querySelectorAll(".ao-chart svg rect").length >= 5, host.querySelectorAll(".ao-chart svg rect").length);
    check("net circles on the map", (srcData("net")?.features?.length ?? 0) > 1000, srcData("net")?.features?.length);
    check("150 difference lines on the map", srcData("lines")?.features?.length === 150, srcData("lines")?.features?.length);
    report.timingsText = [...host.querySelectorAll(".ao-hint")].map((x) => x.textContent).find((x) => x.startsWith("Timings"));
  }
  report.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
  dispose?.();
  plugin.deactivate(app);
  check("deactivate removes layers", layers.size === 0, layers.size);
  out.textContent = (failures.length ? "FAIL " + failures.join("; ") + " " : "OK ") + JSON.stringify(report);
} catch (e) {
  out.textContent = "FAIL " + ((e && e.stack) || e) + " " + JSON.stringify(report);
}
