import { conservationChecks } from "../analytics.ts";
import type { OdController } from "./controller.ts";
import { el } from "./ui.ts";

/** Lazy collapsible integrity panel; all SQL results are scalars or small group aggregates. */
export function checksPanel(ctl: OdController, translate: (key:string,en:string)=>string, format: (value:number)=>string): HTMLElement {
  const details=el("details",{class:"ao-checks"});
  const badge=el("span",{class:"ao-checks-badge ao-checks-pending",text:translate("checks.pending","Checks not run")});
  const summary=el("summary",{},[el("span",{text:translate("checks.title","Checks")}),badge]);
  const body=el("div",{class:"ao-checks-body"});details.append(summary,body);
  let complete=false, tolerance=.5, tolerancePct=.0001;
  const run=async():Promise<void>=>{
    body.replaceChildren(el("p",{class:"ao-hint",text:translate("checks.loading","Checking matrix totals…")}));
    try {
      await ctl.ensureCells();
      const totals=(await ctl.q<Record<string,unknown>>("SELECT COALESCE(SUM(before),0) AS before,COALESCE(SUM(after),0) AS after,COUNT(*) AS n_cells,SUM(CASE WHEN before=0 AND after>0 THEN 1 ELSE 0 END) AS new_n,SUM(CASE WHEN before>0 AND after=0 THEN 1 ELSE 0 END) AS dropped_n,SUM(CASE WHEN before=0 AND after>0 THEN after ELSE 0 END) AS new_trips,SUM(CASE WHEN before>0 AND after=0 THEN before ELSE 0 END) AS dropped_trips,SUM(CASE WHEN before<0 OR after<0 OR NOT isfinite(before) OR NOT isfinite(after) THEN 1 ELSE 0 END) AS invalid FROM od_cell"))[0]??{};
      const sums=(await ctl.q<Record<string,unknown>>("WITH r AS (SELECT o,SUM(before) AS before,SUM(after) AS after FROM od_cell GROUP BY o),c AS (SELECT d,SUM(before) AS before,SUM(after) AS after FROM od_cell GROUP BY d) SELECT (SELECT COALESCE(SUM(before),0) FROM r) AS row_before,(SELECT COALESCE(SUM(after),0) FROM r) AS row_after,(SELECT COALESCE(SUM(before),0) FROM c) AS col_before,(SELECT COALESCE(SUM(after),0) FROM c) AS col_after"))[0]??{};
      const unknown=(await ctl.q<Record<string,unknown>>("SELECT COALESCE(SUM(CASE WHEN co.id IS NULL OR cd.id IS NULL THEN c.before+c.after ELSE 0 END),0) trips,COALESCE(SUM(CASE WHEN co.id IS NOT NULL AND cd.id IS NOT NULL AND (co.grp='(none)' OR cd.grp='(none)') THEN c.before+c.after ELSE 0 END),0) ungrouped FROM od_cell c LEFT JOIN v_centroids_norm co ON co.id=c.o LEFT JOIN v_centroids_norm cd ON cd.id=c.d"))[0]??{};
      const grouped=(await ctl.q<Record<string,unknown>>("SELECT COALESCE(SUM(before),0) AS before,COALESCE(SUM(after),0) AS after FROM (SELECT SUM(c.before) AS before,SUM(c.after) AS after FROM od_cell c LEFT JOIN v_centroids_norm co ON co.id=c.o LEFT JOIN v_centroids_norm cd ON cd.id=c.d GROUP BY COALESCE(co.grp,'(none)'),COALESCE(cd.grp,'(none)'))"))[0]??{};
      const negatives=(await ctl.q<Record<string,unknown>>("SELECT (SELECT COUNT(*) FROM od_before_raw WHERE value<0 OR NOT isfinite(value))+(SELECT COUNT(*) FROM od_after_raw WHERE value<0 OR NOT isfinite(value)) n"))[0]??{};
      const b=Number(totals.before),a=Number(totals.after),newN=Number(totals.new_n??0),dropN=Number(totals.dropped_n??0),unknownTrips=Number(unknown.trips??0);
      const checks=conservationChecks({before:b,after:a,rowSum:Number(sums.row_after??0),columnSum:Number(sums.col_after??0),grand:a,rowSumBefore:Number(sums.row_before??0),columnSumBefore:Number(sums.col_before??0),grandBefore:b,grouped:Number(grouped.after??0),groupedBefore:Number(grouped.before??0),ungroupedTrips:Number(unknown.ungrouped??0),newFlows:newN,droppedFlows:dropN,unknownTrips,invalidValues:Number(negatives.n??totals.invalid??0),tolerance,tolerancePct});
      checks[2].detail+=`; ${format(Number(unknown.ungrouped??0))} ungrouped trips; ${format(unknownTrips)} unknown-id trips`;
      checks[3].detail=`${newN} new / ${format(Number(totals.new_trips??0))} trips; ${dropN} dropped / ${format(Number(totals.dropped_trips??0))} trips`;
      const hashState=ctl.state.hashes.some(h=>h.state==="unverified")?"mismatch":ctl.state.hashes.length&&ctl.state.hashes.every(h=>h.state==="verified")?"verified":"undeclared";
      checks.push({name:"manifest-sha256",pass:hashState!=="mismatch",detail:hashState});
      const ok=checks.every(c=>c.pass);badge.className=`ao-checks-badge ${ok?"ao-checks-ok":"ao-checks-warn"}`;badge.textContent=ok?translate("checks.ok","OK"):translate("checks.warning","Warnings");
      const input=el("input",{class:"ao-input",attrs:{type:"number",min:"0",step:"0.1","aria-label":translate("checks.tolerance","Tolerance (trips)")}});input.value=String(tolerance);input.addEventListener("change",()=>{const n=Number(input.value);if(Number.isFinite(n)&&n>=0){tolerance=n;complete=false;void run();}});
      const pctInput=el("input",{class:"ao-input",attrs:{type:"number",min:"0",step:"0.01","aria-label":translate("checks.tolerancePct","Relative tolerance (%)")}});pctInput.value=String(tolerancePct*100);pctInput.addEventListener("change",()=>{const n=Number(pctInput.value);if(Number.isFinite(n)&&n>=0&&n<=100){tolerancePct=n/100;complete=false;void run();}});
      body.replaceChildren(el("div",{class:"ao-grid"},[el("label",{class:"ao-field"},[el("span",{class:"ao-label",text:translate("checks.tolerance","Tolerance (trips)")}),input]),el("label",{class:"ao-field"},[el("span",{class:"ao-label",text:translate("checks.tolerancePct","Relative tolerance (%)")}),pctInput])]),...checks.map(c=>el("div",{class:`ao-check-row ${c.pass?"ao-check-pass":"ao-check-fail"}`},[el("strong",{text:`${c.pass?"✓":"!"} ${c.name}`}),el("span",{text:c.detail})])));
      complete=true;
    } catch(e) { badge.className="ao-checks-badge ao-checks-warn";badge.textContent=translate("checks.warning","Warnings");body.replaceChildren(el("p",{class:"ao-alert ao-warn",text:e instanceof Error?e.message:String(e)}));complete=true; }
  };
  details.addEventListener("toggle",()=>{if(details.open&&!complete)void run();});
  return details;
}
