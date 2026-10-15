/** Detector validation: KPIs, scatter + OLS, GEH histogram, status map colouring, worst-N table. */
import { complianceShares, computeKpis, DEFAULT_CRITERIA, flowBandStats, gehBins, sortAggs, validateCriteria, worstN, type Criteria, type Kpis, type DetAgg, type ValRow } from "./common/aggregate.ts";
import { buildCoverage, buildFeatures, buildUnmatchedCoverage, buildUnmatchedFeatures } from "./common/geo.ts";
import { directionNote, directionTip } from "./common/count-legend.ts";
import { statusColor } from "./common/map-layer.ts";
import { detectorTable, kpiGrid, unmatchedTable, unmatchedWarning } from "./common/panel-parts.ts";
import type { Env, Sections } from "./common/plugin-host.ts";
import { el, field, selectEl, STATUS_COLORS } from "./common/ui.ts";
import { groupedBarSvg, histogramSvg, mountChart, scatterSvg, stackedBarSvg } from "../../_shared/src/charts.ts";
import { dayProfileBlock } from "./common/day-profile.ts";

function complianceBlock(ctx: Env["ctx"], k: Kpis, rows: readonly ValRow[]): HTMLElement {
  const { t, fmt } = ctx;
  const criteria = ctx.ctl.state.criteria;
  const shares = complianceShares(rows, criteria);
  const percent = (n: number) => shares.n ? n / shares.n * 100 : 0;
  const section = el("section", { class: "av-section", attrs: { "data-testid": "compliance" } }, [
    el("h3", { class: "av-h", text: t("validation.compliance", "GEH compliance") }),
    kpiGrid([{ key: "compliancePct", label: t("validation.complianceHeadline", "% GEH<{{pass}} vs target ({{target}}%)", { pass: criteria.gehPass, target: criteria.targetPct }), value: fmt.pct(shares.passPct, 1), tone: shares.passPct === null ? undefined : shares.passPct >= criteria.targetPct ? "ok" : "bad" }]),
  ]);
  const chart = el("div", { class: "av-chart", attrs: { "data-testid": "compliance-bar" } });
  mountChart(chart, stackedBarSvg([
    { label: t("status.pass", "Pass"), value: percent(shares.pass), color: STATUS_COLORS.pass },
    { label: t("status.warn", "Warn"), value: percent(shares.warn), color: STATUS_COLORS.warn },
    { label: t("status.fail", "Fail"), value: percent(shares.fail), color: STATUS_COLORS.fail },
  ], criteria.targetPct, t("validation.compliance", "GEH compliance")));
  section.append(chart);
  return section;
}

function flowBandBlock(ctx: Env["ctx"], rows: readonly ValRow[]): HTMLElement {
  const { t, fmt } = ctx;
  const criteria = ctx.ctl.state.criteria;
  const bands = flowBandStats(rows, criteria);
  const color = (rate: number | null) => rate === null ? STATUS_COLORS.warn : rate >= criteria.bandPassPct ? STATUS_COLORS.pass : rate >= criteria.bandWarnPct ? STATUS_COLORS.warn : STATUS_COLORS.fail;
  const localized = (label: string) => {
    const keys: Record<string, [string, string]> = {
      "<250": ["validation.band.low", "<250"], "250-500": ["validation.band.250", "250-500"],
      "500-1000": ["validation.band.500", "500-1000"], "1000-2000": ["validation.band.1000", "1000-2000"],
      ">=2000": ["validation.band.high", ">=2000"],
    };
    const item = keys[label];
    return item ? t(item[0], item[1]) : t("validation.band.custom", label);
  };
  const passBand = el("div", { class: "av-chart", attrs: { "data-testid": "pass-rate-by-band" } });
  mountChart(passBand, groupedBarSvg(bands.filter((b) => b.passPct !== null).map((b) => ({ label: localized(b.label), value: b.passPct!, n: b.n, color: color(b.passPct) })), { label: t("validation.passBand", "Pass rate by observed flow band"), yTitle: t("validation.passRate", "% GEH<5"), maxLabelChars: 12 }));
  const table = el("table", { class: "av-table", attrs: { "data-testid": "flow-band-table" } });
  table.append(el("thead", {}, [el("tr", {}, [el("th", { text: t("validation.flowBand", "Observed flow band (veh/h)") }), el("th", { text: t("validation.n", "n") }), el("th", { text: t("validation.passRate", "% GEH<5") })])]));
  const body = el("tbody");
  for (const band of bands) body.append(el("tr", {}, [el("td", { text: localized(band.label) }), el("td", { text: fmt.int(band.n) }), el("td", { text: band.passPct === null ? "-" : fmt.pct(band.passPct, 1), attrs: { style: "color:" + color(band.passPct) } })]));
  table.append(body);
  const bias = el("div", { class: "av-chart", attrs: { "data-testid": "bias-by-band" } });
  mountChart(bias, groupedBarSvg(bands.filter((b) => b.meanBias !== null).map((b) => ({ label: localized(b.label), value: b.meanBias!, n: b.n, color: b.meanBias! >= 0 ? "#b2182b" : "#2166ac" })), { label: t("validation.biasBand", "Bias by observed flow band"), yTitle: t("validation.bias", "Mean sim - obs (veh/h)"), maxLabelChars: 12 }));
  return el("section", { class: "av-section" }, [el("h3", { class: "av-h", text: t("validation.passBand", "Pass rate by observed flow band") }), passBand, table, bias]);
}

function criteriaSection(ctx: Env["ctx"]): HTMLElement {
  const { t, ctl } = ctx;
  const c = ctl.state.criteria;
  const details = el("details", { class: "av-section", attrs: { "data-testid": "criteria" } });
  details.append(el("summary", { class: "av-h", text: t("criteria.h", "Criteria") }));
  const error = el("p", { class: "av-hint av-warn", attrs: { role: "alert" } });
  const fields: Array<[string, number]> = [
    ["gehPass", c.gehPass], ["gehFail", c.gehFail], ["targetPct", c.targetPct],
    ...c.flowBandEdges.map((value, i) => [`band${i + 1}`, value] as [string, number]),
    ["bandPassPct", c.bandPassPct], ["bandWarnPct", c.bandWarnPct],
  ];
  const labels: Record<string, string> = { gehPass: "GEH pass threshold (<)", gehFail: "GEH fail threshold (>)", targetPct: "GEH pass target (%)", band1: "Observed flow edge 1 (veh/h)", band2: "Observed flow edge 2 (veh/h)", band3: "Observed flow edge 3 (veh/h)", band4: "Observed flow edge 4 (veh/h)", bandPassPct: "Band pass-rate green threshold (%)", bandWarnPct: "Band pass-rate amber threshold (%)" };
  const inputs = fields.map(([key, value]) => {
    const input = el("input", { class: "av-input", attrs: { type: "number", min: "0", ...(key.includes("Pct") || key === "targetPct" ? { max: "100" } : {}), step: "any", value: String(value), "data-criteria": key } });
    input.addEventListener("change", () => {
      const v = Object.fromEntries([...details.querySelectorAll<HTMLInputElement>("input[data-criteria]")].map((node) => [node.dataset.criteria!, node.valueAsNumber]));
      try {
        const next = validateCriteria({ gehPass: v.gehPass, gehFail: v.gehFail, targetPct: v.targetPct,
          flowBandEdges: [v.band1, v.band2, v.band3, v.band4], bandPassPct: v.bandPassPct, bandWarnPct: v.bandWarnPct });
        ctl.dispatch({ type: "set-criteria", criteria: next }); error.textContent = "";
      } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
    });
    return field(t(`criteria.${key}`, labels[key]), input);
  });
  const reset = el("button", { class: "av-btn", text: t("criteria.reset", "Reset to defaults"), attrs: { type: "button" }, on: { click: () => ctl.dispatch({ type: "set-criteria", criteria: { ...DEFAULT_CRITERIA, flowBandEdges: [...DEFAULT_CRITERIA.flowBandEdges] } }) } });
  details.append(el("div", { class: "av-grid" }, inputs), error, reset);
  return details;
}

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
          ...directionTip(t, p),
          t("tip.excluded", "Excluded from validation"),
        ];
      }
      const criteria = ctx.ctl.state.criteria;
      const value = Number(p.geh);
      const st = value < criteria.gehPass ? "pass" : value <= criteria.gehFail ? "warn" : "fail";
      const label = st === "pass" ? t("status.pass", "Pass") : st === "warn" ? t("status.warn", "Warn") : t("status.fail", "Fail");
      return [
        t("tip.detector", "Detector {{id}}", { id: String(p.eid ?? "") }),
        t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(Number(p.sim)) }),
        t("tip.obs", "Observed: {{v}} veh/h", { v: fmt.int(Number(p.obs)) }),
        t("tip.geh", "GEH {{v}} ({{s}}; pass <{{pass}}, fail >{{fail}})", { v: fmt.num(value, 1), s: label, pass: criteria.gehPass, fail: criteria.gehFail }),
        ...directionTip(t, p),
      ];
    },

    map() {
      const { ctl } = ctx;
      const { fc } = buildFeatures(ctl.aggs, ctl.geo);
      fc.features.push(...buildUnmatchedFeatures(ctl.unmatched, ctl.geo));
      const coverage = buildCoverage(ctl.aggs, ctl.geo);
      coverage.features.push(...buildUnmatchedCoverage(ctl.unmatched, ctl.geo));
      return { fc, style: { radius: 6, color: statusColor(ctl.state.criteria.gehPass, ctl.state.criteria.gehFail) }, coverage };
    },

    render(host) {
      const { t, fmt, ctl } = ctx;
      const rows = ctl.rows;
      const aggs = ctl.aggs;
      const criteria = ctl.state.criteria;
      const k = computeKpis(rows, criteria);

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
      host.append(criteriaSection(ctx));
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
          { key: "r2", label: t("kpi.r2", "RÂ² (OLS)"), value: fmt.num(k.r2, 3) },
          { key: "slope", label: t("kpi.slope", "Slope (sim on obs)"), value: fmt.num(k.slope, 3) },
          {
            key: "pctGeh",
            label: t("kpi.geh", "% GEH < {{pass}} (target ≥ {{n}}%)", { pass: criteria.gehPass, n: k.targetPct }),
            value: fmt.pct(k.pctGehLt5, 1),
            tone,
            hint: k.meetsTarget === null ? undefined : k.meetsTarget ? t("kpi.meets", "Meets the target") : t("kpi.misses", "Below the target"),
          },
        ]),
        el("p", { class: "av-legend", attrs: { "data-testid": "legend" } }, [
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.pass}` } }), t("legend.pass", "GEH < {{limit}}: {{n}}", { limit: criteria.gehPass, n: fmt.int(k.nPass) })]),
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.warn}` } }), t("legend.warn", "{{pass}} to {{fail}}: {{n}}", { pass: criteria.gehPass, fail: criteria.gehFail, n: fmt.int(k.nWarn) })]),
          el("span", {}, [el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS.fail}` } }), t("legend.fail", "> {{limit}}: {{n}}", { limit: criteria.gehFail, n: fmt.int(k.nFail) })]),
        ]),
        ...(ctl.geo?.hasCoverage ? [directionNote(ctx)] : []),
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
          pointColor: (i) => STATUS_COLORS[rows[i].geh < criteria.gehPass ? "pass" : rows[i].geh <= criteria.gehFail ? "warn" : "fail"],
        }),
      );
      const hist = el("div", { class: "av-chart", attrs: { "data-testid": "geh-hist" } });
      mountChart(
        hist,
        histogramSvg(gehBins(rows.map((r) => r.geh), 1, Math.max(10, Math.ceil(criteria.gehFail)), [criteria.gehPass, criteria.gehFail]), {
          xTitle: t("chart.gehX", "GEH (last bin: {{fail}} and above)", { fail: Math.max(10, Math.ceil(criteria.gehFail)) }),
          yTitle: t("chart.gehY", "Observations"),
          label: t("chart.gehHist", "GEH histogram"),
          binColor: (bin) => bin.start >= criteria.gehFail ? STATUS_COLORS.fail : bin.start >= criteria.gehPass ? STATUS_COLORS.warn : STATUS_COLORS.pass,
          guides: [{ value: criteria.gehPass, label: t("chart.geh5", "GEH {{v}} pass threshold", { v: criteria.gehPass }), color: STATUS_COLORS.pass }, { value: criteria.gehFail, label: t("chart.geh10", "GEH {{v}} fail threshold", { v: criteria.gehFail }), color: STATUS_COLORS.fail }],
        }),
      );
      host.append(
        el("h3", { class: "av-h", text: t("chart.h", "Simulated against observed") }),
        el("p", { class: "av-hint", text: t("chart.scatterNote", "Dashed: identity line. Solid: OLS trendline (simulated on observed).") }),
        scatter,
        el("h3", { class: "av-h", text: t("chart.gehH", "GEH distribution") }),
        hist,
      );

      host.append(complianceBlock(ctx, k, rows), flowBandBlock(ctx, rows));
      // worst-N
      const s = ctl.state;
      const n = s.topN;
      const nSel = selectEl(
        [10, 20, 50, 100].map((v) => ({ value: v, label: String(v) })),
        [10, 20, 50, 100].includes(n) ? n : 20,
        (v) => ctl.dispatch({ type: "set-top-n", n: Number(v) }),
        { "aria-label": t("worst.n", "Number of detectors") },
      );
      const worst = sortAggs(worstN(aggs, Math.min(n, 100)), s.sortKey, s.sortDir);
      host.append(
        el("h3", { class: "av-h", text: t("worst.h", "Worst detectors by GEH") }),
        field(t("worst.n", "Number of detectors"), nSel),
        el("p", { class: "av-hint", text: t("worst.note", "Select a row to zoom to the detector and view its day profile.") }),
        detectorTable(ctx, worst, ["id", "sim", "obs", "diff", "geh", "status"], (id) => env.selectAndZoom(id), 100),
      );
      if (s.selectedId && worst.some((row) => row.id === s.selectedId)) host.append(dayProfileBlock(ctx, "detector"));
      if (um) host.append(um);
    },
  };
}



