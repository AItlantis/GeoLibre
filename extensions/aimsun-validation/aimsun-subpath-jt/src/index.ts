/**
 * GeoLibre drop-in plugin: observed subpath journey time (AItlantis/GeoLibre#37).
 * Loaded by GeoLibre as fetch -> Blob -> import(): the single default export is the plugin.
 */
import { getDuckDbInline } from "../../_shared/src/browser";
import type { HostApp, HostPlugin } from "./common/host";
import { makeTranslator } from "./common/i18n";
import pkg from "../package.json";
import { JtController, PLUGIN_ID } from "./panel";

let app: HostApp | null = null;
let stopLocale: (() => void) | null = null;
let unregister: (() => void) | null = null;
let controller: JtController | null = null;

const t = makeTranslator(PLUGIN_ID, () => app);
const title = (): string => t("title", "Subpath journey time (observed)");

const plugin: HostPlugin = {
  id: PLUGIN_ID,
  name: pkg.geolibre.name,
  version: pkg.version,
  urlParameterNames: ["aimsunPackage"],

  activate(a) {
    app = a;
    controller = new JtController({ getApp: () => app, getDuck: () => getDuckDbInline(), t });
    const c = controller;
    unregister =
      a.registerRightPanel?.({
        id: PLUGIN_ID,
        title,
        defaultWidth: 440,
        deactivatePluginOnClose: true,
        render: (container) => c.mount(container),
      }) ?? null;
    stopLocale = a.onLocaleChange?.(() => c.build()) ?? null;
    // Open after the host finished registering (same deferral the built-in controls use).
    setTimeout(() => a.openRightPanel?.(PLUGIN_ID), 0);
  },

  deactivate(a) {
    stopLocale?.();
    stopLocale = null;
    unregister?.();
    unregister = null;
    a.unregisterRightPanel?.(PLUGIN_ID);
    controller?.dispose();
    controller = null;
    app = null;
  },

  async handleUrlParameters(a, params) {
    const url = params.get("aimsunPackage");
    if (!url) return;
    app = a;
    a.openRightPanel?.(PLUGIN_ID);
    await controller?.loadUrl(url);
  },
};

export default plugin;
