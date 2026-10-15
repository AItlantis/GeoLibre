/** aimsun-od-diff: OD adjustment differences: top gains/losses, deviation bands, net production/attraction map, group deviation table. */
import { barSvg } from "../../../_shared/src/charts.ts";
import { centroidNetSql, deviationBandsSql, groupMatrixSql, topDiffSql, totalsSql, type DiffQuery } from "../../../_shared/src/sql/od-adapter.sql.ts";
import { bandLabel, divergingHex, linesToFc, radiusPx, widthPx, type FC, type LineRow } from "../_od/calc.ts";
import type { OdView, ViewEnv } from "../_od/plugin.ts";
import { allSel, selectorControl, toSelection, validSel, type SelState } from "../_od/selector.ts";
import { chartBox, clear, el, field, kpi, section, select, table } from "../_od/ui.ts";
import { legendColor, quantileBreaks, validateLegend, volumeOpacity, type LegendConfig } from "../_od/map-logic.ts";
import { jenksBreaks } from "../analytics.ts";
import type { MatrixRow } from "./before-after.ts";
import { checksPanel } from "../_od/checks.ts";

export const DIFF_OVERLAY = [
  { id: "lines", source: "lines", type: "line" as const },
  { id: "net", source: "net", type: "circle" as const },
];

export interface DiffState {
  origin: SelState;
  minTrips: number;
  intrazonal: boolean;
  tableN: number;
  lineN: number;
  net: "prod" | "attr";
  showCircles: boolean;
  showLines: boolean;
  bandMetric: "cells" | "trips";
  topTab: "gains" | "losses";
  legend: LegendConfig;
  legendAuto: boolean;
  asymmetric: boolean;
}

const DEFAULTS = (): DiffState => ({ origin: allSel(), minTrips: 1, intrazonal: false, tableN: 25, lineN: 150, net: "prod", showCircles: true, showLines: true, bandMetric: "cells", topTab: "gains", legend: { neutral: 1, decrease: 500, increase: 500, scheme: "RdBu", classification: "linear", breaks: [100, 250, 500], classes: 5, opacityFollowsVolume: true }, legendAuto: true, asymmetric: false });

export interface DiffRow extends LineRow {
  before: number;
  after: number;
  delta: number;
  deviation_ratio: number | null;
  is_new_flow: boolean;
  origin_group?: string | null;
  destination_group?: string | null;
  dist_km: number | null;
}

interface NetRow {
  id: string;
  name: string;
  grp: string;
  lon: number;
  lat: number;
  prod_before: number;
  prod_after: number;
  attr_before: number;
  attr_after: number;
  prod_delta: number;
  attr_delta: number;
}

const nul = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function toDiffRow(r: Record<string, unknown>): DiffRow {
  return {
    origin: String(r.origin),
    destination: String(r.destination),
    origin_name: r.origin_name as string | null,
    destination_name: r.destination_name as string | null,
    origin_group: r.origin_group as string | null,
    destination_group: r.destination_group as string | null,
    before: Number(r.before),
    after: Number(r.after),
    delta: Number(r.delta),
    trips: Number(r.delta),
    deviation_ratio: nul(r.deviation_ratio),
    is_new_flow: r.is_new_flow === true || r.is_new_flow === "true" || r.is_new_flow === 1,
    o_lon: nul(r.o_lon),
    o_lat: nul(r.o_lat),
    d_lon: nul(r.d_lon),
    d_lat: nul(r.d_lat),
    dist_km: nul(r.dist_km),
  };
}

export function createDiffView(env: ViewEnv): OdView {
  const { ctl, overlay } = env;
  let st: DiffState = DEFAULTS();
  let host: HTMLElement | null = null;
  let ctrlBox: HTMLElement | null = null;
  let out: HTMLElement | null = null;
  let tok = 0;
  let netTok = "";
  let data: {
    totals: Record<string, unknown>;
    gains: DiffRow[];
    losses: DiffRow[];
    bands: Array<Record<string, unknown>>;
    matrix: MatrixRow[];
    lines: DiffRow[];
  } | null = null;
  let net: NetRow[] = [];

  const query = (): DiffQuery => ({ origin: toSelection(env.selection.origin), destination: toSelection(env.selection.destination), excludeIntrazonal: !st.intrazonal, minTrips: st.minTrips });

  const pushMap = (): void => {
    const { t, fmt } = env;
    const key = st.net === "prod" ? "prod_delta" : "attr_delta";
    const netVals=net.map((n)=>n[key]);
    const maxNet = st.legendAuto?Math.max(1e-9, quantileBreaks(netVals,20).at(-1) ?? 0):Math.max(st.legend.decrease,st.legend.increase);
    const circles: FC = {
      type: "FeatureCollection",
      features: st.showCircles
        ? net
            .filter((n) => Math.abs(n[key]) >= 0.01)
            .sort((a, b) => Math.abs(b[key]) - Math.abs(a[key]))
            .reverse()
            .map((n) => {
              const b = st.net === "prod" ? n.prod_before : n.attr_before;
              const a = st.net === "prod" ? n.prod_after : n.attr_after;
              return {
                type: "Feature" as const,
                geometry: { type: "Point", coordinates: [n.lon, n.lat] },
                properties: {
                  c: legendColor(n[key], st.legendAuto ? { ...st.legend, decrease: maxNet, increase: maxNet, neutral: 0.000001 } : st.legend,netVals),
                  r: radiusPx(n[key], maxNet, 3, 24),
                  o: st.legend.opacityFollowsVolume ? volumeOpacity(Math.abs(n[key]),0,maxNet) : 1,
                  tip: `${n.name} (${n.id})\n${n.grp}\n${st.net === "prod" ? t("net.prod", "Production") : t("net.attr", "Attraction")}: ${fmt.int(b)} → ${fmt.int(a)} (${fmt.signed(n[key], 1)})`,
                },
              };
            })
        : [],
    };
    const lines = st.showLines && data ? data.lines : [];
    const diffVals=lines.map(l=>l.delta);
    const maxD = st.legendAuto?Math.max(1e-9, quantileBreaks(diffVals,20).at(-1) ?? 0):Math.max(st.legend.decrease,st.legend.increase);
    const lfc = linesToFc(
      lines,
      (r) => legendColor((r as DiffRow).delta, st.legendAuto ? { ...st.legend, decrease: maxD, increase: maxD, neutral: 0.000001 } : st.legend,diffVals),
      (r) => widthPx(Math.abs((r as DiffRow).delta), maxD, 1, 8),
      (r) => {
        const d = r as DiffRow;
        return `${d.origin_name ?? d.origin} (${d.origin}) → ${d.destination_name ?? d.destination} (${d.destination})\n${fmt.int(d.before)} → ${fmt.int(d.after)} (${fmt.signed(d.delta, 1)})${d.is_new_flow ? ` ${t("new", "new flow")}` : ""}`;
      },
      (r) => st.legend.opacityFollowsVolume ? volumeOpacity(Math.abs((r as DiffRow).delta),0,maxD) : 1,
    );
    overlay.set("lines", lfc);
    overlay.set("net", circles);
  };

  const ratioText = (r: DiffRow): string => (r.is_new_flow ? env.t("new", "new flow") : r.deviation_ratio === null ? "–" : env.fmt.pct(r.deviation_ratio));

  const diffTable = (rows: DiffRow[]): HTMLElement => {
    const { t, fmt } = env;
    return table<DiffRow>(
      [
        { label: t("col.origin", "Origin"), value: (r) => `${r.origin}${r.origin_name ? ` ${r.origin_name}` : ""}` },
        { label: t("col.dest", "Destination"), value: (r) => `${r.destination}${r.destination_name ? ` ${r.destination_name}` : ""}` },
        { label: t("col.before", "Before"), value: (r) => fmt.num(r.before, 1), num: true },
        { label: t("col.after", "After"), value: (r) => fmt.num(r.after, 1), num: true },
        { label: t("col.delta", "Delta"), value: (r) => fmt.signed(r.delta, 1), num: true, style: (r) => `color:${r.delta < 0 ? "#2166ac" : "#b2182b"}` },
        { label: t("col.ratio", "Deviation"), value: ratioText, num: true },
      ],
      rows,
      (r) => {
        if (r.o_lon !== null && r.o_lat !== null && r.d_lon !== null && r.d_lat !== null) overlay.zoomTo((r.o_lon + r.d_lon) / 2, (r.o_lat + r.d_lat) / 2, 11);
      },
    );
  };

  const render = (): void => {
    if (!out) return;
    clear(out);
    if (!data) return;
    const { t, fmt } = env;
    const { totals, gains, losses, bands, matrix } = data;
    const pct = totals.pct === null || totals.pct === undefined ? null : Number(totals.pct);
    out.append(checksPanel(ctl,t,(v)=>fmt.int(v)));
    out.append(
      el("div", { class: "ao-kpis" }, [
        kpi(t("kpi.before", "Total before"), fmt.int(Number(totals.before))),
        kpi(t("kpi.after", "Total after"), fmt.int(Number(totals.after))),
        kpi(t("kpi.delta", "Change"), fmt.signed(Number(totals.delta)), fmt.pct(pct)),
        kpi(t("kpi.cells", "OD cells"), fmt.int(Number(totals.n_cells)), t("kpi.cellsSub", "{{n}} new flows, {{d}} dropped", { n: fmt.int(Number(totals.n_new_flow)), d: fmt.int(Number(totals.n_dropped)) })),
      ]),
    );
    // map legend
    const legendLimit=st.legendAuto?Math.max(1,quantileBreaks(net.map(n=>Math.abs(n[st.net==="prod"?"prod_delta":"attr_delta"])),20).at(-1)??1):st.legend.increase;
    const rampConfig=st.legendAuto?{...st.legend,decrease:legendLimit,increase:legendLimit,neutral:0.000001}:st.legend;
    const ramp = el("span", { class: "ao-ramp", attrs: { style: `background:linear-gradient(to right,${legendColor(-legendLimit,rampConfig)},${legendColor(0,rampConfig)},${legendColor(legendLimit,rampConfig)})` } });
    const legendControls = el("div", { class: "ao-grid" });
    const neutral = el("input", { class: "ao-input", attrs: { type: "number", min: "0.000001", step: "1", "aria-label": t("legend.neutral", "Neutral band (+/-)") } }); neutral.value = String(st.legend.neutral);
    const sat = el("input", { class: "ao-input", attrs: { type: "number", min: "0.000002", step: "1", "aria-label": t("legend.saturation", "Saturation at (+/-)") } }); sat.value = String(st.legend.increase);
    const decSat = el("input", { class: "ao-input", attrs: { type: "number", min: "0.000002", step: "1", "aria-label": t("legend.decSaturation", "Decrease saturation") } }); decSat.value=String(st.legend.decrease);
    decSat.disabled=!st.asymmetric;
    const scheme = select([{value:"RdBu",label:"RdBu"},{value:"PuOr",label:"PuOr"},{value:"blue-orange",label:t("legend.cb", "Blue-orange (colour-blind safe)")}], st.legend.scheme, v=>{st.legend.scheme=v as LegendConfig["scheme"];pushMap();render();});
    const auto = select([{value:"auto",label:t("legend.auto","Auto (from data percentiles)")},{value:"manual",label:t("legend.manual","Manual")}],st.legendAuto?"auto":"manual",v=>{st.legendAuto=v==="auto";pushMap();render();});
    const classification=select([{value:"linear",label:t("legend.linear","Linear")},{value:"quantile",label:t("legend.quantile","Quantile")},{value:"jenks",label:t("legend.jenks","Natural breaks (Jenks)")},{value:"manual",label:t("legend.manualBreaks","Manual breaks")}],st.legend.classification,v=>{st.legend.classification=v as LegendConfig["classification"];pushMap();render();});
    const classes=select(Array.from({length:7},(_,i)=>({value:String(i+3),label:String(i+3)})),String(st.legend.classes??5),v=>{st.legend.classes=Number(v);pushMap();render();});
    const opacity=el("input",{attrs:{type:"checkbox"}});opacity.checked=st.legend.opacityFollowsVolume??true;opacity.addEventListener("change",()=>{st.legend.opacityFollowsVolume=opacity.checked;pushMap();render();});
    const classValues=data?.lines.map(r=>r.delta)??[];
    const classRows=st.legend.classification==="jenks"?[-1,1].flatMap(sign=>{const part=classValues.filter(v=>Math.sign(v)===sign).map(Math.abs);const cuts=jenksBreaks(part,st.legend.classes??5);const edges=[0,...cuts,Infinity];return Array.from({length:Math.max(1,cuts.length+1)},(_,i)=>{const lo=edges[i],hi=edges[i+1];const members=part.filter(v=>v>=lo&&(hi===Infinity||v<hi));return{range:`${sign<0?"−":"+"}${fmt.num(lo,1)}–${hi===Infinity?"∞":fmt.num(hi,1)}`,count:members.length,share:part.reduce((s,v)=>s+v,0)?members.reduce((s,v)=>s+v,0)/part.reduce((s,v)=>s+v,0):0};});}):[];
    const jenksSummary=classRows.length?section(t("legend.jenksShare","Jenks ranges, counts, and trips share (shown lines)"),[table([{label:t("legend.range","Range"),value:r=>r.range},{label:t("legend.count","Lines"),value:r=>String(r.count),num:true},{label:t("legend.share","Trips share"),value:r=>fmt.pct(r.share,1),num:true}],classRows)]):null;
    const breaks=el("input",{class:"ao-input",attrs:{type:"text","aria-label":t("legend.breaks","Manual breaks")}});breaks.value=st.legend.breaks.join(", ");breaks.addEventListener("change",()=>{const values=breaks.value.split(",").map(Number);const candidate={...st.legend,breaks:values};if(validateLegend(candidate)){st.legend=candidate;pushMap();render();}else breaks.setCustomValidity(t("legend.invalidBreaks","Enter ascending numeric break values."));});
    const asym=el("input",{attrs:{type:"checkbox"}});asym.checked=st.asymmetric;asym.addEventListener("change",()=>{st.asymmetric=asym.checked;render();});
    const updateLegend=()=>{ const n=Number(neutral.value), s=Number(sat.value), d=st.asymmetric?Number(decSat.value):s; const candidate={...st.legend,neutral:n,decrease:d,increase:s}; if(validateLegend(candidate)){st.legend=candidate;pushMap();render();}else{neutral.setCustomValidity(t("legend.invalid","Values must be numeric, greater than zero, and neutral below saturation."));neutral.reportValidity();} };
    neutral.addEventListener("change",updateLegend); sat.addEventListener("change",updateLegend);decSat.addEventListener("change",updateLegend);
    legendControls.append(field(t("legend.neutral","Neutral band (+/-)"),neutral),field(t("legend.saturation","Saturation at (+/-)"),sat),el("label",{class:"ao-check"},[asym,el("span",{text:t("legend.asymmetric","Asymmetric")})]),...(st.asymmetric?[field(t("legend.decSaturation","Decrease saturation"),decSat)]:[]),field(t("legend.ramp","Ramp"),scheme),field(t("legend.mode","Scale"),auto),field(t("legend.classification","Classification"),classification),...(st.legend.classification==="manual"?[field(t("legend.breaks","Manual breaks"),breaks)]:[]),...(st.legend.classification==="jenks"?[field(t("legend.classes","Number of classes"),classes)]:[]),el("label",{class:"ao-check"},[opacity,el("span",{text:t("legend.opacity","Opacity follows volume")})]));
    const reset=el("button",{class:"ao-btn",text:t("legend.reset","Reset to defaults"),attrs:{type:"button"}}); reset.addEventListener("click",()=>{st.legend=DEFAULTS().legend;st.legendAuto=true;render();pushMap();});
    out.append(
      section(
        t("map.title", "Map: net change per centroid and largest differences"),
        [
          el("div", { class: "ao-legend" }, [el("span", { text: t("legend.dec", "decrease") }), ramp, el("span", { text: t("legend.inc", "increase") })]),
          el("div",{class:"ao-legend-ticks"},[el("span",{text:`-${fmt.int(st.legendAuto?legendLimit:st.legend.decrease)}`}),el("span",{text:"0"}),el("span",{text:`+${fmt.int(legendLimit)}`})]),legendControls, jenksSummary, reset,
          el("p", { class: "ao-hint", text: t("map.hint", "Circles: change in production (trips leaving) or attraction (trips arriving) per centroid, area ~ |change|. Lines: straight desire lines of the largest cell differences, not routes.") }),
        ],
      ),
    );
    const topTabs=el("div",{class:"ao-tabs",attrs:{role:"tablist","aria-label":t("top.title","Top gains and losses")}});
    for(const [key,title,rows] of [["gains",t("gain.title","Top gains"),gains],["losses",t("loss.title","Top losses"),losses]] as const){
      const bt=el("button",{class:"ao-tab",text:`${title} (${rows.length})`,attrs:{type:"button",role:"tab","aria-selected":String(st.topTab===key)}});bt.addEventListener("click",()=>{st.topTab=key;render();});topTabs.append(bt);
    }
    out.append(section(t("top.title","Top gains / losses"),[topTabs,diffTable(st.topTab==="gains"?gains:losses)]));
    // deviation bands
    const by = new Map(bands.map((b) => [Number(b.band), b]));
    const metric = st.bandMetric;
    const val = (b: Record<string, unknown> | undefined): number => (b ? Number(metric === "cells" ? b.cells : b.before) : 0);
    const bars = [0, 1, 2, 3, 4].map((i) => ({ label: bandLabel(i), value: val(by.get(i)) }));
    const newBar = by.get(-1);
    if (newBar && Number(newBar.cells) > 0) bars.push({ label: bandLabel(-1), value: metric === "cells" ? Number(newBar.cells) : Number(newBar.after) });
    out.append(
      section(
        t("band.title", "Deviation bands (|after - before| / before)"),
        [
          field(
            t("band.metric", "Count"),
            select(
              [
                { value: "cells", label: t("band.cells", "OD cells") },
                { value: "trips", label: t("band.trips", "Trips before") },
              ],
              st.bandMetric,
              (v) => {
                st.bandMetric = v as DiffState["bandMetric"];
                render();
              },
            ),
          ),
          chartBox(barSvg(bars, { label: t("band.title", "Deviation bands"), xTitle: t("band.x", "relative deviation band"), yTitle: metric === "cells" ? t("band.cells", "OD cells") : t("band.trips", "Trips before") })),
        ],
        t("band.hint", "Bands 0 / 5 / 10 / 20 / 50 % / more, as in rendering_adjustments. Cells with before = 0 have no ratio: they are shown apart as 'new' (their trips are the after value) and left out of the percentage bands."),
      ),
    );
    // group deviation table
    const gm = [...matrix].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 100);
    out.append(
      section(
        t("grp.title", "Deviation by origin group x destination group"),
        [
          table<MatrixRow>(
            [
              { label: t("col.og", "Origin group"), value: (r) => r.og },
              { label: t("col.dg", "Destination group"), value: (r) => r.dg },
              { label: t("col.before", "Before"), value: (r) => fmt.int(r.before), num: true },
              { label: t("col.after", "After"), value: (r) => fmt.int(r.after), num: true },
              { label: t("col.delta", "Delta"), value: (r) => fmt.signed(r.delta), num: true, style: (r) => `color:${r.delta < 0 ? "#2166ac" : "#b2182b"}` },
              { label: t("col.ratio", "Deviation"), value: (r) => (r.deviation_ratio === null ? t("new", "new flow") : fmt.pct(r.deviation_ratio)), num: true },
              { label: t("col.ncells", "Cells"), value: (r) => fmt.int(r.n_cells), num: true },
            ],
            gm,
          ),
        ],
        t("grp.hint", "Aggregated over the whole matrix, sorted by |delta|. Deviation = delta / before of the group pair (not the mean of cell ratios)."),
      ),
      el("p", { class: "ao-hint", text: t("timing", "Timings (ms): cells {{c}}, top {{t}}, bands {{b}}, net {{n}}.", { c: fmt.int(ctl.state.timings.cells), t: fmt.int(ctl.state.timings["q:gain"]), b: fmt.int(ctl.state.timings["q:bands"]), n: fmt.int(ctl.state.timings["q:net"]) }) }),
    );
  };

  const refresh = async (): Promise<void> => {
    if (!ctl.ready) return;
    const my = ++tok;
    const { t } = env;
    if (out) {
      clear(out);
      out.append(el("p", { class: "ao-alert", text: ctl.state.cellsReady ? t("busy", "Querying…") : t("cells.busy", "Preparing before/after cells inside DuckDB (first time per run)…") }));
    }
    try {
      await ctl.ensureCells();
      if (my !== tok) return;
      const q = query();
      const totals = (await ctl.q(totalsSql(q.origin), "totals"))[0] ?? {};
      const gains = (await ctl.q(topDiffSql({ ...q, dir: "gain", limit: Math.max(st.tableN, st.lineN) }), "gain")).map(toDiffRow);
      const losses = (await ctl.q(topDiffSql({ ...q, dir: "loss", limit: Math.max(st.tableN, st.lineN) }), "loss")).map(toDiffRow);
      const bands = await ctl.q(deviationBandsSql(q), "bands");
      const matrix = (await ctl.q<Record<string, unknown>>(groupMatrixSql(), "matrix")).map(
        (r): MatrixRow => ({ og: String(r.og), dg: String(r.dg), before: Number(r.before), after: Number(r.after), delta: Number(r.delta), deviation_ratio: nul(r.deviation_ratio), n_cells: Number(r.n_cells) }),
      );
      const key = `${ctl.state.run}|${ctl.state.grouping}`;
      if (netTok !== key) {
        net = (await ctl.q<Record<string, unknown>>(centroidNetSql(), "net"))
          .filter((r) => r.lon !== null && r.lat !== null)
          .map((r): NetRow => ({
            id: String(r.id), name: String(r.name ?? ""), grp: String(r.grp), lon: Number(r.lon), lat: Number(r.lat),
            prod_before: Number(r.prod_before), prod_after: Number(r.prod_after), attr_before: Number(r.attr_before), attr_after: Number(r.attr_after),
            prod_delta: Number(r.prod_delta), attr_delta: Number(r.attr_delta),
          }));
        netTok = key;
      }
      if (my !== tok) return;
      const lines = [...gains.slice(0, st.lineN), ...losses.slice(0, st.lineN)].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, st.lineN);
      data = { totals, gains: gains.slice(0, st.tableN), losses: losses.slice(0, st.tableN), bands, matrix, lines };
      pushMap();
      overlay.fit();
      render();
    } catch (e) {
      if (my === tok && out) {
        clear(out);
        out.append(el("p", { class: "ao-alert ao-bad", text: e instanceof Error ? e.message : String(e) }));
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 250);
  };

  const controls = (): HTMLElement => {
    const { t } = env;
    env.selection.origin = validSel(env, env.selection.origin);
    env.selection.destination = validSel(env, env.selection.destination);
    st.origin = env.selection.origin;
    const num = (label: string, v: number, min: number, max: number, step: number, set: (n: number) => void): HTMLElement => {
      const i = el("input", { class: "ao-input", attrs: { type: "number", min: String(min), max: String(max), step: String(step) } });
      i.value = String(v);
      i.addEventListener("change", () => {
        const n = Number(i.value);
        if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)));
        schedule();
      });
      return field(label, i);
    };
    const chk = (label: string, v: boolean, set: (b: boolean) => void, after?: () => void): HTMLElement => {
      const c = el("input", { attrs: { type: "checkbox" } });
      c.checked = v;
      c.addEventListener("change", () => {
        set(c.checked);
        after ? after() : schedule();
      });
      return el("label", { class: "ao-check" }, [c, el("span", { text: label })]);
    };
    return el("div", { class: "ao-section" }, [
      el("div", { class: "ao-grid" }, [
        selectorControl(env, t("origin", "Origin scope"), st.origin, (s) => {
          st.origin = env.selection.origin = s;
          schedule();
        }),
        selectorControl(env, t("dest", "Destination scope"), env.selection.destination, (s) => {
          env.selection.destination = s;
          schedule();
        }),
        num(t("min", "Min trips (max of before, after)"), st.minTrips, 0, 1e6, 0.5, (n) => (st.minTrips = n)),
        num(t("tableN", "Rows per table"), st.tableN, 5, 200, 5, (n) => (st.tableN = Math.round(n))),
        num(t("lineN", "Desire lines on map"), st.lineN, 0, 1000, 10, (n) => (st.lineN = Math.round(n))),
        field(
          t("net", "Circles show"),
          select(
            [
              { value: "prod", label: t("net.prod", "Production change") },
              { value: "attr", label: t("net.attr", "Attraction change") },
            ],
            st.net,
            (v) => {
              st.net = v as DiffState["net"];
              pushMap();
            },
          ),
        ),
      ]),
      chk(t("intra", "Include intrazonal trips"), st.intrazonal, (b) => (st.intrazonal = b)),
      el("div", { class: "ao-row" }, [
        chk(t("showCircles", "Centroid circles"), st.showCircles, (b) => (st.showCircles = b), pushMap),
        chk(t("showLines", "Desire lines"), st.showLines, (b) => (st.showLines = b), pushMap),
      ]),
    ]);
  };

  return {
    mount(h) {
      host = h;
      clear(host);
      ctrlBox = controls();
      out = el("div", { class: "ao-results" });
      host.append(ctrlBox, out);
      if (data) render();
      else if (ctl.ready) void refresh();
    },
    onData() {
      if (ctrlBox) {
        const c = controls();
        ctrlBox.replaceWith(c);
        ctrlBox = c;
      }
      void refresh();
    },
    relocalize() {
      if (ctrlBox) {
        const c = controls();
        ctrlBox.replaceWith(c);
        ctrlBox = c;
      }
      render();
    },
    getState: () => st,
    setState(s) {
      if (!s || typeof s !== "object") return;
      const x = s as Partial<DiffState>;
      st = { ...DEFAULTS(), ...x, origin: { ...env.selection.origin } };
      if (ctrlBox) {
        const c = controls();
        ctrlBox.replaceWith(c);
        ctrlBox = c;
        void refresh();
      }
    },
    dispose() {
      tok++;
      if (timer) clearTimeout(timer);
      host = out = ctrlBox = null;
    },
  };
}
