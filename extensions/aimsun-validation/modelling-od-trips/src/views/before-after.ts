/** aimsun-od-before-after: group x group OD matrices before/after adjustment, totals per group, cell scatter, KPIs. */
import { scatterSvg } from "../../../_shared/src/charts.ts";
import { centroidNetSql, groupMatrixSql, scatterPointsSql, scatterStatsSql, totalsSql, type ScatterLevel } from "../../../_shared/src/sql/od-adapter.sql.ts";
import { divergingHex } from "../_od/calc.ts";
import type { OdView, ViewEnv } from "../_od/plugin.ts";
import { chartBox, clear, el, field, kpi, section, select, table } from "../_od/ui.ts";
import { allSel, toSelection } from "../_od/selector.ts";
import { beforeAfterBarsGeoJson } from "../_od/map-logic.ts";
import { checksPanel } from "../_od/checks.ts";

export type Mode = "side" | "before" | "after" | "delta";

export interface BaState {
  originGroup: string; // "" = all
  mode: Mode;
  level: ScatterLevel;
  bars: boolean;
  barScale: number;
  barCap: number;
  barSize: number;
  barAuto: boolean;
  barLog: boolean;
}

const DEFAULTS = (): BaState => ({ originGroup: "", mode: "side", level: "zone-group", bars: true, barScale: 3, barCap: 250, barSize: 18, barAuto: true, barLog: false });
export const SCATTER_POINTS = 3000;
export const BA_OVERLAY = [{ id: "ba-bars", source: "bars", type: "fill-extrusion" as const }];

export interface MatrixRow {
  og: string;
  dg: string;
  before: number;
  after: number;
  delta: number;
  deviation_ratio: number | null;
  n_cells: number;
}

/** Order groups: the grouping's own order (largest first), then anything else (e.g. "(none)") alphabetically. */
export function orderGroups(known: readonly string[], seen: Iterable<string>): string[] {
  const set = new Set(seen);
  const out = known.filter((g) => set.has(g));
  for (const g of [...set].sort()) if (!out.includes(g)) out.push(g);
  return out;
}

/** Sums by origin group or destination group from the group matrix. */
export function sumBy(rows: readonly MatrixRow[], key: "og" | "dg"): Map<string, { before: number; after: number }> {
  const m = new Map<string, { before: number; after: number }>();
  for (const r of rows) {
    const a = m.get(r[key]) ?? { before: 0, after: 0 };
    a.before += r.before;
    a.after += r.after;
    m.set(r[key], a);
  }
  return m;
}

export function createBeforeAfterView(env: ViewEnv): OdView {
  const { ctl, overlay } = env;
  let st: BaState = DEFAULTS();
  if (env.selection.origin.kind === "group") st.originGroup = env.selection.origin.value;
  let host: HTMLElement | null = null;
  let out: HTMLElement | null = null;
  let tok = 0;
  let data: {
    matrix: MatrixRow[];
    totals: Record<string, unknown>;
    pts: Array<{ label: string; before: number; after: number }>;
    stats: Record<string, unknown>;
    grouping: string | null;
  } | null = null;
  let mapNodes: Array<{id:string;name:string;lon:number;lat:number;prodBefore:number;prodAfter:number;attrBefore:number;attrAfter:number}> = [];
  const pushBars=():void=>{overlay.setTiltForBars(st.bars);overlay.setLayers(st.bars?["ba-bars"]:[]);const maxTrips=Math.max(1,...mapNodes.flatMap(r=>[r.prodBefore,r.prodAfter,r.attrBefore,r.attrAfter]));const scale=st.barAuto?Math.max(.1,80/(maxTrips/1000)):st.barScale;overlay.set("bars",st.bars?beforeAfterBarsGeoJson(mapNodes,scale,st.barCap,st.barSize,st.barLog):{type:"FeatureCollection",features:[]});};

  const heat = (rows: MatrixRow[], groups: string[], pick: (r: MatrixRow) => number, kind: "seq" | "div", title: string): HTMLElement => {
    const { fmt } = env;
    const cell = new Map(rows.map((r) => [`${r.og}\u0000${r.dg}`, r]));
    const vals = rows.map((r) => Math.abs(pick(r)));
    const max = Math.max(1e-9, ...vals);
    const colOf = (g: string): number => rows.filter((r) => r.dg === g).reduce((s, r) => s + pick(r), 0);
    const head = el("tr", {}, [el("th", { text: "" }), ...groups.map((g) => el("th", { text: g, class: "ao-num" })), el("th", { text: env.t("total", "Total"), class: "ao-num" })]);
    const body = groups.map((og) => {
      const tr = el("tr", { class: `ao-click${st.originGroup === og ? " ao-sel" : ""}` });
      tr.append(el("td", { text: og, class: "ao-rowhead" }));
      let sum = 0;
      for (const dg of groups) {
        const r = cell.get(`${og}\u0000${dg}`);
        const v = r ? pick(r) : 0;
        sum += v;
        const td = el("td", { text: r ? (kind === "div" ? fmt.signed(v) : fmt.int(v)) : "", class: "ao-num" });
        const a = Math.abs(v) / max;
        td.setAttribute("style", kind === "div" ? `background:${divergingHex(v, max)}${a < 0.02 ? "66" : ""}` : `background:color-mix(in srgb, var(--ao-primary) ${Math.round(Math.sqrt(a) * 70)}%, transparent)`);
        tr.append(td);
      }
      tr.append(el("td", { text: kind === "div" ? fmt.signed(sum) : fmt.int(sum), class: "ao-num ao-rowhead" }));
      tr.addEventListener("click", () => {
        st.originGroup = st.originGroup === og ? "" : og;
        env.selection.origin = st.originGroup ? { kind: "group", value: st.originGroup } : allSel();
        void refresh();
      });
      return tr;
    });
    const foot = el("tr", {}, [el("td", { text: env.t("total", "Total"), class: "ao-rowhead" }), ...groups.map((g) => el("td", { text: kind === "div" ? fmt.signed(colOf(g)) : fmt.int(colOf(g)), class: "ao-num ao-rowhead" })), el("td", { text: "" })]);
    return el("div", { class: "ao-field" }, [
      el("span", { class: "ao-label", text: title }),
      el("div", { class: "ao-table-wrap" }, [el("table", { class: "ao-table" }, [el("thead", {}, [head]), el("tbody", {}, [...body, foot])])]),
    ]);
  };

  const groupTotals = (rows: MatrixRow[], key: "og" | "dg", groups: string[], label: string): HTMLElement => {
    const { fmt, t } = env;
    const m = sumBy(rows, key);
    const list = groups.filter((g) => m.has(g)).map((g) => ({ g, ...m.get(g)! }));
    return table(
      [
        { label, value: (r) => r.g },
        { label: t("col.before", "Before"), value: (r) => fmt.int(r.before), num: true },
        { label: t("col.after", "After"), value: (r) => fmt.int(r.after), num: true },
        { label: t("col.delta", "Delta"), value: (r) => fmt.signed(r.after - r.before), num: true },
        { label: "%", value: (r) => (r.before ? fmt.pct((r.after - r.before) / r.before) : "–"), num: true },
      ],
      list,
      key === "og"
        ? (r) => {
            st.originGroup = st.originGroup === r.g ? "" : r.g;
            env.selection.origin = st.originGroup ? { kind: "group", value: st.originGroup } : allSel();
            void refresh();
          }
        : undefined,
    );
  };

  const render = (): void => {
    if (!out) return;
    clear(out);
    if (!data) return;
    const { t, fmt } = env;
    const { matrix, pts, stats } = data;
    const groups = orderGroups(ctl.state.groups.map((g) => g.name), matrix.flatMap((r) => [r.og, r.dg]));
    const scope = st.originGroup ? matrix.filter((r) => r.og === st.originGroup) : matrix;
    const b = scope.reduce((s, r) => s + r.before, 0);
    const a = scope.reduce((s, r) => s + r.after, 0);
    const pct = b ? (a - b) / b : null;
    const tm = ctl.state.timings;
    const num=(label:string,value:number,set:(n:number)=>void,min:number,max:number,step:number):HTMLElement=>{const i=el("input",{class:"ao-input",attrs:{type:"number",min:String(min),max:String(max),step:String(step)}});i.value=String(value);i.addEventListener("change",()=>{const n=Number(i.value);if(Number.isFinite(n)&&n>=min&&n<=max){set(n);pushBars();}});return field(label,i);};
    const show=el("input",{attrs:{type:"checkbox"}});show.checked=st.bars;show.addEventListener("change",()=>{st.bars=show.checked;pushBars();});
    const scaleControl=num(t("bars.scale","Height scale (m per 1000 trips)"),st.barScale,n=>st.barScale=n,0.1,100,0.1);scaleControl.querySelector("input")!.disabled=st.barAuto;
    const scaleMode=select([{value:"auto",label:t("bars.auto","Auto")},{value:"manual",label:t("bars.manual","Manual")}],st.barAuto?"auto":"manual",v=>{st.barAuto=v==="auto";render();pushBars();});
    const logarithmic=el("input",{attrs:{type:"checkbox"}});logarithmic.checked=st.barLog;logarithmic.addEventListener("change",()=>{st.barLog=logarithmic.checked;pushBars();});
    out.append(checksPanel(ctl,t,(v)=>fmt.int(v)));
    out.append(
      section(t("map.layers","Map layers"),[el("div",{class:"ao-map-mini"},[el("label",{class:"ao-check"},[show,el("span",{text:t("map.bars","Bars")})]),field(t("bars.scaleMode","Height scale"),scaleMode),scaleControl,num(t("bars.cap","Max height (m)"),st.barCap,n=>st.barCap=n,1,5000,1),num(t("bars.size","Bar size (m)"),st.barSize,n=>st.barSize=n,5,500,1),el("label",{class:"ao-check"},[logarithmic,el("span",{text:t("bars.log","Logarithmic height")})])])]),
      el("div", { class: "ao-kpis" }, [
        kpi(t("kpi.before", "Total before"), fmt.int(b), st.originGroup || t("sel.all", "All")),
        kpi(t("kpi.after", "Total after"), fmt.int(a), st.originGroup || t("sel.all", "All")),
        kpi(t("kpi.delta", "Change"), fmt.signed(a - b), fmt.pct(pct)),
        kpi(t("kpi.cells", "OD cells"), fmt.int(Number(data.totals.n_cells ?? 0)), t("kpi.cellsSub", "{{n}} new, {{d}} dropped", { n: fmt.int(Number(data.totals.n_new_flow ?? 0)), d: fmt.int(Number(data.totals.n_dropped ?? 0)) })),
      ]),
      el("p", { class: "ao-hint", text: t("origin.hint", "Click a row to focus an origin group (KPIs, scatter); click again to clear. Trips are for the demand interval, summed over user classes.") }),
    );
    const modes: Array<[Mode, string]> = [
      ["side", t("mode.side", "Side by side")],
      ["before", t("mode.before", "Before")],
      ["after", t("mode.after", "After")],
      ["delta", t("mode.delta", "Delta")],
    ];
    out.append(
      el(
        "div",
        { class: "ao-tabs", attrs: { role: "group", "aria-label": t("mode", "Matrix view") } },
        modes.map(([m, label]) => {
          const bt = el("button", { class: "ao-tab", text: label, attrs: { type: "button", "aria-pressed": String(st.mode === m) } });
          bt.addEventListener("click", () => {
            st.mode = m;
            render();
          });
          return bt;
        }),
      ),
    );
    const og = t("axis.origin", "Origin group (rows) \\ destination group (columns)");
    const mats: HTMLElement[] =
      st.mode === "side"
        ? [heat(matrix, groups, (r) => r.before, "seq", `${t("mode.before", "Before")}: ${og}`), heat(matrix, groups, (r) => r.after, "seq", `${t("mode.after", "After")}: ${og}`)]
        : st.mode === "before"
          ? [heat(matrix, groups, (r) => r.before, "seq", og)]
          : st.mode === "after"
            ? [heat(matrix, groups, (r) => r.after, "seq", og)]
            : [heat(matrix, groups, (r) => r.delta, "div", `${t("mode.delta", "Delta")} (after - before): ${og}`)];
    out.append(el("div", { class: "ao-section" }, mats));
    out.append(
      section(t("tot.origin", "Totals per origin group (production)"), [groupTotals(matrix, "og", groups, t("axis.originShort", "Origin group"))]),
      section(t("tot.dest", "Totals per destination group (attraction)"), [groupTotals(matrix, "dg", groups, t("axis.destShort", "Destination group"))]),
    );
    const levels = select(
      [
        { value: "group", label: t("lvl.group", "Group x group") },
        { value: "zone-group", label: t("lvl.zg", "Origin centroid x destination group") },
        { value: "cell", label: t("lvl.cell", "OD cell (centroid x centroid)") },
      ],
      st.level,
      (v) => {
        st.level = v as ScatterLevel;
        void refresh();
      },
    );
    const x = pts.map((p) => p.before);
    const y = pts.map((p) => p.after);
    const n = Number(stats.n ?? 0);
    const slope = stats.slope === null ? null : Number(stats.slope);
    const icpt = stats.intercept === null ? null : Number(stats.intercept);
    const r2 = stats.r2 === null ? null : Number(stats.r2);
    out.append(
      section(
        t("sc.title", "Before vs after (aggregated cells)"),
        [
          field(t("sc.level", "Aggregation level"), levels),
          chartBox(
            scatterSvg(x, y, {
              label: t("sc.title", "Before vs after (aggregated cells)"),
              xTitle: t("sc.x", "trips before"),
              yTitle: t("sc.y", "trips after"),
              identityLine: true,
              trend: slope !== null && icpt !== null ? { slope, intercept: icpt } : null,
              radius: pts.length > 1000 ? 1.8 : 2.5,
            }),
          ),
          el("p", {
            class: "ao-hint",
            text: t("sc.note", "{{n}} aggregated cells in total; plotted: the {{p}} largest. Dashed: identity (after = before). Red: OLS fit over all {{n}} cells, slope {{s}}, R2 {{r}}.", {
              n: fmt.int(n),
              p: fmt.int(pts.length),
              s: fmt.num(slope, 3),
              r: fmt.num(r2, 3),
            }),
          }),
        ],
      ),
      el("p", { class: "ao-hint", text: t("timing", "Timings (ms): cells {{c}}, matrix {{m}}, scatter {{s}}.", { c: fmt.int(tm.cells), m: fmt.int(tm["q:matrix"]), s: fmt.int(tm["q:scatter"]) }) }),
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
      const origin = env.selection.origin.kind === "all" ? undefined : toSelection(env.selection.origin);
      st.originGroup = env.selection.origin.kind === "group" ? env.selection.origin.value : "";
      const matrix = (await ctl.q<Record<string, unknown>>(groupMatrixSql(), "matrix")).map(
        (r): MatrixRow => ({
          og: String(r.og),
          dg: String(r.dg),
          before: Number(r.before),
          after: Number(r.after),
          delta: Number(r.delta),
          deviation_ratio: r.deviation_ratio === null ? null : Number(r.deviation_ratio),
          n_cells: Number(r.n_cells),
        }),
      );
      const selected=(s:typeof env.selection.origin,r:Record<string,unknown>):boolean=>s.kind==="all"||(s.kind==="group"?String(r.grp)===s.value:String(r.id)===s.value.split(" - ")[0]);
      const hasScope=env.selection.origin.kind!=="all"||env.selection.destination.kind!=="all";
      const net = (await ctl.q<Record<string, unknown>>(centroidNetSql(), "ba-bars")).filter(r=>r.lon!==null&&r.lat!==null&&(!hasScope||selected(env.selection.origin,r)||selected(env.selection.destination,r)));
      const nodes = ctl.state.grouping ? [...new Map(net.map(r=>[String(r.grp),net.filter(x=>String(x.grp)===String(r.grp))])).values()].map((members)=>{
        const weight=(r:Record<string,unknown>)=>Math.max(1,Number(r.prod_before)+Number(r.prod_after)+Number(r.attr_before)+Number(r.attr_after));
        const total=members.reduce((s,r)=>s+weight(r),0);
        const sum=(key:string)=>members.reduce((s,r)=>s+Number(r[key]??0),0);
        return {id:String(members[0].grp),name:String(members[0].grp),lon:members.reduce((s,r)=>s+Number(r.lon)*weight(r),0)/total,lat:members.reduce((s,r)=>s+Number(r.lat)*weight(r),0)/total,prodBefore:sum("prod_before"),prodAfter:sum("prod_after"),attrBefore:sum("attr_before"),attrAfter:sum("attr_after")};
      }) : net.map(r=>({id:String(r.id),name:String(r.name??r.id),lon:Number(r.lon),lat:Number(r.lat),prodBefore:Number(r.prod_before),prodAfter:Number(r.prod_after),attrBefore:Number(r.attr_before),attrAfter:Number(r.attr_after)}));
      mapNodes=nodes;pushBars();
      const totals = (await ctl.q(totalsSql(origin), "totals"))[0] ?? {};
      const stats = (await ctl.q(scatterStatsSql(st.level, origin), "scatterStats"))[0] ?? {};
      const pts = (await ctl.q<Record<string, unknown>>(scatterPointsSql(st.level, SCATTER_POINTS, origin), "scatter")).map((p) => ({ label: String(p.label), before: Number(p.before), after: Number(p.after) }));
      ctl.state.timings["q:scatter"] = (ctl.state.timings["q:scatterStats"] ?? 0) + (ctl.state.timings["q:scatter"] ?? 0);
      if (my !== tok) return;
      data = { matrix, totals, pts, stats, grouping: ctl.state.grouping };
      render();
    } catch (e) {
      if (my === tok && out) {
        clear(out);
        out.append(el("p", { class: "ao-alert ao-bad", text: e instanceof Error ? e.message : String(e) }));
      }
    }
  };

  return {
    mount(h) {
      host = h;
      clear(host);
      out = el("div", { class: "ao-results" });
      host.append(out);
      if (data) render();
      else if (ctl.ready) void refresh();
    },
    onData() {
      if (st.originGroup && !ctl.state.groups.some((g) => g.name === st.originGroup)) st.originGroup = "";
      void refresh();
    },
    relocalize: render,
    getState: () => st,
    setState(s) {
      if (!s || typeof s !== "object") return;
      st = { ...DEFAULTS(), ...(s as Partial<BaState>), originGroup: env.selection.origin.kind === "group" ? env.selection.origin.value : "" };
      if (out) void refresh();
    },
    dispose() {
      tok++;
      overlay.setTiltForBars(false);
      host = out = null;
    },
  };
}
