/**
 * Builds a GeoLibre plugin (right panel + toolbar menu + native map layer) around a
 * DetController. The two detector plugins only supply what differs: the results sections,
 * the map data/style and the tooltip text.
 */
import { DetController, type DbLike } from "./controller.ts";
import type { AppLike, PluginLike } from "./host.ts";
import { DetectorMapLayer, type CircleStyle } from "./map-layer.ts";
import { controlsSection, packageSection, statusBanner, type Ctx } from "./panel-parts.ts";
import { locate, locateOid, type DetFeatureCollection } from "./geo.ts";
import { clear, el, makeFormat, makeTranslate } from "./ui.ts";
import type { ObsSource } from "./sql.ts";

export interface Env {
  ctx: Ctx;
  layer: DetectorMapLayer;
  /** Select a detector in the panel and on the map and zoom to it. */
  selectAndZoom: (id: string) => void;
  /** Zoom to an unmatched simulated detector by object id (no external id to select by). */
  zoomToOid: (oid: string) => void;
  rerender: () => void;
}

export interface Sections {
  /** Fill `host` with the plugin-specific sections (called on every state change). */
  render: (host: HTMLElement) => void;
  /** Map data + style for the current state, or null when there is nothing to draw. */
  map: () => { fc: DetFeatureCollection; style: CircleStyle } | null;
  /** Tooltip lines for a hovered feature. */
  describe: (props: Record<string, unknown>) => string[];
}

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
  build: (env: Env) => Sections;
}

interface SavedState {
  packageUrl?: string;
  run?: string;
  obsSource?: ObsSource;
  fromMin?: number;
  toMin?: number;
  bucket?: number;
}

export function makeDetectorPlugin(cfg: HostConfig): PluginLike {
  const panelId = `${cfg.id}-panel`;
  let app: AppLike | null = null;
  let ctl: DetController | null = null;
  let layer: DetectorMapLayer | null = null;
  let ctx: Ctx | null = null;
  let sections: Sections | null = null;
  let unsubscribers: Array<() => void> = [];
  let renderers = new Set<() => void>();
  let urlBox: { setUrl: (u: string) => void } | null = null;
  let pending: SavedState | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  const pushMap = (): void => {
    if (!ctl || !layer || !sections) return;
    const m = ctl.hasGeo ? sections.map() : null;
    if (m) {
      layer.update(m.fc, m.style);
      const sel = ctl.state.selectedId ? ctl.aggs.find((a) => a.id === ctl!.state.selectedId) : undefined;
      const p = sel ? locate(ctl.geo, sel) : null;
      layer.setSelected(p ? [p.lon, p.lat] : null);
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
    if (s.obsSource && s.obsSource !== c.state.obsSource) c.setObsSource(s.obsSource);
    if (typeof s.bucket === "number" && c.state.bucketOptions.includes(s.bucket) && s.bucket !== c.state.bucket) c.setBucket(s.bucket);
    if (typeof s.fromMin === "number" && typeof s.toMin === "number") c.setWindow(s.fromMin, s.toMin);
  };

  const buildPanel = (container: HTMLElement): (() => void) => {
    if (!app || !ctl || !ctx || !sections) return () => {};
    const c = ctx;
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

    activate(a: AppLike) {
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
      };
      sections = cfg.build(env);
      unsubscribers = [
        controller.subscribe(() => {
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
      if (openTimer !== null) clearTimeout(openTimer);
      openTimer = null;
      pending = null;
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          /* already gone */
        }
      }
      unsubscribers = [];
      renderers = new Set();
      a.closeRightPanel?.(panelId);
      layer?.dispose();
      void ctl?.dispose();
      ctl = null;
      layer = null;
      ctx = null;
      sections = null;
      urlBox = null;
      app = null;
    },

    async handleUrlParameters(a: AppLike, params: URLSearchParams) {
      const u = params.get("aimsunPackage");
      if (!u || !ctl) return;
      urlBox?.setUrl(u);
      a.openRightPanel?.(panelId);
      await ctl.loadUrl(u, params.get("aimsunRun") ?? undefined);
    },

    getProjectState(): SavedState | undefined {
      if (!ctl || !ctl.packageUrl) return undefined;
      const s = ctl.state;
      return { packageUrl: ctl.packageUrl, run: s.run ?? undefined, obsSource: s.obsSource, fromMin: s.fromMin, toMin: s.toMin, bucket: s.bucket };
    },

    applyProjectState(_a: AppLike, state: unknown) {
      if (!state || typeof state !== "object") return;
      pending = state as SavedState;
      void restore();
    },
  };
}
