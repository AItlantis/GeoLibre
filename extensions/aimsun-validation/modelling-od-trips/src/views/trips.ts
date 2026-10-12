/** aimsun-trips: OD desire lines + top pairs + straight-line trip-length histogram for one matrix (before or after). */
import { histogramSvg } from "../../../_shared/src/charts.ts";
import { selectionPredicate, selectionStatsSql, tripLengthSql, topPairsSql, type PairQuery } from "../../../_shared/src/sql/od-adapter.sql.ts";
import { boundsOf, describeSelection, linesToFc, radiusPx, widthPx, type FC, type LineRow } from "../_od/calc.ts";
import type { OdView, ViewEnv } from "../_od/plugin.ts";
import { allSel, selectorControl, toSelection, validSel, type SelState } from "../_od/selector.ts";
import { chartBox, clear, el, field, kpi, section, select, table } from "../_od/ui.ts";
import { aggregateGroups, animationPhase, archRibbon, barsGeoJson, type Zone } from "../_od/map-logic.ts";

export const TRIPS_OVERLAY = [
  { id: "centroids", source: "centroids", type: "circle" as const, paint: { "circle-opacity": 0.5, "circle-stroke-width": 0 } },
  { id: "lines", source: "lines", type: "line" as const },
  { id: "ends", source: "ends", type: "circle" as const },
  { id: "groups", source: "groups", type: "circle" as const },
  { id: "bars", source: "bars", type: "fill-extrusion" as const },
  { id: "3d-lines", source: "ribbons", type: "fill-extrusion" as const },
];

export interface TripsState {
  side: "before" | "after";
  origin: SelState;
  destination: SelState;
  topN: number;
  minTrips: number;
  intrazonal: boolean;
  binKm: number;
  detail: "centroids" | "groups";
  bars: boolean;
  lineStyle: "2d" | "3d";
  paused: boolean;
  barScale: number;
  barCap: number;
  barSize: number;
  barLog: boolean;
  barAuto: boolean;
  lineHeightScale: number;
  animationSpeed: number;
}

const DEFAULTS = (): TripsState => ({ side: "before", origin: allSel(), destination: allSel(), topN: 200, minTrips: 1, intrazonal: false, binKm: 2, detail: "groups", bars: false, lineStyle: "2d", paused: typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false, barScale: 3, barCap: 250, barSize: 24, barLog: false, barAuto: true, lineHeightScale:4, animationSpeed:0.25 });
export const MAX_LINES = 2000;

const ORIGIN_COLOR = "#e66100";
const DEST_COLOR = "#1c71d8";
const BOTH_COLOR = "#7e3fa8";
const LINE_COLOR = "#26547c";

interface PairRow extends LineRow {
  origin_group?: string | null;
  destination_group?: string | null;
  dist_km: number | null;
}

export function createTripsView(env: ViewEnv): OdView {
  const { ctl, overlay } = env;
  let st: TripsState = DEFAULTS();
  let host: HTMLElement | null = null;
  let out: HTMLElement | null = null;
  let tok = 0;
  let last: { pairs: PairRow[]; groupFlows: Array<{origin:string;destination:string;trips:number}>; memberFlows: Array<{origin:string;destination:string;trips:number}>; stats: Record<string, unknown> | null; hist: Array<Record<string, unknown>> | null; side: string; sel: string } | null = null;
  let centroidsDrawn = "";
  let raf: number | null = null;
  const stopAnimation=():void=>{if(raf!==null&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(raf);raf=null;overlay.setLayerOpacity("3d-lines",0.85);};
  const animate=():void=>{
    if(st.lineStyle!=="3d"||st.paused||typeof requestAnimationFrame!=="function"){stopAnimation();return;}
    let lastPaint=0;
    const frame=(now:number)=>{if(st.lineStyle!=="3d"||st.paused){raf=null;return;}if(now-lastPaint>=33){overlay.setLayerFlowPhase("3d-lines",animationPhase(now,st.animationSpeed,false));lastPaint=now;}raf=requestAnimationFrame(frame);};
    if(raf===null)raf=requestAnimationFrame(frame);
  };

  const query = (): PairQuery => ({
    side: st.side,
    origin: toSelection(env.selection.origin),
    destination: toSelection(env.selection.destination),
    excludeIntrazonal: !st.intrazonal,
    minTrips: st.minTrips,
  });

  const drawCentroids = (): void => {
    const key = `${ctl.state.run}`;
    if (key === centroidsDrawn) return;
    centroidsDrawn = key;
    const fc: FC = {
      type: "FeatureCollection",
      features: ctl.state.centroids
        .filter((c) => c.lon !== null && c.lat !== null)
        .map((c) => ({ type: "Feature" as const, geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { c: "#8a8f98", r: 2, tip: `${c.name} (${c.id})\n${c.grp}` } })),
    };
    overlay.set("centroids", fc);
  };

  const pushMap = (pairs: PairRow[], groupFlows: Array<{origin:string;destination:string;trips:number}> = [], memberFlows: Array<{origin:string;destination:string;trips:number}> = []): void => {
    overlay.setTiltForBars(st.bars);
    const grouped = st.detail === "groups" && !!ctl.state.grouping;
    overlay.setLayers([...(grouped ? ["groups"] : ["centroids"]), ...(st.lineStyle === "3d" ? ["3d-lines"] : ["lines"]), "ends", ...(st.bars ? ["bars"] : [])]);
    const max = Math.max(0,...(grouped?groupFlows.map(p=>p.trips):pairs.map(p=>p.trips)));
    const side = st.side === "before" ? env.t("side.before", "before") : env.t("side.after", "after");
    const zoneList: Zone[] = ctl.state.centroids.filter(c=>c.lon!==null&&c.lat!==null).map(c=>({id:c.id,name:c.name,group:c.grp,lon:c.lon!,lat:c.lat!}));
    const groupNodes=aggregateGroups(zoneList,memberFlows);
    const nodeByGroup=new Map(groupNodes.map(g=>[g.name,g]));
    const displayedPairs: PairRow[] = grouped ? groupFlows.map((r) => {
      const og=nodeByGroup.get(r.origin), dg=nodeByGroup.get(r.destination);
      return {origin:r.origin,destination:r.destination,origin_name:r.origin,destination_name:r.destination,trips:r.trips,o_lon:og?.lon??null,o_lat:og?.lat??null,d_lon:dg?.lon??null,d_lat:dg?.lat??null,dist_km:null};
    }) : pairs;
    const lines = linesToFc(
      st.lineStyle === "3d" ? [] : displayedPairs,
      () => LINE_COLOR,
      (r) => widthPx(r.trips, max),
      (r) =>
        `${r.origin_name ?? r.origin} (${r.origin}) → ${r.destination_name ?? r.destination} (${r.destination})\n${env.fmt.num(r.trips, 1)} ${env.t("trips", "trips")} (${side})\n${env.fmt.num((r as PairRow).dist_km, 1)} km ${env.t("straight", "straight-line")}`,
    );
    // endpoints: size by the trips of the shown lines through them
    const agg = new Map<string, { lon: number; lat: number; name: string; o: number; d: number }>();
    for (const p of pairs) {
      if (p.o_lon === null || p.d_lon === null || p.o_lat === null || p.d_lat === null) continue;
      const a = agg.get(p.origin) ?? { lon: p.o_lon, lat: p.o_lat, name: String(p.origin_name ?? ""), o: 0, d: 0 };
      a.o += p.trips;
      agg.set(p.origin, a);
      const b = agg.get(p.destination) ?? { lon: p.d_lon, lat: p.d_lat, name: String(p.destination_name ?? ""), o: 0, d: 0 };
      b.d += p.trips;
      agg.set(p.destination, b);
    }
    const maxEnd = Math.max(1, ...[...agg.values()].map((a) => Math.max(a.o, a.d)));
    const ends: FC = {
      type: "FeatureCollection",
      features: [...agg.entries()].map(([id, a]) => ({
        type: "Feature" as const,
        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        properties: {
          c: a.o && a.d ? BOTH_COLOR : a.o ? ORIGIN_COLOR : DEST_COLOR,
          r: radiusPx(Math.max(a.o, a.d), maxEnd, 3, 14),
          tip: `${a.name} (${id})\n${env.t("tip.out", "origin of {{n}} trips", { n: env.fmt.num(a.o, 1) })}\n${env.t("tip.in", "destination of {{n}} trips", { n: env.fmt.num(a.d, 1) })}`,
        },
      })),
    };
    overlay.set("lines", lines);
    overlay.set("ends", ends);
    const nodes=grouped ? groupNodes.map(g=>({id:g.id,name:g.name,lon:g.lon,lat:g.lat,trips:g.trips})) : [...agg.entries()].map(([id,a])=>({id,name:a.name,lon:a.lon,lat:a.lat,trips:a.o+a.d}));
    overlay.set("groups",{type:"FeatureCollection",features:grouped?nodes.map(n=>({type:"Feature" as const,geometry:{type:"Point",coordinates:[n.lon,n.lat]},properties:{c:"#596a7b",r:radiusPx(n.trips,Math.max(1,...nodes.map(x=>x.trips)),6,22),tip:`${n.name}\n${env.fmt.int(n.trips)} trips`} })):[]});
    overlay.set("centroids",{type:"FeatureCollection",features:grouped?[]:nodes.map(n=>({type:"Feature" as const,geometry:{type:"Point",coordinates:[n.lon,n.lat]},properties:{c:"#8a8f98",r:2,tip:`${n.name} (${n.id})`} }))});
    const barRows=nodes.slice(0,1500).map(n=>({id:n.id,name:n.name,lon:n.lon,lat:n.lat,origins:grouped?groupFlows.filter(f=>f.origin===n.id).reduce((s,f)=>s+f.trips,0):(agg.get(n.id)?.o??0),destinations:grouped?groupFlows.filter(f=>f.destination===n.id).reduce((s,f)=>s+f.trips,0):(agg.get(n.id)?.d??0)}));
    const maxTrips=Math.max(1,...barRows.flatMap(r=>[r.origins,r.destinations]));
    const effectiveScale=st.barAuto?Math.max(0.1,80/(maxTrips/1000)):st.barScale;
    overlay.set("bars",st.bars?barsGeoJson(barRows,effectiveScale,st.barCap,st.barLog,st.barSize):{type:"FeatureCollection",features:[]});
    const ribbons = displayedPairs.slice(0,500).flatMap(p=>p.o_lon===null||p.o_lat===null||p.d_lon===null||p.d_lat===null?[]:archRibbon([p.o_lon,p.o_lat],[p.d_lon,p.d_lat],Math.min(120,Math.hypot((p.o_lon-p.d_lon)*Math.cos(((p.o_lat+p.d_lat)/2)*Math.PI/180),p.o_lat-p.d_lat)*111*st.lineHeightScale),50,12).features.map(f=>({...f,properties:{...f.properties,c:LINE_COLOR,w:widthPx(p.trips,max),tip:`${p.origin} → ${p.destination}: ${env.fmt.num(p.trips,1)} trips`}})));
    overlay.set("ribbons",{type:"FeatureCollection",features:st.lineStyle==="3d"?ribbons:[]});
    animate();
    if (boundsOf(lines)) overlay.fit();
  };

  const renderResults = (): void => {
    if (!out) return;
    clear(out);
    if (!last) return;
    const { t, fmt } = env;
    const { pairs, stats, hist } = last;
    const kp = el("div", { class: "ao-kpis" }, [
      kpi(t("kpi.trips", "Trips in selection"), fmt.int(Number(stats?.trips ?? 0))),
      kpi(t("kpi.cells", "OD cells"), fmt.int(Number(stats?.n_cells ?? 0)), t("kpi.cellsSub", "{{o}} origins x {{d}} destinations", { o: fmt.int(Number(stats?.n_origins ?? 0)), d: fmt.int(Number(stats?.n_destinations ?? 0)) })),
      kpi(t("kpi.mean", "Mean distance"), `${fmt.num(stats?.mean_km === null || stats?.mean_km === undefined ? null : Number(stats.mean_km), 1)} km`, t("kpi.meanSub", "trip-weighted, straight-line")),
      kpi(t("kpi.shown", "Lines drawn"), fmt.int(pairs.length), t("kpi.shownSub", "{{p}} of selection trips", { p: fmt.pct(Number(stats?.trips) > 0 ? pairs.reduce((s, p) => s + p.trips, 0) / Number(stats?.trips) : null, 0) })),
    ]);
    const legend = el("div", { class: "ao-legend" }, [
      el("span", { text: t("legend.origin", "origin") }),
      el("span", { text: "●", attrs: { style: `color:${ORIGIN_COLOR}` } }),
      el("span", { text: t("legend.dest", "destination") }),
      el("span", { text: "●", attrs: { style: `color:${DEST_COLOR}` } }),
      el("span", { text: t("legend.width", "line width ~ trips") }),
    ]);
    const tbl = table<PairRow>(
      [
        { label: t("col.origin", "Origin"), value: (r) => `${r.origin}${r.origin_name ? ` ${r.origin_name}` : ""}` },
        { label: t("col.dest", "Destination"), value: (r) => `${r.destination}${r.destination_name ? ` ${r.destination_name}` : ""}` },
        { label: t("col.trips", "Trips"), value: (r) => fmt.num(r.trips, 1), num: true },
        { label: t("col.km", "km"), value: (r) => fmt.num(r.dist_km, 1), num: true },
      ],
      pairs,
      (r) => {
        if (r.o_lon !== null && r.o_lat !== null && r.d_lon !== null && r.d_lat !== null) overlay.zoomTo((r.o_lon + r.d_lon) / 2, (r.o_lat + r.d_lat) / 2, 11);
      },
      MAX_LINES,
    );
    const bins = (hist ?? []).map((h) => ({ start: Number(h.bin_start_km), end: Number(h.bin_end_km), value: Number(h.trips) }));
    out.append(
      kp,
      section(t("map.title", "Desire lines on the map"), [legend], t("map.hint", "Straight lines between centroids, not routes. Grey dots: all centroids.")),
      section(t("top.title", "Top OD pairs"), [tbl]),
      section(
        t("hist.title", "Trip-length distribution"),
        [
          chartBox(
            histogramSvg(bins, {
              label: t("hist.title", "Trip-length distribution"),
              xTitle: t("hist.x", "straight-line centroid distance (km), not route length"),
              yTitle: t("hist.y", "trips"),
            }),
          ),
        ],
        t("hist.hint", "Trip-weighted histogram of the haversine distance between origin and destination centroids ({{w}} km bins). It is not the length of the route driven.", { w: st.binKm }),
      ),
    );
  };

  const refresh = async (): Promise<void> => {
    if (!ctl.ready) return;
    const my = ++tok;
    const { t } = env;
    if (out) {
      clear(out);
      out.append(el("p", { class: "ao-alert", text: t("busy", "Querying…") }));
    }
    try {
      drawCentroids();
      const q = query();
      const pairs = (await ctl.q<PairRow>(topPairsSql({ ...q, limit: Math.min(MAX_LINES, Math.max(1, st.topN)) }), "pairs")).map((p) => ({
        ...p,
        trips: Number(p.trips),
        origin: String(p.origin),
        destination: String(p.destination),
        o_lon: p.o_lon === null ? null : Number(p.o_lon),
        o_lat: p.o_lat === null ? null : Number(p.o_lat),
        d_lon: p.d_lon === null ? null : Number(p.d_lon),
        d_lat: p.d_lat === null ? null : Number(p.d_lat),
        dist_km: p.dist_km === null ? null : Number(p.dist_km),
      }));
      let groupFlows: Array<{origin:string;destination:string;trips:number}> = [];
      let memberFlows: Array<{origin:string;destination:string;trips:number}> = [];
      if(st.detail==="groups"&&ctl.state.grouping){
        const table=st.side==="before"?"v_od_before_norm":"v_od_after_norm";
        const minTrips=q.minTrips??0;
        const where=[selectionPredicate(q.origin!,"t.origin"),selectionPredicate(q.destination!,"t.destination"),q.excludeIntrazonal?"t.origin <> t.destination":"",minTrips>0?`t.trips >= ${minTrips}`:""].filter(Boolean).join(" AND ");
        groupFlows=(await ctl.q<Record<string,unknown>>(`SELECT COALESCE(co.grp,'(none)') AS origin,COALESCE(cd.grp,'(none)') AS destination,SUM(t.trips) AS trips FROM ${table} t JOIN v_centroids_norm co ON co.id=t.origin JOIN v_centroids_norm cd ON cd.id=t.destination ${where?`WHERE ${where}`:""} GROUP BY 1,2 ORDER BY 3 DESC` ,"groupLines")).map(r=>({origin:String(r.origin),destination:String(r.destination),trips:Number(r.trips)}));
        const volWhere=[selectionPredicate(q.origin!,"t.origin"),selectionPredicate(q.destination!,"t.destination"),q.excludeIntrazonal?"t.origin <> t.destination":"",minTrips>0?`t.trips >= ${minTrips}`:""].filter(Boolean).join(" AND ");
        const volumes=await ctl.q<Record<string,unknown>>(`SELECT CAST(id AS VARCHAR) AS id,SUM(trips) AS trips FROM (SELECT t.origin AS id,t.trips FROM ${table} t ${volWhere?`WHERE ${volWhere}`:""} UNION ALL SELECT t.destination AS id,t.trips FROM ${table} t ${volWhere?`WHERE ${volWhere}`:""}) f GROUP BY id`,"groupCentroidVolumes");
        memberFlows=volumes.map(r=>({origin:String(r.id),destination:String(r.id),trips:Number(r.trips)/2}));
      }
      if (my !== tok) return;
      last = { pairs, groupFlows, memberFlows, stats: null, hist: null, side: st.side, sel: "" };
      pushMap(pairs,groupFlows,memberFlows);
      renderResults();
      const stats = (await ctl.q(selectionStatsSql(q), "stats"))[0] ?? null;
      if (my !== tok) return;
      const hist = await ctl.q(tripLengthSql({ ...q, minTrips: 0, binKm: st.binKm }), "hist");
      if (my !== tok) return;
      last = { pairs, groupFlows, memberFlows, stats, hist, side: st.side, sel: "" };
      renderResults();
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
    if (!ctl.state.availableSides.includes(st.side)) st.side = ctl.state.availableSides[0] ?? "before";
    env.selection.origin = validSel(env, env.selection.origin);
    env.selection.destination = validSel(env, env.selection.destination);
    st.origin = env.selection.origin;
    st.destination = env.selection.destination;
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
    const grid = el("div", { class: "ao-grid" }, [
      field(
        t("matrix", "Matrix"),
        select(
          ctl.state.availableSides.map((side) => ({ value: side, label: side === "before" ? t("side.beforeCap", "Before adjustment") : t("side.afterCap", "After adjustment") })),
          st.side,
          (v) => {
            st.side = v as TripsState["side"];
            schedule();
          },
        ),
      ),
      num(t("topn", "Top-N lines (max {{m}})", { m: MAX_LINES }), st.topN, 1, MAX_LINES, 10, (n) => (st.topN = Math.round(n))),
      selectorControl(env, t("origin", "Origin"), st.origin, (s) => {
        st.origin = env.selection.origin = s;
        schedule();
      }),
      selectorControl(env, t("dest", "Destination"), st.destination, (s) => {
        st.destination = env.selection.destination = s;
        schedule();
      }),
      num(t("min", "Min trips per pair"), st.minTrips, 0, 1e6, 0.5, (n) => (st.minTrips = n)),
      num(t("bin", "Histogram bin (km)"), st.binKm, 0.5, 50, 0.5, (n) => (st.binKm = n)),
    ]);
    const details=select([{value:"centroids",label:t("map.centroids","Centroids")},{value:"groups",label:t("map.groups","Groups (aggregated)")}],st.detail,v=>{st.detail=v as TripsState["detail"];schedule();});
    const detailField=field(t("map.detail","Map detail"),details);
    const chk = el("input", { attrs: { type: "checkbox" } });
    chk.checked = st.intrazonal;
    chk.addEventListener("change", () => {
      st.intrazonal = chk.checked;
      schedule();
    });
    const bars=el("input",{attrs:{type:"checkbox"}});bars.checked=st.bars;bars.addEventListener("change",()=>{st.bars=bars.checked;schedule();});
    const lineStyle=el("div",{class:"ao-tabs",attrs:{role:"group","aria-label":t("lines.style","Desire line style")}},["2d","3d"].map(v=>{const b=el("button",{class:"ao-tab",text:v.toUpperCase(),attrs:{type:"button","aria-pressed":String(st.lineStyle===v)}});b.addEventListener("click",()=>{st.lineStyle=v as TripsState["lineStyle"];schedule();});return b;}));
    const pause=el("input",{attrs:{type:"checkbox"}});pause.checked=st.paused;pause.addEventListener("change",()=>{st.paused=pause.checked;animate();});
    const barScaleControl=num(t("bars.scale","Height scale (m per 1000 trips)"),st.barScale,0.1,100,0.1,n=>st.barScale=n);barScaleControl.querySelector("input")!.disabled=st.barAuto;
    const barAuto=select([{value:"auto",label:t("bars.auto","Auto")},{value:"manual",label:t("bars.manual","Manual")}],st.barAuto?"auto":"manual",v=>{st.barAuto=v==="auto";schedule();});
    const barControls=el("div",{class:"ao-grid"},[field(t("bars.scaleMode","Height scale"),barAuto),barScaleControl,num(t("bars.cap","Max height (m)"),st.barCap,1,5000,1,n=>st.barCap=n),num(t("bars.size","Bar size (m)"),st.barSize,5,500,5,n=>st.barSize=n)]);
    const log=el("input",{attrs:{type:"checkbox"}});log.checked=st.barLog;log.addEventListener("change",()=>{st.barLog=log.checked;schedule();});
    return el("div", { class: "ao-section" }, [grid,el("div",{class:"ao-map-mini"},[detailField,lineStyle,el("label",{class:"ao-check"},[pause,el("span",{text:t("lines.pause","Pause flow animation")})]),el("label",{class:"ao-check"},[bars,el("span",{text:t("map.bars","Bars")})])]),st.lineStyle==="3d"?el("div",{class:"ao-grid"},[num(t("lines.height","Arch height (m per km)"),st.lineHeightScale,0.1,100,0.1,n=>st.lineHeightScale=n),num(t("lines.speed","Animation speed"),st.animationSpeed,0.01,5,0.01,n=>st.animationSpeed=n)]):null,st.bars?barControls:null,st.bars?el("label",{class:"ao-check"},[log,el("span",{text:t("bars.log","Logarithmic height")})]):null, el("label", { class: "ao-check" }, [chk, el("span", { text: t("intra", "Include intrazonal trips (origin = destination)") })])]);
  };

  return {
    mount(h) {
      host = h;
      clear(host);
      out = el("div", { class: "ao-results" });
      host.append(controls(), out);
      if (last) renderResults();
      else if (ctl.ready) void refresh();
    },
    onData() {
      if (host && out) {
        const c = host.firstElementChild;
        c?.replaceWith(controls());
      }
      centroidsDrawn = "";
      void refresh();
    },
    relocalize() {
      if (host && out) {
        host.firstElementChild?.replaceWith(controls());
        renderResults();
      }
    },
    getState: () => st,
    setState(s) {
      if (!s || typeof s !== "object") return;
      const x = s as Partial<TripsState>;
      st = { ...DEFAULTS(), ...x, origin: { ...env.selection.origin }, destination: { ...env.selection.destination } };
      if (host && out) {
        host.firstElementChild?.replaceWith(controls());
        void refresh();
      }
    },
    onPanelClose() { stopAnimation(); },
    onPanelOpen() { animate(); },
    dispose() {
      tok++;
      stopAnimation();
      overlay.setTiltForBars(false);
      if (timer) clearTimeout(timer);
      host = out = null;
    },
  };
}

export { describeSelection };
