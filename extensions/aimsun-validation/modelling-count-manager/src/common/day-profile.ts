import { assembleDayProfile, mountChart, timeSeriesSvg } from "../../../_shared/src/charts.ts";
import type { Ctx } from "./panel-parts.ts";
import { el, field, selectEl } from "./ui.ts";
import type { ProfileScope } from "./sql.ts";

/** Render a shared full-day detector profile and optional matched-detector scope control. */
export function dayProfileBlock(ctx: Ctx, scope: ProfileScope, onScopeChange?: (scope: ProfileScope) => void): HTMLElement {
  const { t, fmt, ctl } = ctx;
  const selectedId = ctl.state.selectedId;
  const actualScope: ProfileScope = selectedId ? "detector" : scope;
  const data = ctl.dayProfiles[actualScope];
  const series = assembleDayProfile(data.observed, data.simulated);
  const chart = el("div", { class: "av-chart" });
  mountChart(chart, timeSeriesSvg(series, {
    label: t("day.label", "Observed day profile and simulated interval"),
    xTitle: t("day.x", "Hour of day"), yTitle: t("day.y", "Flow (veh/h)"),
    observedLabel: t("day.observed", "Observed flow"), simulatedLabel: t("day.simulated", "Simulated interval"),
  }));
  const children: Array<HTMLElement | string> = [];
  if (onScopeChange) {
    const options = [
      { value: "mean", label: t("day.scope.mean", "All matched detectors (mean flow per detector)") },
      { value: "sum", label: t("day.scope.sum", "Network total (sum)") },
      ...(selectedId ? [{ value: "detector", label: t("day.scope.detector", "Detector {{id}}", { id: selectedId }) }] : []),
    ];
    const select = selectEl(options, actualScope, (v) => { if (v === "detector") return; onScopeChange(v as ProfileScope); }, { "aria-label": t("day.scope.label", "Day profile scope") });
    children.push(field(t("day.scope.label", "Day profile scope"), select));
  }
  if (selectedId) {
    children.push(el("p", { class: "av-hint", text: t("day.selected", "Detector {{id}} ? simulated in window: {{sim}} veh/h; observed mean in window: {{obs}} veh/h.", {
      id: selectedId, sim: fmt.int(series.simulated.length ? series.simulated.reduce((sum, segment) => sum + segment.value, 0) / series.simulated.length : null), obs: fmt.int(series.observedWindowMean),
    }) }));
  }
  const shared = selectedId ? ctl.sharedOidCount(selectedId) : 1;
  if (shared > 1) {
    children.push(el("p", { class: "av-hint", attrs: { "data-testid": "shared-id-note" }, text: t("day.sharedId", "{{n}} simulated detectors share this id (mean)", { n: shared }) }));
  }
  if (!ctl.hasObsData) children.push(el("p", { class: "av-hint", text: t("day.noObs", "No observed day profile is available; showing the simulated interval only.") }));
  else if (ctl.validationReason) children.push(el("p", { class: "av-hint", attrs: { "data-testid": "profile-only-note" }, text: t("day.profileOnly", "Observed source shown as a profile only ({{reason}}); it is not used for validation.", { reason: ctl.validationReason }) }));
  if (ctl.hasObsData && !series.observed.length) children.push(el("p", { class: "av-hint", text: t("day.empty", "No observed flow is available for this selection.") }));
  if (!series.simulated.length) children.push(el("p", { class: "av-hint", text: t("day.noSim", "No simulated interval is available for this selection.") }));
  children.push(chart);
  return el("section", { class: "av-section", attrs: { "data-testid": "day-profile", "aria-label": t("day.label", "Observed day profile and simulated interval") } }, [
    el("h3", { class: "av-h", text: t("day.h", "Day profile") }), ...children,
  ]);
}
