/**
 * Builds a GeoLibre plugin (right panel + toolbar menu + native map layer) around a
 * DetController. The two detector plugins only supply what differs: the results sections,
 * the map data/style and the tooltip text.
 */
import { DetController, type DbLike } from "./controller.ts";
import type { AppLike, PluginLike } from "./host.ts";
import { geometryPositions, RunFitter } from "../../../_shared/src/fit-extent.ts";
import { DetectorMapLayer, type CircleStyle } from "./map-layer.ts";
import { controlsSection, packageSection, statusBanner, type Ctx } from "./panel-parts.ts";
import { coverageGeometries, detectorExtentPoints, locate, locateOid, type CoverageCollection, type DetFeatureCollection } from "./geo.ts";
import { clear, el, field, makeFormat, makeTranslate } from "./ui.ts";
import type { ObsSource } from "./sql.ts";
import { assertStillOpen, isHostOpen, packageUiPlan } from "../../../_shared/src/host-managed.ts";
import type { ComparisonRun } from "./comparison.ts";
import { validateCriteria, type Criteria } from "./aggregate.ts";
import type { HostAnalysisInfo, HostInfoCallback, HostTimeWindow } from "../../../_shared/src/host-time.ts";

export interface Env {
  ctx: Ctx;
  layer: DetectorMapLayer;
  /** Select a detector in the panel and on the map and zoom to it. */
  selectAndZoom: (id: string) => void;
  /** Zoom to an unmatched simulated detector by object id (no external id to select by). */
  zoomToOid: (oid: string) => void;
  rerender: () => void;
  loadComparisonRuns?: () => Promise<ComparisonRun[]>;
  selectComparisonDetector?: (run: string, id: string) => Promise<void>;
}

export interface Sections {
  /** Fill `host` with the plugin-specific sections (called on every state change). */
  render: (host: HTMLElement) => void;
  /** Map data + style for the current state, or null when there is nothing to draw. */
  map: () => { fc: DetFeatureCollection; style: CircleStyle; coverage?: CoverageCollection } | null;
  /** Tooltip lines for a hovered feature. */
  describe: (props: Record<string, unknown>) => string[];
}

export type ViewMode = "counts" | "validation" | "comparison";

export interface HostConfig {
  id: string;
  name: string;
  version: string;
  /** English defaults (translated through app.translate with plugin.<id>.* keys). */
  panelTitle: string;
  menuLabel: string;
  layerName: string;
  prefix: string;
  getDb: () => Promise<DbLike>;
  initialStyle: CircleStyle;
  build: (env: Env, mode: ViewMode) => Sections;
}

interface SavedState {
  packageUrl?: string;
  run?: string;
  obsSource?: ObsSource;
  fromMin?: number;
  toMin?: number;
  bucket?: number;
  viewMode?: ViewMode;
  colorMode?: "sim" | "obs" | "diff";
  selectedId?: string | null;
  criteria?: Criteria;
  comparisonA?: string;
  comparisonB?: string;
}

export function makeDetectorPlugin(cfg: HostConfig): PluginLike {
  const panelId = `${cfg.id}-panel`;
  let app: AppLike | null = null;
  let ctl: DetController | null = null;
  let layer: DetectorMapLayer | null = null;
  let fitter: RunFitter | null = null;
  let ctx: Ctx | null = null;
  let sections: Sections | null = null;
  let activeMode: ViewMode = "counts";
  let unsubscribers: Array<() => void> = [];
  let renderers = new Set<() => void>();
  let urlBox: { setUrl: (u: string) => void } | null = null;
  let pending: SavedState | null = null;
  /** True while the Testudo host owns package/run selection (set by handleUrlParameters, cleared on deactivate). */
  let hostManaged = false;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeTask: Promise<void> = Promise.resolve();
  /** Host time window (C15), applied while host-managed; the host owns From/To/bucket then. */
  let hostWin: HostTimeWindow | null = null;
  let infoCb: HostInfoCallback | null = null;
  let lastInfoSig = "";
  let applyingWin = false;

  const buildInfo = (): HostAnalysisInfo | null => {
    const c = ctl;
    if (!c) return null;
    const period = c.state.phase === "ready" || c.period() ? c.period() : null;
    return {
      plugin: cfg.id,
      run: c.state.run,
      generation: 0, // stamped by the bridge
      period,
      bucket_s: period ? c.bucketSeconds() : null,
      mode: activeMode,
      cursorMode: "window",
      busy: c.state.busy || c.state.phase === "loading",
    };
  };
  const emitInfo = (): void => {
    if (!infoCb) return;
    const info = buildInfo();
    if (!info) return;
    const sig = JSON.stringify(info);
    if (sig === lastInfoSig) return;
    lastInfoSig = sig;
    try { infoCb(info); } catch { /* host callback must never break the panel */ }
  };
  /** Map the host window onto the controller (no-op until the run is probed, and when nothing changes). */
  const applyHostWin = (): void => {
    if (!hostManaged || !hostWin || !ctl || applyingWin) return;
    applyingWin = true;
    try { ctl.setHostWindow(hostWin); } finally { applyingWin = false; }
  };

  const dispose = (a: AppLike): void => {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
    pending = null;
    for (const u of unsubscribers) {
      try { u(); } catch { /* already gone */ }
    }
    unsubscribers = [];
    renderers.clear();
    a.closeRightPanel?.(panelId);
    layer?.dispose();
    fitter?.dispose();
    fitter = null;
    const oldController = ctl;
    disposeTask = oldController?.dispose() ?? Promise.resolve();
    ctl = null;
    layer = null;
    ctx = null;
    sections = null;
    urlBox = null;
    app = null;
    hostWin = null;
    infoCb = null;
    lastInfoSig = "";
  };

  /** Fit once per run/package to the detectors placed on the map (all detectors when none matched). */
  const fitRun = (): void => {
    if (!ctl || !app || ctl.state.phase !== "ready" || !ctl.geo) return;
    fitter ??= new RunFitter(app);
    const geo = ctl.geo;
    // polygon extents: each located detector contributes its anchor and the coverage of all its oids
    const located = detectorExtentPoints(geo, ctl.aggs);
    const all = located.length ? located : [...geo.byOid.values(), ...geo.byEid.values(), ...geometryPositions(coverageGeometries(geo.parts.values()))];
    fitter.fit(`${ctl.packageUrl ?? ctl.state.sourceLabel ?? ""}|${ctl.state.run ?? ""}`, all);
  };

  const pushMap = (): void => {
    if (!ctl || !layer || !sections) return;
    const m = ctl.hasGeo || activeMode === "comparison" ? sections.map() : null;
    if (m) {
      layer.update(m.fc, m.style, m.coverage);
      const sel = ctl.state.selectedId ? ctl.aggs.find((a) => a.id === ctl!.state.selectedId) : undefined;
      const p = sel ? locate(ctl.geo, sel) : null;
      layer.setSelected(p ? [p.lon, p.lat] : null, sel?.id);
      fitRun();
    } else {
      layer.clear();
    }
  };

  const restore = async (): Promise<void> => {
    if (!ctl || !pending) return;
    const s = pending;
    const c = ctl; // deactivate may null ctl while the load is in flight
    pending = null;
    if (!s.packageUrl) return;
    await c.loadUrl(s.packageUrl, s.run);
    if (ctl !== c || c.state.phase !== "ready") return;
    activeMode = (s.viewMode === "comparison" && !c.validationReason) || (s.viewMode === "validation" && c.hasObs) ? s.viewMode : "counts";
    if (ctx) sections = cfg.build({ ctx, layer: layer!, selectAndZoom: (id) => { c.select(id); const a = c.aggs.find((x) => x.id === id); const p = a ? locate(c.geo, a) : null; if (p) layer?.zoomTo(p.lon, p.lat); }, zoomToOid: (oid) => { const p = locateOid(c.geo, oid); if (p) layer?.zoomTo(p.lon, p.lat); }, rerender: () => { pushMap(); renderers.forEach((r) => r()); }, loadComparisonRuns: () => c.loadComparisonRuns(), selectComparisonDetector: (run, id) => c.selectComparisonDetector(run, id) }, activeMode);
    if (s.obsSource && s.obsSource !== c.state.obsSource) c.setObsSource(s.obsSource);
    if (typeof s.bucket === "number" && c.state.bucketOptions.includes(s.bucket) && s.bucket !== c.state.bucket) c.setBucket(s.bucket);
    if (typeof s.fromMin === "number" && typeof s.toMin === "number") c.setWindow(s.fromMin, s.toMin);
    if (s.colorMode && ["sim", "obs", "diff"].includes(s.colorMode)) c.dispatch({ type: "set-color-mode", value: s.colorMode });
    if (s.criteria) { try { c.dispatch({ type: "set-criteria", criteria: validateCriteria(s.criteria) }); } catch { /* invalid persisted criteria keep defaults */ } }
    if (s.comparisonA && s.comparisonB && c.state.runs.includes(s.comparisonA) && c.state.runs.includes(s.comparisonB)) c.dispatch({ type: "set-comparison-runs", runA: s.comparisonA, runB: s.comparisonB });
    if (typeof s.selectedId === "string") c.select(s.selectedId);
  };

  const buildPanel = (container: HTMLElement): (() => void) => {
    if (!app || !ctl || !ctx || !sections) return () => {};
    const c = ctx;
    const t = c.t;
    const root = el("div", { class: "av-root" });
    const pkg = packageSection(c, ctl.packageUrl ?? undefined);
    urlBox = pkg;
    const dyn = el("div", { class: "av-dyn" });
    const results = el("div", { class: "av-results" });
    root.append(pkg.root, dyn, results);
    const syncPkg = (): void => { pkg.root.style.display = packageUiPlan(hostManaged).showPackagePicker ? "" : "none"; };
    renderers.add(syncPkg);
    syncPkg();
    container.append(root);
    const paint = (): void => {
      clear(dyn);
      dyn.append(statusBanner(c, hostManaged), controlsSection(c, hostManaged));
      const chooseMode = (v: ViewMode): void => {
        if (v === "validation" && !c.ctl.hasObs) return;
        if (v === "comparison" && (c.ctl.state.runs.length < 2 || c.ctl.validationReason)) return;
        activeMode = v;
        const currentLayer = layer;
        if (ctx && currentLayer) sections = cfg.build({ ctx, layer: currentLayer, selectAndZoom: (id) => { c.ctl.select(id); const a = c.ctl.aggs.find((x) => x.id === id); const p = a ? locate(c.ctl.geo, a) : null; if (p) currentLayer.zoomTo(p.lon, p.lat); }, zoomToOid: (oid) => { const p = locateOid(c.ctl.geo, oid); if (p) currentLayer.zoomTo(p.lon, p.lat); }, rerender: () => { pushMap(); renderers.forEach((r) => r()); }, loadComparisonRuns: () => c.ctl.loadComparisonRuns(), selectComparisonDetector: (run, id) => c.ctl.selectComparisonDetector(run, id) }, activeMode);
        pushMap();
        renderers.forEach((r) => r());
        emitInfo();
      };
      const mode = el("div", { class: "av-tabs", attrs: { role: "tablist", "aria-label": t("mode.label", "View mode"), "data-testid": "view-mode" } }, [
        el("button", { class: `av-tab${activeMode === "counts" ? " av-tab-active" : ""}`, text: t("mode.counts", "Counts"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "counts") }, on: { click: () => chooseMode("counts") } }),
        el("button", { class: `av-tab${activeMode === "validation" ? " av-tab-active" : ""}`, text: t("mode.validation", "Validation"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "validation"), ...(c.ctl.hasObs ? {} : { disabled: "" }) }, on: { click: () => chooseMode("validation") } }),
        el("button", { class: `av-tab${activeMode === "comparison" ? " av-tab-active" : ""}`, text: t("mode.comparison", "Comparison"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "comparison"), ...(c.ctl.state.runs.length > 1 && !c.ctl.validationReason ? {} : { disabled: "" }) }, on: { click: () => chooseMode("comparison") } }),
      ]);
      const unavailable = c.ctl.state.phase === "ready" && !c.ctl.hasObs
        ? el("p", { class: "av-hint", attrs: { "data-testid": "validation-unavailable" }, text: c.ctl.validationReason
          ? t("mode.validationDisabled", "Validation and Comparison are disabled: {{reason}}.", { reason: c.ctl.validationReason })
          : t("mode.validationUnavailable", "Validation requires detectors_sim.parquet and detectors_obs.parquet; this run has no detectors_obs.parquet.") })
        : null;
      dyn.append(field(t("mode.label", "View mode"), mode));
      if (unavailable) dyn.append(unavailable);
      clear(results);
      if (c.ctl.state.phase === "ready" || c.ctl.rows.length) sections!.render(results);
    };
    renderers.add(paint);
    paint();
    return () => {
      renderers.delete(paint);
      renderers.delete(syncPkg);
      urlBox = null;
    };
  };

  return {
    id: cfg.id,
    name: cfg.name,
    version: cfg.version,
    urlParameterNames: ["aimsunPackage"],

    async activate(a: AppLike) {
      await disposeTask;
      app = a;
      const t = makeTranslate(a, cfg.id);
      const fmt = makeFormat(a.getLocale?.() ?? "en");
      const controller = new DetController({ getDb: cfg.getDb, prefix: cfg.prefix });
      ctl = controller;
      ctx = { app: a, t, fmt, ctl: controller };
      const mapLayer = new DetectorMapLayer(
        a,
        `${cfg.id}-layer`,
        t("layer", cfg.layerName),
        {
          describe: (p) => (sections ? sections.describe(p) : []),
          onSelect: (id) => controller.select(id),
        },
        cfg.initialStyle,
      );
      layer = mapLayer;
      const env: Env = {
        ctx,
        layer: mapLayer,
        zoomToOid: (oid) => {
          const p = locateOid(controller.geo, oid);
          if (p) mapLayer.zoomTo(p.lon, p.lat);
        },
        rerender: () => {
          pushMap();
          renderers.forEach((r) => r());
        },
        selectAndZoom: (id) => {
          controller.select(id);
          const agg = controller.aggs.find((x) => x.id === id);
          const p = agg ? locate(controller.geo, agg) : null;
          if (p) mapLayer.zoomTo(p.lon, p.lat);
        },
        loadComparisonRuns: () => controller.loadComparisonRuns(),
        selectComparisonDetector: (run, id) => controller.selectComparisonDetector(run, id),
      };
      sections = cfg.build(env, activeMode);
      unsubscribers = [
        controller.subscribe(() => {
          if ((!controller.hasObs && activeMode === "validation") || (controller.validationReason && activeMode === "comparison")) {
            activeMode = "counts";
            if (ctx && layer) sections = cfg.build({ ctx, layer, selectAndZoom: (id) => { controller.select(id); const a = controller.aggs.find((x) => x.id === id); const p = a ? locate(controller.geo, a) : null; if (p) layer?.zoomTo(p.lon, p.lat); }, zoomToOid: (oid) => { const p = locateOid(controller.geo, oid); if (p) layer?.zoomTo(p.lon, p.lat); }, rerender: () => { pushMap(); renderers.forEach((r) => r()); }, loadComparisonRuns: () => controller.loadComparisonRuns(), selectComparisonDetector: (run, id) => controller.selectComparisonDetector(run, id) }, activeMode);
          }
          applyHostWin();
          pushMap();
          renderers.forEach((r) => r());
          emitInfo();
        }),
      ];
      const stopLocale = a.onLocaleChange?.((loc) => {
        if (ctx) ctx.fmt = makeFormat(loc);
        renderers.forEach((r) => r());
      });
      if (stopLocale) unsubscribers.push(stopLocale);

      const unreg = a.registerRightPanel?.({
        id: panelId,
        title: () => t("title", cfg.panelTitle),
        defaultWidth: 460,
        render: buildPanel,
      });
      if (unreg) unsubscribers.push(unreg);
      const unmenu = a.registerToolbarMenu?.({
        id: `${cfg.id}-menu`,
        label: () => t("menu", cfg.menuLabel),
        items: [{ id: "open", label: () => t("menu.open", "Open panel"), onSelect: () => void a.openRightPanel?.(panelId) }],
      });
      if (unmenu) unsubscribers.push(unmenu);
      openTimer = setTimeout(() => {
        openTimer = null;
        a.openRightPanel?.(panelId);
      }, 0);
      void restore();
    },

    /** Host-only run switch (Testudo); no-op unless the host opened this plugin. */
    async setRun(run: string): Promise<boolean> {
      const c = ctl;
      if (!hostManaged || !c || !c.state.runs.includes(run)) return false;
      if (c.state.run !== run) await c.selectRun(run);
      return true;
    },

    /** Host-only time window (C15, seconds since midnight): maps to the controller window; ignored while standalone. */
    setTimeWindow(win: HostTimeWindow): void {
      if (!win || !Number.isFinite(win.from_s) || !Number.isFinite(win.to_s) || !(win.to_s > win.from_s)) return;
      hostWin = { from_s: win.from_s, to_s: win.to_s, cursor_s: Number.isFinite(win.cursor_s) ? win.cursor_s : win.from_s };
      applyHostWin();
    },

    /** Host-only info callback (period, auto bucket, tab, busy); null detaches. */
    onHostInfo(cb: HostInfoCallback | null): void {
      infoCb = cb;
      lastInfoSig = "";
      emitInfo();
    },

    deactivate(a: AppLike) {
      hostManaged = false;
      dispose(a);
    },

    /** Resolves true only once the package finished loading; rejects with the load error message otherwise. */
    async handleUrlParameters(a: AppLike, params: URLSearchParams) {
      const u = params.get("aimsunPackage");
      const c = ctl; // deactivate() nulls the module-level ctl; keep the controller this open started with across the awaits
      if (!u || !c) return false;
      const run = params.get("aimsunRun") ?? undefined;
      const host = isHostOpen(params);
      if (hostManaged !== host) {
        hostManaged = host;
        renderers.forEach((r) => r());
        applyHostWin();
      }
      urlBox?.setUrl(u);
      a.openRightPanel?.(panelId);
      // The host switches run on the already loaded package without reloading it.
      if (host && c.packageUrl === u && c.state.phase === "ready" && run && c.state.runs.includes(run)) {
        if (c.state.run !== run) await c.selectRun(run);
        assertStillOpen(c, ctl);
        return true;
      }
      const loaded = await c.loadUrl(u, run);
      assertStillOpen(c, ctl);
      if (!loaded) throw new Error(c.state.error ?? "The analysis package could not be loaded.");
      return true;
    },

    getProjectState(): SavedState | undefined {
      if (!ctl || !ctl.packageUrl) return undefined;
      const s = ctl.state;
      return { packageUrl: ctl.packageUrl, run: s.run ?? undefined, obsSource: s.obsSource, fromMin: s.fromMin, toMin: s.toMin, bucket: s.bucket, viewMode: activeMode, colorMode: s.colorMode, selectedId: s.selectedId, criteria: { ...s.criteria, flowBandEdges: [...s.criteria.flowBandEdges] }, comparisonA: s.comparisonA ?? undefined, comparisonB: s.comparisonB ?? undefined };
    },

    applyProjectState(_a: AppLike, state: unknown) {
      if (!state || typeof state !== "object") return;
      pending = state as SavedState;
      void restore();
    },
  };
}
