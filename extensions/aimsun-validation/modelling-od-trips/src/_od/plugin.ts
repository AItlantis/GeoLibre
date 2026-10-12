/**
 * GeoLibre plugin shell for Modelling OD Trips:
 * right panel (package loader, run + grouping pickers, status), toolbar menu, map overlay lifecycle,
 * `?aimsunPackage=<manifest url>` (+ optional aimsunRun, aimsunGrouping), project state.
 * The plugin-specific part is an {@link OdView}.
 */
import { withDuckDbLock } from "../../../_shared/src/lock.ts";
import { OdController, type OdDb } from "./controller.ts";
import type { AppLike, PluginLike } from "./host.ts";
import { MapOverlay, type OverlayLayerSpec } from "./overlay.ts";
import { verifySrcHash } from "./verify.ts";
import { clear, el, field, makeFormat, makeTranslate, select, type Fmt, type Translate } from "./ui.ts";

export interface ViewEnv {
  app: AppLike;
  t: Translate;
  fmt: Fmt;
  ctl: OdController;
  overlay: MapOverlay;
  selection: { origin: { kind: "all" | "group" | "centroid"; value: string }; destination: { kind: "all" | "group" | "centroid"; value: string } };
}

export interface OdView {
  /** Build the plugin controls + results inside `host` (called each time the panel is opened). */
  mount(host: HTMLElement): void;
  /** Run / grouping / readiness changed: refresh data. */
  onData(): void;
  /** Locale changed: re-render text. */
  relocalize(): void;
  getState(): unknown;
  setState(s: unknown): void;
  dispose(): void;
  onPanelClose?(): void;
  onPanelOpen?(): void;
}

export interface OdPluginConfig {
  id: string;
  name: string;
  version: string;
  /** English defaults (translated through app.translate with plugin.<id>.* keys). */
  panelTitle: string;
  menuLabel: string;
  layerName: string;
  overlay: readonly OverlayLayerSpec[];
  getDb: () => Promise<OdDb>;
  createView: (env: ViewEnv) => OdView;
}

interface Saved {
  packageUrl?: string;
  run?: string;
  grouping?: string;
  view?: unknown;
}

export function makeOdPlugin(cfg: OdPluginConfig): PluginLike {
  const panelId = `${cfg.id}-panel`;
  let app: AppLike | null = null;
  let ctl: OdController | null = null;
  let overlay: MapOverlay | null = null;
  let view: OdView | null = null;
  let env: ViewEnv | null = null;
  let unsubscribers: Array<() => void> = [];
  let repaint = new Set<() => void>();
  let pending: Saved | null = null;
  let lastKey = "";
  let urlInput: HTMLInputElement | null = null;

  /**
   * One lazy OdDb PER ACTIVATION: the controller is created synchronously, DuckDB only starts on the first load.
   * The promise is local to this wrapper (not plugin-level) so that deactivate()'s async dispose() still reaches
   * the very OdDb (and its private catalog / connection) that the controller used.
   */
  const lazyDb = (): OdDb => {
    let dbPromise: Promise<OdDb> | null = null;
    const get = (): Promise<OdDb> => (dbPromise ??= cfg.getDb());
    return {
      query: async (sql) => (await get()).query(sql),
      exec: async (sql) => (await get()).exec(sql),
      registerSource: async (n, s) => (await get()).registerSource(n, s),
      dropFile: async (n) => (await get()).dropFile(n),
      attach: async (c) => (await get()).attach?.(c),
      detach: async (c) => (await get()).detach?.(c),
      lock: (fn) => withDuckDbLock(fn),
    };
  };

  const dataKey = (c: OdController): string => `${c.state.phase}|${c.state.run}|${c.state.grouping}`;

  const restore = async (): Promise<void> => {
    if (!ctl || !pending) return;
    const s = pending;
    pending = null;
    if (!s.packageUrl) return;
    await ctl.loadUrl(s.packageUrl, s.run);
    if (ctl.ready && s.grouping && s.grouping !== ctl.state.grouping && ctl.state.groupings.some((g) => g.name === s.grouping)) await ctl.selectGrouping(s.grouping);
    if (s.view !== undefined) view?.setState(s.view);
  };

  const buildPanel = (container: HTMLElement): (() => void) => {
    if (!app || !ctl || !env || !view) return () => {};
    const c = ctl;
    const { t, fmt } = env;
    const root = el("div", { class: "ao-root" });
    const pkg = el("div", { class: "ao-section" });
    const status = el("div", { class: "ao-status" });
    const controls = el("div", { class: "ao-section" });
    const results = el("div", { class: "ao-results" });
    root.append(pkg, status, controls, results);
    container.append(root);

    // package loader (built once; not repainted so the typed URL survives)
    const url = el("input", { class: "ao-input ao-grow", attrs: { type: "url", placeholder: t("pkg.urlPh", "Manifest URL (…/manifest.json or data folder URL)"), "aria-label": t("pkg.url", "Package manifest URL") } });
    url.value = c.packageUrl ?? "";
    urlInput = url;
    const load = el("button", { class: "ao-btn", text: t("pkg.load", "Load"), attrs: { type: "button" } });
    load.addEventListener("click", () => {
      if (url.value.trim()) void c.loadUrl(url.value.trim());
    });
    url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") load.click();
    });
    const folder = el("input", { class: "ao-file", attrs: { type: "file", webkitdirectory: "", multiple: "", "aria-label": t("pkg.folder", "Choose the data folder") } });
    folder.addEventListener("change", () => {
      if (folder.files?.length) void c.loadFiles(folder.files);
    });
    pkg.append(
      el("h3", { class: "ao-h", text: t("pkg.title", "OD package") }),
      el("div", { class: "ao-row" }, [url, load]),
      field(t("pkg.folder", "Choose the data folder"), folder),
      el("p", { class: "ao-hint", text: t("pkg.hint", "A folder with od_before.parquet and od_after.parquet for adjustment analysis, or one od.parquet / od_before.parquet / od_after.parquet matrix for assignment analysis, plus centroids.geojson. Files are streamed by DuckDB, not loaded into memory.") }),
    );

    const paint = (): void => {
      const s = c.state;
      clear(status);
      if (s.phase === "loading") status.append(el("p", { class: "ao-alert", text: s.message || t("status.loading", "Loading…") }));
      if (s.phase === "error") status.append(el("p", { class: "ao-alert ao-bad", text: s.message }));
      if (s.phase === "ready") {
        const tm = s.timings;
        status.append(
          el("p", { class: "ao-hint", text: t("status.ready", "Run {{run}} ready. Load: files {{a}} ms, centroids {{b}} ms.", { run: s.run ?? "", a: fmt.int(tm.register), b: fmt.int(tm.centroids) }) }),
        );
        const ok = s.hashes.filter((h) => h.state === "verified");
        const no = s.hashes.filter((h) => h.state !== "verified");
        if (ok.length) status.append(el("p", { class: "ao-hint", text: t("status.hashOk", "sha256 verified: {{files}} ({{ms}} ms).", { files: ok.map((h) => h.name).join(", "), ms: fmt.int(tm.verify ?? 0) }) }));
        if (no.length) status.append(el("p", { class: "ao-alert ao-warn", text: t("status.hashNo", "Hash not verified (no sha256 in the manifest): {{files}}.", { files: no.map((h) => h.name).join(", ") }) }));
      }
      for (const i of s.incomplete) status.append(el("p", { class: "ao-alert ao-warn", text: t("status.incomplete", "Run {{run}} skipped: missing {{what}}.", { run: i.run, what: i.missing.join(", ") }) }));
      clear(controls);
      if (s.phase !== "ready" && !s.runs.length) return;
      const row = el("div", { class: "ao-grid" });
      if (s.runs.length) row.append(field(t("run", "Run"), select(s.runs.map((r) => ({ value: r, label: r })), s.run ?? "", (v) => void c.selectRun(v))));
      if (s.groupings.length) {
        row.append(
          field(
            t("grouping", "Centroid grouping"),
            select(
              s.groupings.map((g) => ({ value: g.name, label: `${g.name} (${g.nGroups})` })),
              s.grouping ?? "",
              (v) => void c.selectGrouping(v),
            ),
          ),
        );
      }
      controls.append(row);
      if (s.groups.length) {
        controls.append(el("p", { class: "ao-hint", text: t("groups", "Groups: {{list}}", { list: s.groups.map((g) => `${g.name} (${fmt.int(g.n)})`).join(", ") }) }));
      } else if (s.phase === "ready") {
        controls.append(el("p", { class: "ao-alert ao-warn", text: t("nogroups", "This package has no centroid grouping: all centroids form one group.") }));
      }
    };
    repaint.add(paint);
    paint();
    view.mount(results);
    view.onPanelOpen?.();
    return () => {
      repaint.delete(paint);
      view?.onPanelClose?.();
      urlInput = null;
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
      const controller = new OdController(lazyDb(), { verify: (src) => verifySrcHash(src) });
      ctl = controller;
      overlay = new MapOverlay(a, `${cfg.id}-layer`, t("layer", cfg.layerName), cfg.overlay);
      env = { app: a, t, fmt, ctl: controller, overlay, selection: { origin: { kind: "all", value: "" }, destination: { kind: "all", value: "" } } };
      view = cfg.createView(env);
      unsubscribers.push(
        controller.subscribe(() => {
          repaint.forEach((r) => r());
          const k = dataKey(controller);
          if (k !== lastKey) {
            lastKey = k;
            if (controller.ready) view?.onData();
          }
        }),
      );
      const stopLocale = a.onLocaleChange?.((loc) => {
        if (env) env.fmt = makeFormat(loc);
        repaint.forEach((r) => r());
        view?.relocalize();
      });
      if (stopLocale) unsubscribers.push(stopLocale);
      const unreg = a.registerRightPanel?.({ id: panelId, title: () => {
        const hint = controller.state.analysis;
        return hint ? t(`analysis.${hint}`, `${cfg.panelTitle} · ${hint === "adjustment" ? "Adjustment" : "Assignment"}`) : t("title", cfg.panelTitle);
      }, defaultWidth: 520, render: buildPanel });
      if (unreg) unsubscribers.push(unreg);
      const unmenu = a.registerToolbarMenu?.({
        id: `${cfg.id}-menu`,
        label: () => t("menu", cfg.menuLabel),
        items: [{ id: "open", label: () => t("menu.open", "Open panel"), onSelect: () => void a.openRightPanel?.(panelId) }],
      });
      if (unmenu) unsubscribers.push(unmenu);
      setTimeout(() => a.openRightPanel?.(panelId), 0);
      void restore();
    },

    deactivate(a: AppLike) {
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          /* already gone */
        }
      }
      unsubscribers = [];
      repaint = new Set();
      a.closeRightPanel?.(panelId);
      view?.dispose();
      overlay?.dispose();
      void ctl?.dispose();
      ctl = null;
      overlay = null;
      view = null;
      env = null;
      urlInput = null;
      app = null;
    },

    async handleUrlParameters(a: AppLike, params: URLSearchParams) {
      const u = params.get("aimsunPackage");
      if (!u || !ctl) return;
      if (urlInput) urlInput.value = u;
      a.openRightPanel?.(panelId);
      await ctl.loadUrl(u, params.get("aimsunRun") ?? undefined);
      const g = params.get("aimsunGrouping");
      if (g && ctl.ready && ctl.state.groupings.some((x) => x.name === g)) await ctl.selectGrouping(g);
    },

    getProjectState(): Saved | undefined {
      if (!ctl || !ctl.packageUrl) return undefined;
      return { packageUrl: ctl.packageUrl, run: ctl.state.run ?? undefined, grouping: ctl.state.grouping ?? undefined, view: view?.getState() };
    },

    applyProjectState(_a: AppLike, state: unknown) {
      if (!state || typeof state !== "object") return;
      pending = state as Saved;
      void restore();
    },
  };
}
