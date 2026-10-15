import { getDuckDbInline } from "../../_shared/src/browser";
import type { HostApp, HostPlugin } from "./host";
import { makeTranslator } from "./i18n";
import pkg from "../package.json";
import { assertStillOpen, isHostOpen } from "../../_shared/src/host-managed";
import { JourneyTimeController, PLUGIN_ID, type SavedState } from "./panel";

let app: HostApp | null = null;
let stopLocale: (() => void) | null = null;
let unregister: (() => void) | null = null;
let controller: JourneyTimeController | null = null;
let pendingState: SavedState | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;

const t = makeTranslator(PLUGIN_ID, () => app);
const title = (): string => t("title", "Modelling Journey Time");

const plugin: HostPlugin = {
  id: PLUGIN_ID,
  name: pkg.geolibre.name,
  version: pkg.version,
  urlParameterNames: ["aimsunPackage"],

  activate(a) {
    app = a;
    controller = new JourneyTimeController({ getApp: () => app, getDuck: () => getDuckDbInline(), t, initial: pendingState });
    pendingState = null;
    const c = controller;
    unregister = a.registerRightPanel?.({
      id: PLUGIN_ID,
      title,
      defaultWidth: 440,
      deactivatePluginOnClose: true,
      render: (container) => c.mount(container),
    }) ?? null;
    stopLocale = a.onLocaleChange?.(() => c.build()) ?? null;
    openTimer = setTimeout(() => { openTimer = null; a.openRightPanel?.(PLUGIN_ID); }, 0);
    if (c.getState().manifestUrl) void c.loadUrl(c.getState().manifestUrl);
  },

  deactivate(a) {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
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
    const c = controller; // deactivate() nulls the module-level controller across the await below
    if (!url || !c) return false;
    app = a;
    c.setHostManaged(isHostOpen(params));
    a.openRightPanel?.(PLUGIN_ID);
    // Resolves true only once the package finished loading; rejects with the load error message otherwise.
    const loaded = await c.loadUrl(url);
    assertStillOpen(c, controller);
    if (!loaded) throw new Error(c.loadError ?? "The analysis package could not be loaded.");
    return true;
  },

  getProjectState: () => controller?.getState() ?? pendingState ?? undefined,
  applyProjectState: (_a, state) => {
    pendingState = JourneyTimeController.parseState(state);
    controller?.applyState(pendingState);
    if (controller && pendingState?.manifestUrl) void controller.loadUrl(pendingState.manifestUrl);
    return true;
  },
};

export default plugin;
