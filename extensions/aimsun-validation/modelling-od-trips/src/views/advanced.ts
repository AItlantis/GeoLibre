/** Additional bounded, DOM-only OD analytics views. */
import { groupMatrixSql, selectionPredicate, selectionStatsSql, totalsSql, tripLengthSql, type PairQuery } from "../../../_shared/src/sql/od-adapter.sql.ts";
import { balanceRows, cumulativeBins, distributionStats, flowMatrix, type Bin } from "../analytics.ts";
import type { OdView, ViewEnv } from "../_od/plugin.ts";
import { divergingHex } from "../_od/calc.ts";
import { barsGeoJson } from "../_od/map-logic.ts";
import { checksPanel } from "../_od/checks.ts";
import { clear, el, field, kpi, section, select, table } from "../_od/ui.ts";

export type AdvancedMode = "comparison" | "balance" | "length" | "matrix";

export function createAdvancedView(mode: AdvancedMode, env: ViewEnv): OdView {
  let host: HTMLElement | null = null, output: HTMLElement | null = null, epoch = 0;
  let side = env.ctl.state.availableSides.includes("after") ? "after" : "before";
  let binWidth = 1, maxKm = 100, cumulative = false, matrixMetric = "after", limit = 30;
  let comparisonBusy = false;
  let comparisonSignature = "";
  let comparisonRows: Array<{run:string;trips:number;cells:number;mean:number|null;intra:number|null;top10:number|null;groups:Array<{og:string;dg:string;delta:number}>;pairs:Array<{origin:string;destination:string;trips:number}>}> = [];
  let baselineRun = "", compareRun = "";
  let comparisonSide:"before"|"after"="after";
  let comparisonLevel="pair", comparisonTop="gains";
  let balanceBars=false;
  const render = async (): Promise<void> => {
    if (!output || !env.ctl.ready) return;
    const token = ++epoch, ctl = env.ctl, { t, fmt } = env;
    clear(output); output.append(el("p", { class: "ao-alert", text: t("advanced.loading", "Calculating aggregated results…") }));
    try {
      if (token !== epoch) return;
      clear(output);
      if (mode === "balance") {
        const selected = env.ctl.state.availableSides.includes(side as "before" | "after") ? side : env.ctl.state.availableSides[0] ?? "before";
        const raw = `v_od_${selected}_norm`;
        const op=selectionPredicate(env.selection.origin.kind==="all"?{kind:"all"}:env.selection.origin.kind==="centroid"?{kind:"centroid",value:env.selection.origin.value.split(" - ")[0]}:{kind:"group",value:env.selection.origin.value},"origin");
        const dp=selectionPredicate(env.selection.destination.kind==="all"?{kind:"all"}:env.selection.destination.kind==="centroid"?{kind:"centroid",value:env.selection.destination.value.split(" - ")[0]}:{kind:"group",value:env.selection.destination.value},"destination");
        const rows = await ctl.q<Record<string, unknown>>(`WITH x AS (SELECT origin AS id,trips AS p,0.0 AS a FROM ${raw}${op?` WHERE ${op}`:""} UNION ALL SELECT destination AS id,0.0 AS p,trips AS a FROM ${raw}${dp?` WHERE ${dp}`:""}) SELECT COALESCE(c.grp,'(none)') AS id,SUM(x.p) AS productions,SUM(x.a) AS attractions,AVG(c.lon) lon,AVG(c.lat) lat FROM x LEFT JOIN v_centroids_norm c ON c.id=x.id GROUP BY 1 ORDER BY 1`, "balance");
        const grouped = balanceRows(rows.map(r => ({ id: String(r.id), productions: Number(r.productions), attractions: Number(r.attractions) })));
        const coords=new Map(rows.map(r=>[String(r.id),{lon:Number(r.lon),lat:Number(r.lat)}]));
        env.overlay.setLayers(balanceBars?["net","bars"]:["net"]);env.overlay.setTiltForBars(balanceBars);env.overlay.set("net",{type:"FeatureCollection",features:grouped.flatMap(r=>{const c=coords.get(r.id);return c&&Number.isFinite(c.lon)&&Number.isFinite(c.lat)?[{type:"Feature" as const,geometry:{type:"Point" as const,coordinates:[c.lon,c.lat]},properties:{c:divergingHex(r.net,Math.max(1,...grouped.map(x=>Math.abs(x.net)))),r:Math.min(24,4+Math.sqrt(Math.abs(r.net))),tip:`${r.id}\nProductions: ${fmt.int(r.productions)}\nAttractions: ${fmt.int(r.attractions)}\nNet: ${fmt.signed(r.net)}`}}]:[]})});
        const barRows=grouped.flatMap(r=>{const c=coords.get(r.id);return c&&Number.isFinite(c.lon)&&Number.isFinite(c.lat)?[{id:r.id,name:r.id,lon:c.lon,lat:c.lat,origins:r.productions,destinations:r.attractions}]:[]});const maxBar=Math.max(1,...barRows.flatMap(r=>[r.origins,r.destinations]));env.overlay.set("bars",balanceBars?barsGeoJson(barRows,Math.max(.1,80/(maxBar/1000)),250,false,18):{type:"FeatureCollection",features:[]});
        const totalP = grouped.reduce((s, r) => s + r.productions, 0), totalA = grouped.reduce((s, r) => s + r.attractions, 0);
        const tabs = el("div", { class: "ao-tabs", attrs: { role: "group", "aria-label": t("balance.rank", "Balance ranking") } });
        const target = el("div");
        const lists: Array<[string, (a: typeof grouped) => typeof grouped]> = [["Top producers", a => [...a].sort((x,y)=>y.productions-x.productions)], ["Top attractors", a => [...a].sort((x,y)=>y.attractions-x.attractions)], ["Most unbalanced", a => [...a].sort((x,y)=>Math.abs(y.net)-Math.abs(x.net))]];
        const draw = (idx: number): void => { clear(target); const chosen = lists[idx][1](grouped).slice(0, 100); target.append(table([{label:t("balance.group","Group"),value:r=>r.id},{label:t("balance.prod","Productions"),value:r=>fmt.int(r.productions),num:true},{label:t("balance.attr","Attractions"),value:r=>fmt.int(r.attractions),num:true},{label:t("balance.net","P − A"),value:r=>fmt.signed(r.net),num:true},{label:t("balance.ratio","P/A"),value:r=>r.ratio===null?"∞":fmt.num(r.ratio,2),num:true}],chosen)); };
        lists.forEach(([label],i)=>{const b=el("button",{class:"ao-tab",text:t(`balance.tab${i}`,label),attrs:{type:"button","aria-pressed":String(i===0)}});b.addEventListener("click",()=>{tabs.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed","false"));b.setAttribute("aria-pressed","true");draw(i);});tabs.append(b);}); draw(0);
        const barToggle=el("input",{attrs:{type:"checkbox"}});barToggle.checked=balanceBars;barToggle.addEventListener("change",()=>{balanceBars=barToggle.checked;void render();});
        const scatter=balanceScatter(grouped,t("balance.scatter","Productions vs attractions"));
        const ratioHist=balanceRatioHistogram(grouped,t("balance.ratioHist","P/A ratio distribution"));
        output.append(section(t("balance.title","Generation vs attraction"),[field(t("balance.side","Matrix"),select(ctl.state.availableSides.map(v=>({value:v,label:v})),selected,v=>{side=v;void render();})),el("label",{class:"ao-check"},[barToggle,el("span",{text:t("balance.bars","Show P/A bars")})]),el("div",{class:"ao-kpis"},[kpi(t("balance.totalP","Total productions"),fmt.int(totalP)),kpi(t("balance.totalA","Total attractions"),fmt.int(totalA)),kpi(t("balance.check","P = A"),Math.abs(totalP-totalA)<=.5?t("checks.pass","Pass"):t("checks.fail","Fail"),fmt.signed(totalP-totalA))]),tabs,target,scatter,ratioHist]));
      } else if (mode === "length") {
        const sides = ctl.state.availableSides.length > 1 ? ctl.state.availableSides : [ctl.state.availableSides[0] ?? "before"];
        const binsBySide = new Map<string, Bin[]>();
        for (const s of sides) {
          const q: PairQuery = { side: s as "before" | "after", excludeIntrazonal: true, origin: env.selection.origin.kind === "all" ? undefined : {kind:env.selection.origin.kind,value:env.selection.origin.value}, destination: env.selection.destination.kind === "all" ? undefined : {kind:env.selection.destination.kind,value:env.selection.destination.value} };
          const rows = await ctl.q<Record<string, unknown>>(tripLengthSql({ ...q, binKm: binWidth }), `length-${s}`);
          binsBySide.set(s, rows.map(r=>({start:Number(r.bin_start_km),end:Number(r.bin_end_km),trips:Number(r.trips)})));
        }
        const stats = [...binsBySide].map(([s,b])=>[s,distributionStats(b)] as const);
        const controls=el("div",{class:"ao-grid"},[field(t("length.bin","Bin width (km)"),numberInput(binWidth,.25,20,v=>{binWidth=v;void render();})),field(t("length.max","Maximum distance (km)"),numberInput(maxKm,1,1000,v=>{maxKm=v;void render();}))]);
        const toggle=el("div",{class:"ao-tabs",attrs:{role:"group","aria-label":t("length.chart","Distribution")}});[[false,"Histogram"],[true,"Cumulative"]].forEach(([isCum,label])=>{const b=el("button",{class:"ao-tab",text:t(`length.${isCum?"cumulative":"histogram"}`,String(label)),attrs:{type:"button","aria-pressed":String(cumulative===isCum)}});b.addEventListener("click",()=>{cumulative=Boolean(isCum);void render();});toggle.append(b);});
        const chartRows: Array<{bin:string;before:string;after:string}> = [];
        const maxBins=Math.ceil(maxKm/binWidth)+1;
        for(let i=0;i<maxBins;i++){const start=i*binWidth,end=start+binWidth;chartRows.push({bin:i===maxBins-1?`≥ ${fmt.num(maxKm,1)} km`:`${fmt.num(start,1)}–${fmt.num(end,1)} km`,before:"",after:""});}
        const rawBins=new Map<string,Map<number,number>>();for(const [s,bins] of binsBySide){const m=new Map<number,number>();for(const b of bins){const i=Math.min(maxBins-1,Math.floor(b.start/binWidth));m.set(i,(m.get(i)??0)+b.trips);}rawBins.set(s,m);}
        const totals=Object.fromEntries([...rawBins].map(([s,m])=>[s,[...m.values()].reduce((a,b)=>a+b,0)]));const cumulativeBySide=new Map<string,number>();
        const chart=el("div",{class:"ao-length-chart"});for(let i=0;i<maxBins;i++){const values=[...rawBins].map(([s,m])=>{const v=m.get(i)??0;if(cumulative)cumulativeBySide.set(s,(cumulativeBySide.get(s)??0)+v);return{s,value:cumulative?(totals[s]?cumulativeBySide.get(s)!/totals[s]:0):v};});const scale=cumulative?1:Math.max(1,...[...rawBins.values()].flatMap(m=>[...m.values()]));const row=el("div",{class:"ao-length-row"},[el("span",{class:"ao-length-label",text:chartRows[i].bin}),el("span",{class:"ao-length-track"},values.map(x=>el("span",{class:`ao-length-bar ao-length-${x.s}`,attrs:{style:`inline-size:${Math.max(0,Math.min(100,x.value/scale*100))}%`}})))]);chart.append(row);}
        for(const [s,bins] of rawBins){const values=cumulative?cumulativeBins(binsBySide.get(s)??[]):binsBySide.get(s)??[];for(const b of values){const i=Math.min(maxBins-1,Math.floor(b.start/binWidth));if(chartRows[i])chartRows[i][s==="before"?"before":"after"]=cumulative?fmt.pct(b.trips,1):`${fmt.int(b.trips)} trips`;}}
        const beforeStats=stats.find(([s])=>s==="before")?.[1],afterStats=stats.find(([s])=>s==="after")?.[1];
        const statCards=stats.map(([s,x])=>kpi(String(s),`${fmt.num(x.mean,1)} km`,`median ${fmt.num(x.median,1)} km · p90 ${fmt.num(x.p90,1)} km · under 5 km ${fmt.pct(x.under5Share,1)}`));
        if(beforeStats&&afterStats)statCards.push(kpi(t("length.delta","After − before mean"),`${fmt.signed((afterStats.mean??0)-(beforeStats.mean??0),1)} km`,`under 5 km ${fmt.signed(((afterStats.under5Share??0)-(beforeStats.under5Share??0))*100,1)} percentage points`));
        output.append(section(t("length.title","Trip length distribution"),[controls,toggle,el("p",{class:"ao-hint",text:t("length.note","Trip weighted, haversine straight-line distance, not route length. Intrazonal trips excluded; values beyond the maximum are combined in the final bin.")}),el("div",{class:"ao-kpis"},statCards),chart,table([{label:t("length.distance","Distance bin"),value:r=>r.bin},{label:t("side.before","Before"),value:r=>r.before,num:true},{label:t("side.after","After"),value:r=>r.after,num:true}],chartRows,undefined,1000)]));
      } else if (mode === "matrix") {
        await ctl.ensureCells(); if(token!==epoch)return;
        const available=ctl.state.availableSides, baseSide=available[0]??"before";
        const rawRows=await ctl.q<Record<string,unknown>>(groupMatrixSql(),"flow-matrix");
        const rows=rawRows.map(r=>({origin:String(r.og),destination:String(r.dg),before:Number(r.before),after:Number(r.after)}));
        if(!available.includes("after")) matrixMetric=baseSide;
        const compact=flowMatrix(rows,limit); const value=(r:typeof compact.rows[number]):number=>matrixMetric==="before"?r.before:matrixMetric==="delta"?r.delta:matrixMetric==="deltaPct"?(r.deltaPct??0):r.after;
        const groups=compact.groups, byKey=new Map(compact.rows.map(r=>[`${r.origin}\0${r.destination}`,r])), maxValue=Math.max(1,...compact.rows.map(r=>Math.abs(value(r))));
        const head=el("tr",{},[el("th"),...groups.map(g=>el("th",{text:g,class:"ao-num"})),el("th",{text:t("total","Total"),class:"ao-num"})]);
        const body=groups.map(o=>{let sum=0;const tr=el("tr");tr.append(el("td",{text:o,class:"ao-rowhead"}));for(const d of groups){const r=byKey.get(`${o}\0${d}`),v=r?value(r):0;sum+=v;const b=el("button",{class:"ao-matrix-cell",text:fmt.num(v,1),attrs:{type:"button","aria-label":`${o} to ${d}: ${fmt.num(v,1)}`,style:matrixMetric==="delta"||matrixMetric==="deltaPct"?`background:${divergingHex(v,maxValue)}`:`background:color-mix(in srgb, var(--ao-primary) ${Math.round(Math.sqrt(Math.abs(v)/maxValue)*65)}%, transparent)`}});b.addEventListener("click",()=>{env.selection.origin=o==="Other"?{kind:"all",value:""}:{kind:"group",value:o};env.selection.destination=d==="Other"?{kind:"all",value:""}:{kind:"group",value:d};const origin=ctl.state.centroids.filter(c=>c.grp===o&&c.lon!==null&&c.lat!==null),dest=ctl.state.centroids.filter(c=>c.grp===d&&c.lon!==null&&c.lat!==null);const center=(z:typeof origin)=>z.length?[z.reduce((s,c)=>s+c.lon!,0)/z.length,z.reduce((s,c)=>s+c.lat!,0)/z.length] as [number,number]:null;const p=center(origin),q=center(dest);env.overlay.setLayers(["diff-lines"]);env.overlay.set("lines",{type:"FeatureCollection",features:p&&q?[{type:"Feature",geometry:{type:"LineString",coordinates:[p,q]},properties:{c:divergingHex(v,maxValue),w:Math.max(1,Math.sqrt(Math.abs(v))/10),tip:`${o} → ${d}: ${fmt.num(v,1)}`}}]:[]});void render();});tr.append(el("td",{class:"ao-num"},[b]));}tr.append(el("td",{class:"ao-num ao-rowhead",text:fmt.num(sum,1)}));return tr;});
        const sums=groups.map(g=>groups.reduce((s,o)=>s+value(byKey.get(`${o}\0${g}`)??{origin:o,destination:g,before:0,after:0,delta:0,deltaPct:null,trips:0}),0));
        const foot=el("tr",{},[el("td",{text:t("total","Total"),class:"ao-rowhead"}),...sums.map(v=>el("td",{text:fmt.num(v,1),class:"ao-num ao-rowhead"})),el("td")]);
        const metrics=available.length>1?["before","after","delta","deltaPct"]:[baseSide];
        output.append(checksPanel(ctl,t,(v)=>fmt.int(v)),section(t("matrix.title","Flow matrix by group"),[el("div",{class:"ao-grid"},[field(t("matrix.metric","Value"),select(metrics.map(v=>({value:v,label:v==="deltaPct"?"Delta %":v})),matrixMetric,v=>{matrixMetric=v;void render();})),field(t("matrix.limit","Largest groups"),numberInput(limit,3,30,v=>{limit=Math.round(v);void render();}))]),el("p",{class:"ao-hint",attrs:{"data-testid":"flow-selection"},text:`${env.selection.origin.kind==="all"?"All origins":env.selection.origin.value} → ${env.selection.destination.kind==="all"?"all destinations":env.selection.destination.value}`}),el("p",{class:"ao-hint",text:t("matrix.scope","Select a cell to scope the origin and destination groups. Use Tab and Enter to activate cells.")}),el("div",{class:"ao-table-wrap"},[el("table",{class:"ao-table"},[el("thead",{},[head]),el("tbody",{},[...body,foot])])]) ]));
      } else {
        const signature=ctl.state.runs.join("\0");if(signature!==comparisonSignature){comparisonRows=[];comparisonSignature=signature;}
        if(ctl.state.runs.length<2){output.append(section(t("comparison.title","Run comparison"),[el("p",{class:"ao-alert ao-warn",text:t("comparison.disabled","Comparison requires at least two package runs with an after matrix.")})]));return;}
        if(!comparisonRows.length&&!comparisonBusy){
          comparisonBusy=true; const original=ctl.state.run??ctl.state.runs[0]; const gathered=[] as typeof comparisonRows;
          try {
            for(const run of ctl.state.runs){
              if(token!==epoch)break;
              await ctl.selectRun(run); if(token!==epoch)break; if(!ctl.ready||!ctl.state.availableSides.length)continue;
              const chosen=ctl.state.availableSides.includes(comparisonSide)?comparisonSide:ctl.state.availableSides.includes("after")?"after":"before";
              await ctl.ensureCells(); if(token!==epoch)break;
              const total=(await ctl.q<Record<string,unknown>>(totalsSql(),`compare-${run}`))[0]??{};
              const tableName=`v_od_${chosen}_norm`;
              const extra=(await ctl.q<Record<string,unknown>>(`WITH totals AS (SELECT SUM(trips) total,SUM(CASE WHEN origin=destination THEN trips ELSE 0 END) intrazonal FROM ${tableName}),top10 AS (SELECT SUM(trips) trips FROM (SELECT trips FROM ${tableName} ORDER BY trips DESC LIMIT 10)) SELECT intrazonal/NULLIF(total,0) intra,top10.trips/NULLIF(total,0) top10 FROM totals CROSS JOIN top10`, `compare-extra-${run}`))[0]??{};
              const groups=(await ctl.q<Record<string,unknown>>(`SELECT COALESCE(co.grp,'(none)') og,COALESCE(cd.grp,'(none)') dg,SUM(t.trips) delta FROM ${tableName} t LEFT JOIN v_centroids_norm co ON co.id=t.origin LEFT JOIN v_centroids_norm cd ON cd.id=t.destination GROUP BY 1,2`,`compare-groups-${run}`)).map(g=>({og:String(g.og),dg:String(g.dg),delta:Number(g.delta)}));
              const pairs=(await ctl.q<Record<string,unknown>>(`SELECT CAST(origin AS VARCHAR) origin,CAST(destination AS VARCHAR) destination,trips FROM ${tableName} ORDER BY trips DESC LIMIT 500`,`compare-pairs-${run}`)).map(r=>({origin:String(r.origin),destination:String(r.destination),trips:Number(r.trips)}));
              const stats=(await ctl.q<Record<string,unknown>>(selectionStatsSql({side:chosen as "before"|"after",excludeIntrazonal:false}),`compare-stats-${run}`))[0]??{};
              gathered.push({run,trips:Number(chosen==="after"?total.after:total.before),cells:Number(total.n_cells??0),mean:stats.mean_km===null?null:Number(stats.mean_km),intra:extra.intra===null?null:Number(extra.intra),top10:extra.top10===null?null:Number(extra.top10),groups,pairs});
            }
          } finally {
            if(ctl.state.run!==original)await ctl.selectRun(original);
            comparisonBusy=false;
          }
          if(token===epoch){comparisonRows=gathered;baselineRun=gathered[0]?.run??"";compareRun=gathered[1]?.run??"";}
          if(token===epoch)void render(); return;
        }
        if(comparisonBusy){output.append(el("p",{class:"ao-alert",text:t("comparison.loading","Loading run summaries one at a time to keep memory bounded…") }));return;}
        const baseline=comparisonRows.find(r=>r.run===baselineRun)??comparisonRows[0], selected=comparisonRows.find(r=>r.run===compareRun)??comparisonRows[1];
        const chooseA=select(comparisonRows.map(r=>({value:r.run,label:r.run})),baseline?.run??"",v=>{baselineRun=v;void render();});
        const chooseB=select(comparisonRows.map(r=>({value:r.run,label:r.run})),selected?.run??"",v=>{compareRun=v;void render();});
        const metrics=[{label:"Total trips",key:"trips"},{label:"OD cells",key:"cells"},{label:"Mean trip length (km)",key:"mean"},{label:"Intrazonal share",key:"intra"},{label:"Top 10 pair share",key:"top10"}] as const;
        const kpiRows=metrics.map(m=>({metric:m.label,key:m.key}));
        const deltaCards=metrics.map(m=>{const a=baseline?.[m.key],b=selected?.[m.key];return kpi(`${m.label} (B − A)`,a===null||a===undefined||b===null||b===undefined?"—":fmt.signed(Number(b)-Number(a),m.key==="intra"||m.key==="top10"?4:1),a===null||a===undefined||b===null||b===undefined?"":`A ${fmt.num(Number(a),1)} · B ${fmt.num(Number(b),1)}`);});
        const groupKeys=new Set([...(baseline?.groups.map(g=>`${g.og}\0${g.dg}`)??[]),...(selected?.groups.map(g=>`${g.og}\0${g.dg}`)??[])]);
        const allGroupDeltas=baseline&&selected?[...groupKeys].map(key=>{const [og,dg]=key.split("\0"),a=baseline.groups.find(x=>x.og===og&&x.dg===dg)?.delta??0,b=selected.groups.find(x=>x.og===og&&x.dg===dg)?.delta??0;return{og,dg,delta:b-a};}):[];
        const groupRows=[...allGroupDeltas].sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,100);
        const groupVol=new Map<string,number>();for(const g of [...(baseline?.groups??[]),...(selected?.groups??[])]){groupVol.set(g.og,(groupVol.get(g.og)??0)+g.delta);groupVol.set(g.dg,(groupVol.get(g.dg)??0)+g.delta);}const groupNames=[...groupVol].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([g])=>g);
        const groupHeat=comparisonHeatmap(groupNames,allGroupDeltas,(v)=>fmt.signed(v,1),t("comparison.heat","Group-to-group delta heatmap"));
        const pairDelta=baseline&&selected?new Map([...baseline.pairs,...selected.pairs].map(r=>[`${r.origin}\0${r.destination}`,{origin:r.origin,destination:r.destination,delta:(selected.pairs.find(x=>x.origin===r.origin&&x.destination===r.destination)?.trips??0)-(baseline.pairs.find(x=>x.origin===r.origin&&x.destination===r.destination)?.trips??0)}])).values():[];
        const rankedChanges=comparisonLevel==="pair"?[...pairDelta].map(r=>({...r,label:`${r.origin} → ${r.destination}`})):comparisonLevel==="origin"?[...new Map([...pairDelta].map(r=>[r.origin,{label:r.origin,delta:0}])).values()].map(r=>({...r,delta:[...pairDelta].filter(x=>x.origin===r.label).reduce((s,x)=>s+x.delta,0)})):[...new Map([...pairDelta].map(r=>[r.destination,{label:r.destination,delta:0}])).values()].map(r=>({...r,delta:[...pairDelta].filter(x=>x.destination===r.label).reduce((s,x)=>s+x.delta,0)}));
        const changes=rankedChanges.filter(r=>comparisonTop==="gains"?r.delta>0:r.delta<0).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,50);
        const changeTabs=el("div",{class:"ao-tabs",attrs:{role:"tablist","aria-label":t("comparison.top","Top run changes")}});for(const [key,label] of [["gains","Top gains"],["losses","Top losses"]]){const b=el("button",{class:"ao-tab",text:t(`comparison.${key}`,label),attrs:{type:"button",role:"tab","aria-selected":String(comparisonTop===key)}});b.addEventListener("click",()=>{comparisonTop=key;void render();});changeTabs.append(b);}
        const levelControl=select([{value:"pair",label:t("comparison.odPairs","OD pairs")},{value:"origin",label:t("comparison.originZones","Origin zones")},{value:"destination",label:t("comparison.destinationZones","Destination zones")}],comparisonLevel,v=>{comparisonLevel=v;void render();});
        const groupCenter=(name:string):[number,number]|null=>{const zs=ctl.state.centroids.filter(c=>c.grp===name&&c.lon!==null&&c.lat!==null);return zs.length?[zs.reduce((s,c)=>s+c.lon!,0)/zs.length,zs.reduce((s,c)=>s+c.lat!,0)/zs.length]:null;};
        const netByGroup=new Map<string,number>();for(const r of groupRows){netByGroup.set(r.og,(netByGroup.get(r.og)??0)+r.delta);netByGroup.set(r.dg,(netByGroup.get(r.dg)??0)-r.delta);}
        const maxNet=Math.max(1,...[...netByGroup.values()].map(Math.abs));env.overlay.setLayers(["net","diff-lines"]);env.overlay.set("net",{type:"FeatureCollection",features:[...netByGroup].flatMap(([g,v])=>{const c=groupCenter(g);return c?[{type:"Feature" as const,geometry:{type:"Point" as const,coordinates:c},properties:{c:divergingHex(v,maxNet),r:Math.min(24,4+Math.sqrt(Math.abs(v))),tip:`${g}: ${fmt.signed(v,1)}`} }]:[]})});
        env.overlay.set("lines",{type:"FeatureCollection",features:groupRows.flatMap(r=>{const a=groupCenter(r.og),b=groupCenter(r.dg);return a&&b?[{type:"Feature" as const,geometry:{type:"LineString" as const,coordinates:[a,b]},properties:{c:divergingHex(r.delta,Math.max(1,...groupRows.map(x=>Math.abs(x.delta)))),w:Math.max(1,Math.sqrt(Math.abs(r.delta))/10),tip:`${r.og} → ${r.dg}: ${fmt.signed(r.delta,1)}`}}]:[]})});
        const sideControl=select([{value:"after",label:t("side.afterCap","After")},{value:"before",label:t("side.beforeCap","Before")}],comparisonSide,v=>{comparisonSide=v as "before"|"after";comparisonRows=[];void render();});
        const runColumns=[{label:t("comparison.metric","Metric"),value:(r:typeof kpiRows[number])=>r.metric},...comparisonRows.map(run=>({label:run.run,value:(r:typeof kpiRows[number])=>{const v=run[r.key];return v===null||v===undefined?"—":fmt.num(Number(v),r.key==="intra"||r.key==="top10"?3:1);},num:true}))];
        output.append(checksPanel(ctl,t,(v)=>fmt.int(v)),section(t("comparison.title","Run comparison"),[field(t("comparison.side","Matrix side"),sideControl),el("div",{class:"ao-grid"},[field(t("comparison.baseline","Run A baseline"),chooseA),field(t("comparison.other","Run B"),chooseB)]),el("p",{class:"ao-alert ao-warn",text:t("comparison.period","Demand period metadata may differ between runs. Confirm the package manifest periods before comparing totals.")}),el("div",{class:"ao-kpis"},deltaCards),table(runColumns,kpiRows),section(t("comparison.top","Top gains / losses"),[field(t("comparison.level","Rank by"),levelControl),el("p",{class:"ao-hint",text:t("comparison.cap","OD-pair changes are ranked from the 500 largest pairs in each run.")}),changeTabs,table([{label:t("comparison.item","Pair / zone"),value:r=>r.label},{label:t("comparison.delta","B − A"),value:r=>fmt.signed(r.delta,1),num:true}],changes)]),el("h3",{class:"ao-h",text:t("comparison.groups","Largest group-pair changes (B − A)")}),groupHeat,table([{label:t("axis.originShort","Origin group"),value:r=>r.og},{label:t("axis.destShort","Destination group"),value:r=>r.dg},{label:t("comparison.delta","B − A"),value:r=>fmt.signed(r.delta,1),num:true}],groupRows)]));
      }
    } catch(e) { if(token===epoch&&output){clear(output);output.append(el("p",{class:"ao-alert ao-bad",text:e instanceof Error?e.message:String(e)}));} }
  };
  return { mount(h){host=h;output=el("div",{class:"ao-results"});host.replaceChildren(output);void render();},onData(){if(!comparisonBusy)void render();},relocalize(){void render();},getState(){return{side,binWidth,maxKm,cumulative,matrixMetric,limit,baselineRun,compareRun,balanceBars,comparisonSide,comparisonLevel,comparisonTop};},setState(s){if(s&&typeof s==="object"){const x=s as Record<string,unknown>;if(typeof x.side==="string")side=x.side;if(typeof x.binWidth==="number")binWidth=x.binWidth;if(typeof x.maxKm==="number")maxKm=x.maxKm;if(typeof x.cumulative==="boolean")cumulative=x.cumulative;if(typeof x.matrixMetric==="string")matrixMetric=x.matrixMetric;if(typeof x.limit==="number")limit=x.limit;if(typeof x.baselineRun==="string")baselineRun=x.baselineRun;if(typeof x.compareRun==="string")compareRun=x.compareRun;if(typeof x.balanceBars==="boolean")balanceBars=x.balanceBars;if(x.comparisonSide==="before"||x.comparisonSide==="after")comparisonSide=x.comparisonSide;if(typeof x.comparisonLevel==="string")comparisonLevel=x.comparisonLevel;if(x.comparisonTop==="gains"||x.comparisonTop==="losses")comparisonTop=x.comparisonTop;}void render();},dispose(){epoch++;env.overlay.setTiltForBars(false);host=output=null;} };
}

function numberInput(value:number,min:number,max:number,set:(n:number)=>void):HTMLInputElement { const i=el("input",{class:"ao-input",attrs:{type:"number",min:String(min),max:String(max),step:"0.25"}});i.value=String(value);i.addEventListener("change",()=>{const n=Number(i.value);if(Number.isFinite(n)&&n>=min&&n<=max)set(n);});return i; }

function balanceScatter(rows:readonly {id:string;productions:number;attractions:number}[],title:string):HTMLElement {
  const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 320 200");svg.setAttribute("role","img");svg.setAttribute("aria-label",title);svg.setAttribute("class","ao-balance-scatter");
  const max=Math.max(1,...rows.flatMap(r=>[r.productions,r.attractions]));const line=document.createElementNS(ns,"line");line.setAttribute("x1","24");line.setAttribute("y1","176");line.setAttribute("x2","304");line.setAttribute("y2","12");line.setAttribute("stroke","#777");line.setAttribute("stroke-dasharray","4 3");svg.append(line);
  for(const r of rows.slice(0,2000)){const dot=document.createElementNS(ns,"circle");dot.setAttribute("cx",String(24+r.productions/max*280));dot.setAttribute("cy",String(176-r.attractions/max*164));dot.setAttribute("r","2.5");dot.setAttribute("fill","#2878c8");dot.setAttribute("aria-label",`${r.id}: P ${r.productions}, A ${r.attractions}`);svg.append(dot);}
  return el("section",{class:"ao-section"},[el("h3",{class:"ao-h",text:title}),el("div",{class:"ao-chart"},[svg])]);
}

function balanceRatioHistogram(rows:readonly {ratio:number|null}[],title:string):HTMLElement {
  const labels=["< 0.5","0.5–1","1–1.5","1.5–2",">= 2","∞ / undefined"],counts=[0,0,0,0,0,0];
  for(const r of rows){const x=r.ratio;if(x===null){counts[5]++;continue;}const i=x<.5?0:x<1?1:x<1.5?2:x<2?3:4;counts[i]++;}
  const max=Math.max(1,...counts),bars=labels.map((label,i)=>el("div",{class:"ao-ratio-row"},[el("span",{text:label}),el("span",{class:"ao-ratio-track"},[el("span",{class:"ao-ratio-bar",attrs:{style:`inline-size:${counts[i]/max*100}%`}})]),el("span",{class:"ao-num",text:String(counts[i])})]));
  return section(title,bars);
}

function comparisonHeatmap(groups:readonly string[],rows:readonly {og:string;dg:string;delta:number}[],format:(n:number)=>string,title:string):HTMLElement {
  const values=new Map(rows.map(r=>[`${r.og}\0${r.dg}`,r.delta]));const max=Math.max(1,...rows.map(r=>Math.abs(r.delta)));
  const head=el("tr",{},[el("th"),...groups.map(g=>el("th",{text:g,class:"ao-num"}))]);
  const body=groups.map(o=>el("tr",{},[el("td",{text:o,class:"ao-rowhead"}),...groups.map(d=>{const v=values.get(`${o}\0${d}`)??0;return el("td",{class:"ao-num",text:format(v),attrs:{style:`background:${divergingHex(v,max)}`}});})]));
  return el("section",{class:"ao-section"},[el("h3",{class:"ao-h",text:title}),el("div",{class:"ao-table-wrap"},[el("table",{class:"ao-table"},[el("thead",{},[head]),el("tbody",{},body)])])]);
}
