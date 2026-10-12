/** Detector validation: KPIs, scatter + OLS, GEH histogram, status map colouring, worst-N table. */
import { computeKpis, gehBins, sortAggs, worstN } from "../../aimsun-detector-counts/src/common/aggregate.ts";
import { buildFeatures, buildUnmatchedFeatures } from "../../aimsun-detector-counts/src/common/geo.ts";
import { statusColor } from "../../aimsun-detector-counts/src/common/map-layer.ts";
import { detectorTable, kpiGrid, unmatchedTable, unmatchedWarning } from "../../aimsun-detector-counts/src/common/panel-parts.ts";
import type { Env, Sections } from "../../aimsun-detector-counts/src/common/plugin-host.ts";
import { el, field, selectEl, STATUS_COLORS } from "../../aimsun-detector-counts/src/common/ui.ts";
import { histogramSvg, mountChart, scatterSvg } from "../../_shared/src/charts.ts";

export const VALIDATION_INITIAL_STYLE = { radius: 6, color: statusColor() };

export function buildValidationSections(env: Env): Sections {
  const { ctx } = env;

  return {
    describe(p) {
      const { t, fmt } = ctx;
      if (String(p.status ?? "") === "unmatched") {
        return [
          t("tip.unmatched", "Detector (object id {{id}}): no external id", { id: String(p.oid ?? "") }),
          t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(Number(p.sim)) }),
          t("tip.excluded", "Excluded from validation"),
        ];
      }
      const st = String(p.status ?? "");
      const label = st === "pass" ? t("status.pass", "Pass") : st === "warn" ? t("status.warn", "Warn") : t("status.fail", "Fail");
      return [
        t("tip.detector", "Detector {{id}}", { id: String(p.eid ?? "") }),
        t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(Number(p.sim)) }),
        t("tip.obs", "Observed: {{v}} veh/h", { v: fmt.int(Number(p.obs)) }),
        t("tip.geh", "GEH {{v}} ({{s}})", { v: fmt.num(Number(p.geh), 1), s: label }),
      ];
    },

    map() {
      const { ctl } = ctx;
      const { fc } = buildFeatures(ctl.aggs, ctl.geo);
      fc.features.push(...buildUnmatchedFeatures(ctl.unmatched, ctl.geo));
      return { fc, style: { radius: 6, color: statusColor() } };
    },

    render(host) {
      const { t, fmt, ctl } = ctx;
      const rows = ctl.rows;
      const aggs = ctl.aggs;
      const k = computeKpis(rows);

      if (!ctl.hasGeo) {
        host.append(
          el("p", {
            class: "av-alert av-warn",
            attrs: { role: "status", "data-testid": "degraded" },
            text: t(
              "degraded",
              "Degraded mode: this run has no detector geometry (detectors.geojson), so detectors are not coloured on the map. KPIs, charts and tables only.",
            ) + (ctl.geoNote ? ` (${ctl.geoNote})` : ""),
          }),
        );
      }

      const warn = unmatchedWarning(ctx);
      if (warn) host.append(warn);
      const um = unmatchedTable(ctx, (oid) => env.zoomToOid(oid));

      if (k.n === 0) {
        host.append(el("p", { class: "av-hint", text: t("tbl.empty", "No detectors with both simulated and observed flow in this window.") }));
        if (um) host.append(um);
        return;
      }

      // KPIs. %GEH<5 is judged against the 85 % target; the rest are descriptive.
      const tone = k.meetsTarget === null ? undefined : k.meetsTarget ? "ok" : "bad";
      host.append(
        kpiGrid([
          { key: "n", label: t("kpi.n", "Observations (detector x bucket)"), value: fmt.int(k.n) },
          { key: "rmse", label: t("kpi.rmse", "RMSE (veh/h)"), value: fmt.num(k.rmse, 1) },
          { key: "mae", label: t("kpi.mae", "MAE (veh/h)"), value: fmt.num(k.mae, 1) },
          { key: "bias", label: t("kpi.bias", "Bias, sim - obs (veh/h)"), value: fmt.signed(k.bias, 1) },
          { key: "r2", label: t("kpi.r2", "R² (OLS)"), value: fmt.num(k.r2, 3) },
          { key: "slope", label: t("kpi.slope", "Slope (sim on obs)"), value: fmt.num(k.slope, 3) },
          {
            key: "pctGeh",
            label: t("kpi.geh", "% GEH < 5 (target ≥ {{n}}%)", { n: k.targetPct }),
            value: fmt.pct(k.pctGehLt5, 1),
            tone,
            hint: k.meetsTarget === null ? undefined : k.meetsTarget ? t("kpi.meets", "Meets the target") : t("kpi.misses", "Below the target"),
          },
        ]),
        el("p", { class: "av-legend", attrs: { "data-testid": "legend" } }, [
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.pass}` } }), t("legend.pass", "GEH < 5: {{n}}", { n: fmt.int(k.nPass) })]),
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.warn}` } }), t("legend.warn", "5 to 10: {{n}}", { n: fmt.int(k.nWarn) })]),
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.fail}` } }), t("legend.fail", "> 10: {{n}}", { n: fmt.int(k.nFail) })]),
        ]),
      );

      // scatter: identity (dashed) + OLS trendline (solid), points coloured by GEH status
      const scatter = el("div", { class: "av-chart", attrs: { "data-testid": "scatter" } });
      mountChart(
        scatter,
        scatterSvg(rows.map((r) => r.obs_flow_h), rows.map((r) => r.sim_flow_h), {
          xTitle: t("chart.obs", "Observed (veh/h)"),
          yTitle: t("chart.sim", "Simulated (veh/h)"),
          label: t("chart.scatterOls", "Simulated against observed flow with identity line and OLS trendline"),
          identityLine: true,
          trend: k.slope !== null && k.intercept !== null ? { slope: k.slope, intercept: k.intercept } : null,
          pointColor: (i) => STATUS_COLORS[rows[i].geh < 5 ? "pass" : rows[i].geh <= 10 ? "warn" : "fail"],
        }),
      );
      const hist = el("div", { class: "av-chart", attrs: { "data-testid": "geh-hist" } });
      mountChart(
        hist,
        histogramSvg(gehBins(rows.map((r) => r.geh), 1, 10), {
          xTitle: t("chart.gehX", "GEH (last bin: 10 and above)"),
          yTitle: t("chart.gehY", "Observations"),
          label: t("chart.gehHist", "GEH histogram"),
        }),
      );
      host.append(
        el("h3", { class: "av-h", text: t("chart.h", "Simulated against observed") }),
        el("p", { class: "av-hint", text: t("chart.scatterNote", "Dashed: identity line. Solid: OLS trendline (simulated on observed).") }),
        scatter,
        el("h3", { class: "av-h", text: t("chart.gehH", "GEH distribution") }),
        hist,
      );

      // worst-N
      const s = ctl.state;
      const n = s.topN;
      const nSel = selectEl(
        [10, 20, 50, 100].map((v) => ({ value: v, label: String(v) })),
        [10, 20, 50, 100].includes(n) ? n : 20,
        (v) => ctl.dispatch({ type: "set-top-n", n: Number(v) }),
        { "aria-label": t("worst.n", "Number of detectors") },
      );
      const worst = sortAggs(worstN(aggs, n), s.sortKey, s.sortDir);
      host.append(
        el("h3", { class: "av-h", text: t("worst.h", "Worst detectors by GEH") }),
        field(t("worst.n", "Number of detectors"), nSel),
        el("p", { class: "av-hint", text: t("worst.note", "Select a row to zoom to the detector on the map.") }),
        detectorTable(ctx, worst, ["id", "sim", "obs", "diff", "geh", "status"], (id) => env.selectAndZoom(id), 100),
      );
      if (um) host.append(um);
    },
  };
}
