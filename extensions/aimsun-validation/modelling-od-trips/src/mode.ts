import type { OdView, ViewEnv } from "./_od/plugin.ts";
import { el } from "./_od/ui.ts";
import { createTripsView } from "./views/trips.ts";
import { createBeforeAfterView } from "./views/before-after.ts";
import { createDiffView } from "./views/diff.ts";
import { createAdvancedView, type AdvancedMode } from "./views/advanced.ts";

export type ViewMode = "trips" | "before-after" | "difference" | AdvancedMode;
const label: Record<ViewMode, string> = { trips: "OD Trips", "before-after": "Before/After", difference: "Difference", comparison: "Comparison", balance: "Balance", length: "Trip length", matrix: "Flow matrix" };
const layers: Record<ViewMode, string[]> = { trips: ["centroids", "lines", "ends"], "before-after": [], difference: ["net", "diff-lines"], comparison: ["net", "diff-lines"], balance: ["net"], length: [], matrix: ["diff-lines"] };
const create: Record<ViewMode, (env: ViewEnv) => OdView> = { trips: createTripsView, "before-after": createBeforeAfterView, difference: createDiffView, comparison: (env) => createAdvancedView("comparison", env), balance: (env) => createAdvancedView("balance", env), length: (env) => createAdvancedView("length", env), matrix: (env) => createAdvancedView("matrix", env) };
const all: ViewMode[] = ["trips", "before-after", "difference", "comparison", "balance", "length", "matrix"];

interface SavedModeState { mode?: ViewMode; views?: Partial<Record<ViewMode, unknown>>; selection?: ViewEnv["selection"] }

export function createModeView(env: ViewEnv): OdView {
  let mode: ViewMode = "trips";
  let states: Partial<Record<ViewMode, unknown>> = {};
  let current: OdView | null = null;
  let host: HTMLElement | null = null;
  let selector: HTMLElement | null = null;
  const enabled = (): ViewMode[] => {
    const both = env.ctl.state.availableSides.includes("before") && env.ctl.state.availableSides.includes("after");
    return ["trips", "balance", "length", "matrix", ...(both ? ["before-after", "difference"] as ViewMode[] : []), ...(env.ctl.state.runs.length > 1 ? ["comparison"] as ViewMode[] : [])];
  };
  const first = (): ViewMode => enabled()[0] ?? "trips";
  const activate = (next: ViewMode): void => {
    if (!enabled().includes(next)) next = first();
    if (current) { states[mode] = current.getState(); current.dispose(); }
    mode = next;
    env.overlay.setLayers(layers[mode]);
    if (!host) { current = null; return; }
    current = create[mode](env);
    if (states[mode] !== undefined) current.setState(states[mode]);
    const body = host.querySelector<HTMLElement>(".modt-view-body");
    body?.replaceChildren();
    if (body) current.mount(body);
    drawSelector();
  };
  const drawSelector = (): void => {
    if (!selector) return;
    const avail = enabled();
    const list = el("div", { class: "ao-view-tabs", attrs: { role: "tablist", "aria-label": env.t("mode.label", "View mode"), "data-testid": "view-mode" } });
    const reasonText = env.t("mode.reason", "Requires both od_before and od_after tables.");
    all.forEach((m) => {
      const allowed = avail.includes(m);
      const disabledReason = m === "comparison" ? env.t("mode.comparisonReason", "Requires at least two package runs.") : m === "before-after" || m === "difference" ? reasonText : "";
      const tab = el("button", { class: `ao-view-tab${mode === m ? " ao-view-tab-active" : ""}`, text: env.t(`mode.${m}`, label[m]), attrs: { type: "button", role: "tab", "aria-selected": String(mode === m), "aria-controls": "modt-view-body", tabindex: mode === m ? "0" : "-1", ...(allowed ? {} : { disabled: "", title: disabledReason, "aria-description": disabledReason }) } });
      tab.addEventListener("click", () => activate(m));
      tab.addEventListener("keydown", (e) => {
        if (!(e instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const tabs = [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")].filter((x) => !x.disabled);
        const direction = getComputedStyle(list).direction === "rtl" ? -1 : 1;
        const active = Math.max(0, tabs.findIndex((x) => x.getAttribute("aria-selected") === "true"));
        const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (active + (e.key === "ArrowRight" ? direction : -direction) + tabs.length) % tabs.length;
        tabs[next]?.focus();
        const picked = all.find((m) => tabs[next]?.textContent === env.t(`mode.${m}`, label[m]));
        if (picked) activate(picked);
      });
      list.append(tab);
    });
    selector.replaceChildren(list);
    if (env.ctl.ready && avail.length < all.length) selector.append(el("p", { class: "ao-hint", text: all.filter(m=>!avail.includes(m)).map(m=>`${label[m]}: ${m==="comparison"?env.t("mode.comparisonReason","Requires at least two package runs."):reasonText}`).join(" ") }));
  };
  return {
    mount(target) {
      host = target;
      selector = el("div", { class: "ao-section" });
      const body = el("div", { class: "modt-view-body", attrs: { id: "modt-view-body", role: "tabpanel" } });
      host.replaceChildren(selector, body);
      mode = enabled().includes(mode) ? mode : first();
      drawSelector();
      env.overlay.setLayers(layers[mode]);
      current = create[mode](env);
      if (states[mode] !== undefined) current.setState(states[mode]);
      current.mount(body);
    },
    onData() {
      const next = enabled().includes(mode) ? mode : first();
      if (next !== mode) activate(next);
      else { drawSelector(); current?.onData(); }
    },
    relocalize() { drawSelector(); current?.relocalize(); },
    getState() { if (current) states[mode] = current.getState(); return { mode, views: states, selection: env.selection } satisfies SavedModeState; },
    setState(s) {
      if (!s || typeof s !== "object") return;
      const saved = s as SavedModeState;
      states = saved.views ?? {};
      if (saved.selection) env.selection = { origin: { ...saved.selection.origin }, destination: { ...saved.selection.destination } };
      const wanted = saved.mode && all.includes(saved.mode) ? saved.mode : first();
      if (host) activate(wanted); else mode = enabled().includes(wanted) ? wanted : first();
    },
    dispose() { if (current) { states[mode] = current.getState(); current.dispose(); } current = null; host = null; selector = null; env.overlay.setLayers([]); },
  };
}
