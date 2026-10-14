/** Detector counts: sections, map style and tooltip. Pure DOM; no DuckDB import (see index.ts). */
import { sortAggs } from "./common/aggregate.ts";
import { buildCoverage, buildFeatures, buildUnmatchedCoverage, buildUnmatchedFeatures } from "./common/geo.ts";
import { divergingColor, sequentialColor, sizeExpression, withUnmatchedColor } from "./common/map-layer.ts";
import { detectorTable, kpiGrid } from "./common/panel-parts.ts";
import { dayProfileBlock } from "./common/day-profile.ts";
import type { ProfileScope } from "./common/sql.ts";
import type { Env, Sections } from "./common/plugin-host.ts";
import { barSvg, mountChart, scatterSvg } from "../../_shared/src/charts.ts";
import { el, field, selectEl } from "./common/ui.ts";

export type SizeBy = "sim" | "obs";
export type ColorBy = "sim" | "obs" | "diff";

export const COUNTS_INITIAL_STYLE = { radius: 6, color: "#41ab5d" };

export function buildCountsSections(env: Env): Sections {
  const { ctx } = env;
  let sizeBy: SizeBy = "sim";
  let profileScope: ProfileScope = "mean";

  const styleFor = (maxSize: number, maxColor: number) => ({
    radius: sizeExpression(sizeBy, maxSize),
    color: withUnmatchedColor(ctx.ctl.state.colorMode === "diff" ? divergingColor("diff", maxColor) : sequentialColor(ctx.ctl.state.colorMode, maxColor)),
  });

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
      if (!ctx.ctl.hasObs) return [
        t("tip.detector", "Detector {{id}}", { id: String(p.eid ?? "") }),
        t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(Number(p.sim)) }),
      ];
      return [
        t("tip.detector", "Detector {{id}}", { id: String(p.eid ?? "") }),
        t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(Number(p.sim)) }),
        t("tip.obs", "Observed: {{v}} veh/h", { v: fmt.int(Number(p.obs)) }),
        t("tip.diff", "Difference: {{v}} veh/h", { v: fmt.signed(Number(p.diff), 0) }),
      ];
    },

    map() {
      const { ctl } = ctx;
      const { fc } = buildFeatures(ctl.aggs, ctl.geo);
      fc.features.push(...buildUnmatchedFeatures(ctl.unmatched, ctl.geo));
      const vals = (k: "sim" | "obs" | "diff") => ctl.aggs.map((a) => Math.abs(a[k]));
      const maxSize = Math.max(1, ...vals(sizeBy));
      const maxColor = Math.max(1, ...vals(ctx.ctl.state.colorMode));
      const coverage = buildCoverage(ctl.aggs, ctl.geo);
      coverage.features.push(...buildUnmatchedCoverage(ctl.unmatched, ctl.geo));
      return { fc, style: styleFor(maxSize, maxColor), coverage };
    },

    render(host) {
      const { t, fmt, ctl } = ctx;
      const aggs = ctl.aggs;
      const nSim = aggs.reduce((a, d) => a + d.sim, 0);
      const nObs = aggs.reduce((a, d) => a + d.obs, 0);

      if (!ctl.hasGeo) {
        host.append(
          el("p", {
            class: "av-alert av-warn",
            attrs: { role: "status", "data-testid": "degraded" },
            text: t(
              "degraded",
              "Degraded mode: this run has no detector geometry (detectors.geojson), so the map layer is not drawn. Tables and charts only.",
            ) + (ctl.geoNote ? ` (${ctl.geoNote})` : ""),
          }),
        );
      }

      if (!ctl.hasObs) {
        host.append(kpiGrid([
          { key: "detectors", label: t("kpi.detectors", "Simulated detectors"), value: fmt.int(aggs.length) },
          { key: "simTotal", label: t("kpi.simTotal", "Simulated, sum (veh/h)"), value: fmt.int(nSim) },
        ]));
        host.append(dayProfileBlock(ctx, profileScope, (scope) => { profileScope = scope; if (ctx.ctl.state.selectedId) ctx.ctl.select(null); env.rerender(); }));
        host.append(el("h3", { class: "av-h", text: t("tbl.h", "Detectors") }), detectorTable(ctx, sortAggs(aggs, ctl.state.sortKey, ctl.state.sortDir), ["id", "sim"], (id) => env.selectAndZoom(id)));
        return;
      }

      host.append(
        kpiGrid([
          { key: "detectors", label: t("kpi.detectors", "Detectors compared"), value: fmt.int(aggs.length) },
          { key: "simTotal", label: t("kpi.simTotal", "Simulated, sum (veh/h)"), value: fmt.int(nSim) },
          { key: "obsTotal", label: t("kpi.obsTotal", "Observed, sum (veh/h)"), value: fmt.int(nObs) },
          { key: "ratio", label: t("kpi.ratio", "Simulated / observed"), value: nObs > 0 ? fmt.num(nSim / nObs, 2) : "-" },
        ]),
        el("p", {
          class: "av-hint",
          text: t("kpi.coverage", "{{sim}} simulated and {{obs}} observed detectors in the run; {{n}} have both in this window.", {
            sim: fmt.int(ctl.counts.nSim),
            obs: fmt.int(ctl.counts.nObs),
            n: fmt.int(aggs.length),
          }),
        }),
      );

      if (ctl.hasGeo) {
        const located = buildFeatures(aggs, ctl.geo).located;
        host.append(
          el("section", { class: "av-section av-grid" }, [
            field(
              t("map.sizeBy", "Circle size"),
              selectEl([{ value: "sim", label: t("map.sim", "Simulated flow") }, { value: "obs", label: t("map.obs", "Observed flow") }], sizeBy, (v) => {
                sizeBy = v as SizeBy;
                env.rerender();
              }),
            ),
            field(
              t("map.colorBy", "Circle colour"),
              selectEl(
                [
                  { value: "sim", label: t("map.sim", "Simulated flow") },
                  { value: "obs", label: t("map.obs", "Observed flow") },
                  { value: "diff", label: t("map.diff", "Difference (blue: sim below obs, red: above)") },
                ],
                ctx.ctl.state.colorMode,
                (v) => {
                  ctx.ctl.dispatch({ type: "set-color-mode", value: v as ColorBy });
                },
              ),
            ),
            el("p", { class: "av-hint av-span", text: t("map.located", "{{n}} of {{total}} detectors placed on the map.", { n: fmt.int(located), total: fmt.int(aggs.length) }) }),
          ]),
        );
      }

      // charts
      const scatter = el("div", { class: "av-chart", attrs: { "data-testid": "scatter" } });
      mountChart(
        scatter,
        scatterSvg(aggs.map((a) => a.obs), aggs.map((a) => a.sim), {
          xTitle: t("chart.obs", "Observed (veh/h)"),
          yTitle: t("chart.sim", "Simulated (veh/h)"),
          label: t("chart.scatter", "Simulated against observed flow"),
          trend: null,
        }),
      );
      const top = [...aggs].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 15);
      const bars = el("div", { class: "av-chart", attrs: { "data-testid": "bars" } });
      mountChart(
        bars,
        barSvg(top.map((a) => ({ label: a.id, value: a.diff, color: a.diff >= 0 ? "#b2182b" : "#2166ac" })), {
          yTitle: t("chart.diff", "Sim - obs (veh/h)"),
          label: t("chart.bars", "Largest differences between simulated and observed flow"),
        }),
      );
      host.append(
        el("h3", { class: "av-h", text: t("chart.h", "Simulated against observed") }),
        scatter,
        el("h3", { class: "av-h", text: t("chart.h2", "Largest differences") }),
        bars,
      );

      // table
      const s = ctl.state;
      host.append(
        el("h3", { class: "av-h", text: t("tbl.h", "Detectors") }),
        detectorTable(ctx, sortAggs(aggs, s.sortKey, s.sortDir), ["id", "sim", "obs", "diff", "relErr"], (id) => env.selectAndZoom(id)),
      );

      host.append(dayProfileBlock(ctx, profileScope, (scope) => { profileScope = scope; if (ctx.ctl.state.selectedId) ctx.ctl.select(null); env.rerender(); }));

      const sel = s.selectedId ? aggs.find((a) => a.id === s.selectedId) : undefined;
      if (sel) {
        host.prepend(
          el("div", { class: "av-card", attrs: { "data-testid": "selected" } }, [
            el("strong", { text: t("tip.detector", "Detector {{id}}", { id: sel.id }) }),
            el("div", { text: t("tip.sim", "Simulated: {{v}} veh/h", { v: fmt.int(sel.sim) }) }),
            el("div", { text: t("tip.obs", "Observed: {{v}} veh/h", { v: fmt.int(sel.obs) }) }),
            el("div", { text: t("tip.diff", "Difference: {{v}} veh/h", { v: fmt.signed(sel.diff, 0) }) }),
          ]),
        );
      }
    },
  };
}
