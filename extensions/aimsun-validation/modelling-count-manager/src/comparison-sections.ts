import { comparisonKpis, joinComparison, type ComparisonRun } from "./common/comparison.ts";
import { locate } from "./common/geo.ts";
import type { DetAgg } from "./common/aggregate.ts";
import type { Env, Sections } from "./common/plugin-host.ts";
import { el, field, selectEl, STATUS_COLORS } from "./common/ui.ts";
import { kpiGrid } from "./common/panel-parts.ts";
import { dayProfileBlock } from "./common/day-profile.ts";
import { mountChart, scatterSvg } from "../../_shared/src/charts.ts";

const comparisonStatusColor = (maxAbs: number): unknown => ["case",
  ["==", ["get", "comparisonStatus"], "only"], "#8a8a8a",
  ["interpolate", ["linear"], ["to-number", ["get", "gehChange"], 0], -Math.max(1, maxAbs), "#c62828", 0, "#8a8a8a", Math.max(1, maxAbs), "#2e7d32"]];

export function buildComparisonSections(env: Env): Sections {
  const { ctx } = env;
  let loaded: ComparisonRun[] | null = null;
  let loading = false;
  let failure: string | null = null;
  let runA = "";
  let runB = "";
  const ensure = (): void => {
    if (loaded || loading || !env.loadComparisonRuns) return;
    loading = true;
    void env.loadComparisonRuns().then((runs) => {
      loaded = runs;
      const names = runs.map((r) => r.run);
      runA = names.includes(ctx.ctl.state.comparisonA ?? "") ? ctx.ctl.state.comparisonA! : names.includes("AMPK_3") ? "AMPK_3" : names[0] ?? "";
      runB = names.includes(ctx.ctl.state.comparisonB ?? "") ? ctx.ctl.state.comparisonB! : names.includes("AMPK_3b") ? "AMPK_3b" : names.find((n) => n !== runA) ?? names[0] ?? "";
      if (runA && runB) ctx.ctl.dispatch({ type: "set-comparison-runs", runA, runB });
    }).catch((e) => { failure = e instanceof Error ? e.message : String(e); }).finally(() => { loading = false; env.rerender(); });
  };
  const find = (name: string): ComparisonRun | undefined => loaded?.find((r) => r.run === name);
  const pair = () => ({ a: find(runA), b: find(runB) });
  const joined = () => { const { a, b } = pair(); return a && b ? joinComparison(a.detectors, b.detectors) : null; };
  const runSelect = (which: "a" | "b", value: string): HTMLElement => field(which === "a" ? ctx.t("comparison.runA", "Run A (baseline)") : ctx.t("comparison.runB", "Run B"),
    selectEl((loaded ?? []).map((r) => ({ value: r.run, label: r.run })), value, (v) => { if (which === "a") runA = v; else runB = v; ctx.ctl.dispatch({ type: "set-comparison-runs", runA, runB }); }, { "data-comparison-run": which }));

  return {
    describe(p) {
      const status = String(p.comparisonStatus ?? "unchanged");
      return [ctx.t("comparison.tip", "Detector {{id}}", { id: String(p.eid ?? "") }),
        ctx.t("comparison.tipChange", "GEH improvement (A − B): {{change}}", { change: ctx.fmt.signed(Number(p.gehChange), 2) }),
        ctx.t(`comparison.${status}`, status)];
    },
    map() {
      const { a, b } = pair(); const join = joined();
      if (!a || !b || !join || !(a.geo || b.geo || ctx.ctl.geo)) return null;
      const rows = join.rows;
      const common = rows.filter((r) => r.change !== null);
      const maxAbs = Math.max(1, ...common.map((r) => Math.abs(r.change!)));
      const fc = { type: "FeatureCollection" as const, features: [] as Array<{ type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, unknown> }> };
      for (const row of rows) {
        const agg = { id: row.id, oid: null } as Pick<DetAgg, "id" | "oid">;
        const pt = locate(b.geo, agg) ?? locate(a.geo, agg) ?? locate(ctx.ctl.geo, agg);
        if (!pt) continue;
        fc.features.push({ type: "Feature", geometry: { type: "Point", coordinates: [pt.lon, pt.lat] }, properties: { eid: row.id,
          gehChange: row.change ?? 0, comparisonStatus: row.change === null ? "only" : row.status } });
      }
      return { fc, style: { radius: 7, color: comparisonStatusColor(maxAbs) } };
    },
    render(host) {
      ensure();
      const { t, fmt, ctl } = ctx;
      if (failure) { host.append(el("p", { class: "av-alert av-warn", attrs: { role: "alert" }, text: failure })); return; }
      if (!loaded) { host.append(el("p", { class: "av-hint", attrs: { "data-testid": "comparison-loading" }, text: t("comparison.loading", "Loading run summaries…") })); return; }
      if (!loaded.length) { host.append(el("p", { class: "av-hint", text: t("comparison.noRuns", "No runs with observed detector data are available for comparison.") })); return; }
      if (!runA || !runB) { host.append(el("p", { class: "av-hint", text: t("comparison.needRuns", "Select two observed runs to compare.") })); return; }
      const { a, b } = pair(); const join = joined();
      if (!a || !b || !join) return;
      host.append(el("section", { class: "av-section av-grid" }, [runSelect("a", runA), runSelect("b", runB)]));
      const criteria = ctl.state.criteria;
      const kpis = new Map(loaded.map((r) => [r.run, comparisonKpis(r, criteria)]));
      const metrics: Array<[string, (r: ComparisonRun) => string]> = [
        [t("comparison.n", "n"), (r) => fmt.int(kpis.get(r.run)!.n)],
        [t("kpi.rmse", "RMSE"), (r) => fmt.num(kpis.get(r.run)!.rmse, 1)],
        [t("kpi.bias", "Bias"), (r) => fmt.signed(kpis.get(r.run)!.bias, 1)],
        [t("kpi.r2", "R²"), (r) => fmt.num(kpis.get(r.run)!.r2, 3)],
        [t("kpi.slope", "Slope"), (r) => fmt.num(kpis.get(r.run)!.slope, 3)],
        [t("comparison.pctPass", "% GEH<{{pass}} / target {{target}}%", { pass: criteria.gehPass, target: criteria.targetPct }), (r) => fmt.pct(kpis.get(r.run)!.pctGehLt5, 1)],
        [t("comparison.statusCounts", "Pass / warn / fail"), (r) => { const k = kpis.get(r.run)!; return `${fmt.int(k.nPass)} / ${fmt.int(k.nWarn)} / ${fmt.int(k.nFail)}`; }],
      ];
      const table = el("table", { class: "av-table", attrs: { "data-testid": "comparison-kpis" } });
      table.append(el("thead", {}, [el("tr", {}, [el("th", { text: "Metric" }), ...loaded.map((r) => el("th", { text: r.run }))])]));
      const tbody = el("tbody");
      for (const [label, value] of metrics) tbody.append(el("tr", {}, [el("th", { text: label }), ...loaded.map((r) => el("td", { text: value(r) }))]));
      table.append(tbody);
      host.append(el("h3", { class: "av-h", text: t("comparison.kpiHeading", "Run KPIs") }), table);
      const ka = kpis.get(a.run)!, kb = kpis.get(b.run)!;
      const delta = (x: number | null, y: number | null) => x === null || y === null ? "-" : fmt.signed(y - x, 1);
      host.append(kpiGrid([
        { key: "deltaPctGeh", label: t("comparison.deltaPct", "Change in % GEH<{{pass}}", { pass: criteria.gehPass }), value: delta(ka.pctGehLt5, kb.pctGehLt5), tone: ka.pctGehLt5 === null || kb.pctGehLt5 === null ? undefined : kb.pctGehLt5 >= ka.pctGehLt5 ? "ok" : "bad" },
        { key: "deltaRmse", label: t("comparison.deltaRmse", "Change in RMSE"), value: delta(ka.rmse, kb.rmse) },
        { key: "deltaBias", label: t("comparison.deltaBias", "Change in bias"), value: delta(ka.bias, kb.bias) },
      ]));
      if (a.startMin !== b.startMin || a.endMin !== b.endMin) host.append(el("p", { class: "av-alert av-warn", attrs: { role: "status", "data-testid": "period-differs" }, text: t("comparison.periodDiffers", "The compared run windows differ: {{a}} covers {{aStart}}–{{aEnd}} min and {{b}} covers {{bStart}}–{{bEnd}} min.", { a: a.run, aStart: a.startMin, aEnd: a.endMin, b: b.run, bStart: b.startMin, bEnd: b.endMin }) }));
      host.append(el("p", { class: "av-hint", attrs: { "data-testid": "comparison-coverage" }, text: t("comparison.coverage", "{{both}} detectors in both runs; {{onlyA}} only in {{a}}; {{onlyB}} only in {{b}}.", { both: join.both, onlyA: join.onlyA, a: a.run, onlyB: join.onlyB, b: b.run }) }));
      const common = join.rows.filter((r) => r.change !== null);
      const chart = el("div", { class: "av-chart", attrs: { "data-testid": "comparison-scatter" } });
      mountChart(chart, scatterSvg(common.map((r) => r.gehA!), common.map((r) => r.gehB!), { xTitle: `${a.run} GEH`, yTitle: `${b.run} GEH`, label: t("comparison.scatter", "Detector GEH in Run A against Run B"), identityLine: true,
        pointColor: (i) => common[i].status === "improved" ? STATUS_COLORS.pass : common[i].status === "degraded" ? STATUS_COLORS.fail : "#8a8a8a" }));
      host.append(el("h3", { class: "av-h", text: t("comparison.scatterHeading", "Per-detector GEH") }), chart);
      const renderTop = (kind: "improved" | "degraded", rows: typeof join.rows): HTMLElement => {
        const table = el("table", { class: "av-table", attrs: { "data-testid": kind === "improved" ? "most-improved" : "most-degraded" } });
        table.append(el("thead", {}, [el("tr", {}, [el("th", { text: t("tbl.detector", "Detector") }), el("th", { text: `${a.run} GEH` }), el("th", { text: `${b.run} GEH` }), el("th", { text: "Δ GEH" })])]));
        const body = el("tbody");
        for (const row of rows.slice(0, 10)) {
          const tr = el("tr", { class: "av-tr", attrs: { tabindex: "0", role: "button" }, on: { click: () => void env.selectComparisonDetector?.(row.gehB === null ? a.run : b.run, row.id) } }, [el("td", { text: row.id }), el("td", { text: fmt.num(row.gehA, 2) }), el("td", { text: fmt.num(row.gehB, 2) }), el("td", { text: fmt.signed(row.change, 2) })]);
          body.append(tr);
        }
        table.append(body); return table;
      };
      const improved = join.rows.filter((r) => r.status === "improved").sort((x, y) => y.change! - x.change!);
      const degraded = join.rows.filter((r) => r.status === "degraded").sort((x, y) => x.change! - y.change!);
      host.append(el("h3", { class: "av-h", text: t("comparison.improved", "Most improved detectors") }), renderTop("improved", improved),
        el("h3", { class: "av-h", text: t("comparison.degraded", "Most degraded detectors") }), renderTop("degraded", degraded));
      if (ctl.state.selectedId && ctl.aggs.some((r) => r.id === ctl.state.selectedId)) host.append(dayProfileBlock(ctx, "detector"));
    },
  };
}
