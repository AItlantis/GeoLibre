/**
 * Builds a GeoLibre plugin (right panel + toolbar menu + native map layer) around a
 * DetController. The two detector plugins only supply what differs: the results sections,
 * the map data/style and the tooltip text.
 */
import { DetController, type DbLike } from "./controller.ts";
import type { AppLike, PluginLike } from "./host.ts";
import { RunFitter } from "../../../_shared/src/fit-extent.ts";
import { DetectorMapLayer, type CircleStyle } from "./map-layer.ts";
import { controlsSection, packageSection, statusBanner, type Ctx } from "./panel-parts.ts";
import { locate, locateOid, type DetFeatureCollection } from "./geo.ts";
import { clear, el, field, makeFormat, makeTranslate } from "./ui.ts";
import type { ObsSource } from "./sql.ts";
import type { ComparisonRun } from "./comparison.ts";
import { validateCriteria, type Criteria } from "./aggregate.ts";

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
  map: () => { fc: DetFeatureCollection; style: CircleStyle } | null;
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
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeTask: Promise<void> = Promise.resolve();

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
  };

  /** Fit once per run/package to the detectors placed on the map (all detectors when none matched). */
  const fitRun = (): void => {
    if (!ctl || !app || ctl.state.phase !== "ready" || !ctl.geo) return;
    fitter ??= new RunFitter(app);
    const pts = ctl.aggs.map((a) => locate(ctl!.geo, a)).filter((p): p is { lon: number; lat: number } => !!p);
    const all = pts.length ? pts : [...ctl.geo.byOid.values(), ...ctl.geo.byEid.values()];
    fitter.fit(`${ctl.packageUrl ?? ctl.state.sourceLabel ?? ""}|${ctl.state.run ?? ""}`, all);
  };

  const pushMap = (): void => {
    if (!ctl || !layer || !sections) return;
    const m = ctl.hasGeo || activeMode === "comparison" ? sections.map() : null;
    if (m) {
      layer.update(m.fc, m.style);
      const sel = ctl.state.selectedId ? ctl.aggs.find((a) => a.id === ctl!.state.selectedId) : undefined;
      const p = sel ? locate(ctl.geo, sel) : null;
      layer.setSelected(p ? [p.lon, p.lat] : null);
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
    activeMode = s.viewMode === "comparison" || (s.viewMode === "validation" && c.hasObs) ? s.viewMode : "counts";
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
    container.append(root);
    const paint = (): void => {
      clear(dyn);
      dyn.append(statusBanner(c), controlsSection(c));
      const chooseMode = (v: ViewMode): void => {
        if (v === "validation" && !c.ctl.hasObs) return;
        if (v === "comparison" && c.ctl.state.runs.length < 2) return;
        activeMode = v;
        const currentLayer = layer;
        if (ctx && currentLayer) sections = cfg.build({ ctx, layer: currentLayer, selectAndZoom: (id) => { c.ctl.select(id); const a = c.ctl.aggs.find((x) => x.id === id); const p = a ? locate(c.ctl.geo, a) : null; if (p) currentLayer.zoomTo(p.lon, p.lat); }, zoomToOid: (oid) => { const p = locateOid(c.ctl.geo, oid); if (p) currentLayer.zoomTo(p.lon, p.lat); }, rerender: () => { pushMap(); renderers.forEach((r) => r()); }, loadComparisonRuns: () => c.ctl.loadComparisonRuns(), selectComparisonDetector: (run, id) => c.ctl.selectComparisonDetector(run, id) }, activeMode);
        pushMap();
        renderers.forEach((r) => r());
      };
      const mode = el("div", { class: "av-tabs", attrs: { role: "tablist", "aria-label": t("mode.label", "View mode"), "data-testid": "view-mode" } }, [
        el("button", { class: `av-tab${activeMode === "counts" ? " av-tab-active" : ""}`, text: t("mode.counts", "Counts"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "counts") }, on: { click: () => chooseMode("counts") } }),
        el("button", { class: `av-tab${activeMode === "validation" ? " av-tab-active" : ""}`, text: t("mode.validation", "Validation"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "validation"), ...(c.ctl.hasObs ? {} : { disabled: "" }) }, on: { click: () => chooseMode("validation") } }),
        el("button", { class: `av-tab${activeMode === "comparison" ? " av-tab-active" : ""}`, text: t("mode.comparison", "Comparison"), attrs: { type: "button", role: "tab", "aria-selected": String(activeMode === "comparison"), ...(c.ctl.state.runs.length > 1 ? {} : { disabled: "" }) }, on: { click: () => chooseMode("comparison") } }),
      ]);
      const unavailable = c.ctl.state.phase === "ready" && !c.ctl.hasObs ? el("p", { class: "av-hint", text: t("mode.validationUnavailable", "Validation requires detectors_sim.parquet and detectors_obs.parquet; this run has no detectors_obs.parquet.") }) : null;
      dyn.append(field(t("mode.label", "View mode"), mode));
      if (unavailable) dyn.append(unavailable);
      clear(results);
      if (c.ctl.state.phase === "ready" || c.ctl.rows.length) sections!.render(results);
    };
    renderers.add(paint);
    paint();
    return () => {
      renderers.delete(paint);
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
          if (!controller.hasObs && activeMode === "validation") {
            activeMode = "counts";
            if (ctx && layer) sections = cfg.build({ ctx, layer, selectAndZoom: (id) => { controller.select(id); const a = controller.aggs.find((x) => x.id === id); const p = a ? locate(controller.geo, a) : null; if (p) layer?.zoomTo(p.lon, p.lat); }, zoomToOid: (oid) => { const p = locateOid(controller.geo, oid); if (p) layer?.zoomTo(p.lon, p.lat); }, rerender: () => { pushMap(); renderers.forEach((r) => r()); }, loadComparisonRuns: () => controller.loadComparisonRuns(), selectComparisonDetector: (run, id) => controller.selectComparisonDetector(run, id) }, activeMode);
          }
          pushMap();
          renderers.forEach((r) => r());
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

    deactivate(a: AppLike) {
      dispose(a);
    },

    /** Resolves true only once the package finished loading; rejects with the load error message otherwise. */
    async handleUrlParameters(a: AppLike, params: URLSearchParams) {
      const u = params.get("aimsunPackage");
      if (!u || !ctl) return false;
      urlBox?.setUrl(u);
      a.openRightPanel?.(panelId);
      if (!(await ctl.loadUrl(u, params.get("aimsunRun") ?? undefined))) throw new Error(ctl.state.error ?? "The analysis package could not be loaded.");
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
