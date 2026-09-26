import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibrePlugin } from "../types";
import { useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import { depthOcclusionParameters, ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import { buildScenarioComparisonRows, type ComparisonInput, type ComparisonRow } from "./scenario-comparison-data";
import { comparisonCategoricalRamp, type ComparisonMetric } from "./comparison-ramps";
import { createNetworkKpiDirectorySource, createNetworkKpiHttpSource, fetchNetworkKpiManifestJson, laneKey, loadNetworkKpiGeometry, parseNetworkKpiManifest, readLocalNetworkKpiManifestJson, type NetworkKpiDirectoryHandle, type NetworkKpiGeometry, type NetworkKpiPackageSource, type NetworkKpiResults } from "./network-kpi-data";
import { supportsLocalPackageFolders } from "./vehicle-playback-data";
import { bufferLineToRing } from "./network-kpi-geometry";
import { listVehicleManifestScenarios, type VehicleManifestScenario } from "./vehicle-playback-data";
import { openTestudoDatasetProvider, type TestudoDatasetProvider, type TestudoDatasetQueryResult } from "./testudo-dataset-provider";
import type { GeolibreReplication } from "./geolibre-package-loader";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";
import { createIntervalPlaybackController, stepInterval } from "../shared/useIntervalPlayback";
import { elevationByKpi, KPI_RANGES, type NetworkKpiMetric } from "./network-kpi-ramps";
import { readSimulationTimeline, type SimulationTimeline } from "../shared/simulation-timeline";
import { declutterMapLabels, formatRoundedDifference, lineMidpoint, passesComparisonDifferenceFilter } from "../shared/map-labels";
export const SCENARIO_COMPARISON_PLUGIN_ID = "geolibre-scenario-comparison";
export const SCENARIO_COMPARISON_STORE_LAYER_ID = "geolibre-scenario-comparison-layer";
export interface ScenarioComparisonSettings { manifestUrl: string | null; scenarioA: number; scenarioB: number; didA: number | null; didB: number | null; mode: "side-by-side" | "diff"; metric: ComparisonMetric; differenceThreshold: number; extruded: boolean; maxHeightM: number; interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean; opacity: number; seeThroughBuildings: boolean; }
export interface ScenarioComparisonStatus { loading: boolean; error: string|null; scenarios: VehicleManifestScenario[]; intervals: number[]; timelineA?: SimulationTimeline|null; timelineB?: SimulationTimeline|null; replicationsA: GeolibreReplication[]; replicationsB: GeolibreReplication[]; sectionsA: number; sectionsB: number; lanesA: number; lanesB: number; turnsA: number; turnsB: number; }
export const DEFAULT_SCENARIO_COMPARISON_SETTINGS: ScenarioComparisonSettings = {manifestUrl:null,scenarioA:0,scenarioB:0,didA:null,didB:null,mode:"diff",metric:"flow_delta",differenceThreshold:50,extruded:false,maxHeightM:10,interval:0,intervalPlaying:false,playbackSpeed:1,loop:true,opacity:.85,seeThroughBuildings:true};
export const SCENARIO_COMPARISON_CONTINUOUS_RAMPS = { flow_delta:{stops:[-1000,-500,0,500,1000],colors:["#2166ac","#67a9cf","#f7f7f7","#ef8a62","#b2182b"],unit:"veh/h",label:"Flow delta"}, flow_density_product_delta:{stops:[-100000,-50000,0,50000,100000],colors:["#2166ac","#67a9cf","#f7f7f7","#ef8a62","#b2182b"],unit:"veh²/h²",label:"Flow-density product delta"} } as const;
let settings={...DEFAULT_SCENARIO_COMPARISON_SETTINGS}, visible=false, layerVisible=true; const listeners=new Set<()=>void>(); let rows: ComparisonRow[]=[]; let geometry:NetworkKpiGeometry|null=null; let geometryB:NetworkKpiGeometry|null=null; let datasetA:NetworkKpiGeometry|null=null; let datasetB:NetworkKpiGeometry|null=null; let provider:TestudoDatasetProvider|null=null; let appRef:GeoLibreAppAPI|null=null; let deck:GeoLibreDeckGL|null=null; let loadToken=0; let readToken=0; let geometryReadToken=0; let intervals:number[]=[]; let labelMapMoveBound=false; const playback=createIntervalPlaybackController(()=>stepScenarioComparisonInterval(1)); let status:ScenarioComparisonStatus={loading:false,error:null,scenarios:[],intervals:[],replicationsA:[],replicationsB:[],sectionsA:0,sectionsB:0,lanesA:0,lanesB:0,turnsA:0,turnsB:0};
// Retained so a scenario-selector change (setScenarioComparisonSettings) can
// re-resolve each side's OWN geometry (`geometry`/`geometryB` above) for the
// newly selected scenario index, the same way maplibre-network-kpi's
// adoptScenario() re-fetches geometry alongside results on every scenario
// switch. Without this, `geometry`/`geometryB` are only ever populated once,
// at initial manifest load, for whatever scenarioA/scenarioB were selected
// THEN — so switching scenarios re-queries the KPI numbers (via readCurrent(),
// which is scenario-aware) but keeps rendering the previous scenario's
// section/lane shapes, a geometry/data mismatch (GitHub #277).
let manifestRaw: unknown = null;
let packageSource: NetworkKpiPackageSource | null = null;
let manifestBaseUrl: string | null = null;
const COMPARISON_ROW_LIMIT = 250_000;
const SECTION_KPI_COLUMNS = ["oid", "flow", "speed", "density", "dtime", "sid", "ent", "did"];
const LANE_KPI_COLUMNS = ["oid", "lane", "flow", "speed", "density", "dtime", "sid", "ent", "did"];
const intervalCache = new Map<string, number[]>();
let sidePaneId:string|null=null; let sideLayerIds:string[]=[];
const notify=()=>listeners.forEach(f=>f());
export const getScenarioComparisonSnapshot=()=>settings; export const subscribeScenarioComparison=(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);};
// useSyncExternalStore requires a stable snapshot between store updates.
// Returning a newly-created object on every read can cause a render loop.
export const getScenarioComparisonStatus=()=>status; export const subscribeScenarioComparisonStatus=(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);};
export const isScenarioComparisonPanelVisible=()=>visible; function registerScenarioComparisonStoreLayer(){appRef?.registerExternalNativeLayer?.({id:SCENARIO_COMPARISON_STORE_LAYER_ID,name:"Scenario comparison",type:"geojson",nativeLayerIds:[],paintMode:"plugin",metadata:{customLayerType:"deck.gl"},paintBridge:{setOpacity:(opacity)=>{settings={...settings,opacity};render();notify();},setVisibility:(next)=>{layerVisible=next;sideLayerIds.forEach(id=>useAppStore.getState().setLayerVisibility(id,next));if(next)render();else setSharedDeckLayers("scenario-comparison",[]);}}});} export function openScenarioComparisonPanel(app:GeoLibreAppAPI){appRef=app;visible=true;if(!labelMapMoveBound){const map=app.getMap?.() as any;if(map?.on){map.on("moveend",render);labelMapMoveBound=true;}}registerScenarioComparisonStoreLayer();registerDuckDbLayer({pluginId:"scenario-comparison",dispose:()=>{const closing=provider;provider=null;if(closing)void closing.close();}});if(app.getDeckGL)void app.getDeckGL().then(async d=>{deck=d;await ensureSharedDeckOverlay(app);render();}).catch(error=>{console.warn("[GeoLibre] scenario-comparison: deck.gl unavailable",error);status={...status,error:error instanceof Error?error.message:String(error)};notify();});notify();}
// `provider` (a TestudoDatasetProvider, holding a DuckDB connection/worker) was
// previously only ever closed on manifest replace (setScenarioComparisonManifestUrl
// / loadLocalScenarioComparisonFolder) — closing the panel dropped the reference
// without releasing it, leaking the DuckDB instance. `deactivate` is bound
// directly to this function, so this one fix covers both the panel-close and
// plugin-deactivate paths.
export function closeScenarioComparisonPanel(_app?:GeoLibreAppAPI){visible=false;playback.dispose();settings={...settings,intervalPlaying:false};releaseDuckDbLayer("scenario-comparison");appRef?.unregisterExternalNativeLayer?.(SCENARIO_COMPARISON_STORE_LAYER_ID);disableSideBySide();setSharedDeckLayers("scenario-comparison",[]);const closing=provider;provider=null;if(closing)void closing.close();notify();}
function updateReplications(dataset:TestudoDatasetProvider):void { status={...status,replicationsA:dataset.metadata.scenarios[settings.scenarioA]?.replications??[],replicationsB:dataset.metadata.scenarios[settings.scenarioB]?.replications??[]}; }
export function setScenarioComparisonSettings(next:Partial<ScenarioComparisonSettings>){const oldMode=settings.mode;const scenarioAChanged=next.scenarioA!==undefined&&next.scenarioA!==settings.scenarioA;const scenarioBChanged=next.scenarioB!==undefined&&next.scenarioB!==settings.scenarioB;settings={...settings,...next};if(provider&&(next.scenarioA!==undefined||next.scenarioB!==undefined))updateReplications(provider);if(settings.mode!==oldMode)(settings.mode==="side-by-side"?enableSideBySide:disableSideBySide)();if(next.metric!==undefined&&settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}if(scenarioAChanged||scenarioBChanged)void reloadScenarioGeometry(scenarioAChanged,scenarioBChanged);if(next.interval !== undefined || next.didA !== undefined || next.didB !== undefined || next.scenarioA !== undefined || next.scenarioB !== undefined) void readCurrent(); if(layerVisible)render();else setSharedDeckLayers("scenario-comparison",[]);notify();}
/**
 * Re-resolve one or both sides' geometry for their now-current scenario
 * index and refresh whatever currently depends on it (the side-by-side
 * layers and, on completion, a render pass). `readCurrent()` already
 * re-queries the KPI numbers for a scenario change on its own token
 * (`readToken`); this runs on its own `geometryReadToken` so a fast run of
 * scenario switches only ever applies the LATEST geometry pair, exactly the
 * stale-response guard `readCurrent()`/the loaders use for `readToken`/
 * `loadToken`.
 */
async function reloadScenarioGeometry(reloadA:boolean,reloadB:boolean):Promise<void>{if(!packageSource||!manifestRaw)return;const token=++geometryReadToken;const parentToken=loadToken;try{const [nextGeometry,nextGeometryB]=await Promise.all([reloadA?loadNetworkKpiGeometry(packageSource,parseNetworkKpiManifest(manifestRaw,manifestBaseUrl,settings.scenarioA).geometry):Promise.resolve(geometry),reloadB?loadNetworkKpiGeometry(packageSource,parseNetworkKpiManifest(manifestRaw,manifestBaseUrl,settings.scenarioB).geometry):Promise.resolve(geometryB)]);if(token!==geometryReadToken||parentToken!==loadToken)return;geometry=nextGeometry;geometryB=nextGeometryB;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();}catch(error){if(token!==geometryReadToken||parentToken!==loadToken)return;status={...status,error:error instanceof Error?error.message:String(error)};notify();}}
export function swapScenarioComparisonSides():void{const scenarioA=settings.scenarioA;const didA=settings.didA;settings={...settings,scenarioA:settings.scenarioB,scenarioB:scenarioA,didA:settings.didB,didB:didA};[geometry,geometryB]=[geometryB,geometry];[datasetA,datasetB]=[datasetB,datasetA];if(provider)updateReplications(provider);void readCurrent();notify();}
function enableSideBySide(){if(!appRef||!datasetA?.sections)return;const store=useAppStore.getState();store.setMapGrid(1,2);const pane=store.secondaryMapViews.at(-1);if(!pane){setTimeout(enableSideBySide,100);return;}sidePaneId=pane.id;store.setSecondaryMapLabel(pane.id,replicationLabel(settings.scenarioB,settings.didB,"Compared"));const metric=settings.metric==="flow"||settings.metric==="density"||settings.metric==="speed"?settings.metric:"flow";const style={strokeColor:"#64748b",strokeWidth:2,fillOpacity:.85,vectorStyleMode:"graduated" as const,vectorStyleProperty:`comparison_${metric}`,vectorStyleClassCount:5};const a=appRef.addGeoJsonLayer(replicationLabel(settings.scenarioA,settings.didA,"Reference"),datasetA.sections as never);store.setLayerStyle(a,style);if(!datasetB?.sections){console.warn("[GeoLibre] scenario-comparison: Compared dataset genuinely failed to load; showing only Reference");sideLayerIds=[a];return;}const b=appRef.addGeoJsonLayer(replicationLabel(settings.scenarioB,settings.didB,"Compared"),datasetB.sections as never);store.setLayerStyle(b,style);sideLayerIds=[a,b];setTimeout(()=>{const current=useAppStore.getState();current.setSecondaryLayerVisibility(pane.id,a,false);current.setSecondaryLayerVisibility(pane.id,b,true);},100);}
function replicationLabel(index:number,did:number|null,role:"Reference"|"Compared"):string{const replication=provider?.metadata.scenarios[index]?.replications.find(item=>item.did===did);const name=replication?.xname??replication?.didname??(did===null?"":String(did));return name?`${name} [${role}]`:role;}
function disableSideBySide(){const store=useAppStore.getState();for(const id of sideLayerIds)store.removeLayer(id);if(sidePaneId)store.removeSecondaryMapView(sidePaneId);sidePaneId=null;sideLayerIds=[];setSharedDeckLayers("scenario-comparison",[]);}
export function computeScenarioComparison(a:readonly ComparisonInput[],b:readonly ComparisonInput[]){rows=buildScenarioComparisonRows(a,b);notify();return rows;}
export function getScenarioComparisonRows(){return rows;}
export function stepScenarioComparisonInterval(direction:1|-1){const values=intervals.filter(v=>v!==0);if(values.length<2)return;const current=values.indexOf(settings.interval);const nextIndex=current<0?(direction===1?0:values.length-1):current+direction;if(!settings.loop&&(nextIndex<0||nextIndex>=values.length)){settings={...settings,intervalPlaying:false};playback.sync(false);notify();return;}const next=values[(nextIndex+values.length)%values.length];setScenarioComparisonSettings({interval:next});}
export function toggleScenarioComparisonIntervalPlaying(){settings={...settings,intervalPlaying:!settings.intervalPlaying};playback.sync(settings.intervalPlaying,Math.max(100,1000/settings.playbackSpeed));notify();}
export async function setScenarioComparisonManifestUrl(url:string){const token=++loadToken;const oldProvider=provider;provider=null;intervalCache.clear();if(oldProvider)await oldProvider.close();geometry=null;geometryB=null;datasetA=null;datasetB=null;manifestRaw=null;packageSource=null;manifestBaseUrl=null;status={...status,loading:Boolean(url.trim()),error:null};notify();if(!url.trim()){settings={...settings,manifestUrl:null};status={...status,loading:false,scenarios:[],intervals:[]};notify();return;} settings={...settings,manifestUrl:url};try{const raw=await fetchNetworkKpiManifestJson(url);if(token!==loadToken)return;status={...status,scenarios:listVehicleManifestScenarios(raw)};const source=createNetworkKpiHttpSource(url);const manifestA=parseNetworkKpiManifest(raw,url,settings.scenarioA);const manifestB=parseNetworkKpiManifest(raw,url,settings.scenarioB);[geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]);if(token!==loadToken)return;manifestRaw=raw;packageSource=source;manifestBaseUrl=url;if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);provider=await openTestudoDatasetProvider({source,manifest:raw});await readCurrent(token);if(token!==loadToken)return;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();}catch(error){if(token!==loadToken)return;status={...status,loading:false,error:error instanceof Error?error.message:String(error)};notify();}}
export function canLoadLocalScenarioComparisonPackage(): boolean { return supportsLocalPackageFolders(); }
export async function loadLocalScenarioComparisonFolder(selectedDirectory?:NetworkKpiDirectoryHandle): Promise<void> { const token=++loadToken; if(!selectedDirectory&&!canLoadLocalScenarioComparisonPackage()){status={...status,error:"Local folders are not supported in this browser."};notify();return;} const oldProvider=provider;provider=null;intervalCache.clear();if(oldProvider)await oldProvider.close(); manifestRaw=null;packageSource=null;manifestBaseUrl=null; status={...status,loading:true,error:null};notify(); try { const root=selectedDirectory??await(window as any).showDirectoryPicker() as NetworkKpiDirectoryHandle; if(token!==loadToken)return; const raw=await readLocalNetworkKpiManifestJson(root); if(token!==loadToken)return; status={...status,scenarios:listVehicleManifestScenarios(raw)}; const source=createNetworkKpiDirectorySource(root); const manifestA=parseNetworkKpiManifest(raw,null,settings.scenarioA); const manifestB=parseNetworkKpiManifest(raw,null,settings.scenarioB); [geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]); if(token!==loadToken)return; manifestRaw=raw;packageSource=source;manifestBaseUrl=null; if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);provider=await openTestudoDatasetProvider({source,manifest:raw});await readCurrent(token);if(token!==loadToken)return; if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render(); notify(); } catch(error) { if(token!==loadToken)return; const cancelled=error instanceof Error&&error.name==="AbortError"; status={...status,loading:false,error:cancelled?null:error instanceof Error?error.message:String(error)}; notify(); } }
function inputs(result:NetworkKpiResults){return [...result.sections].map(([key,v])=>({key,flow:v.flow??null,density:v.density??null,speed:v.speed??null,delay:v.delay??null}));}
function withKpiData(source: NetworkKpiGeometry, result: NetworkKpiResults): NetworkKpiGeometry {
  const sections = source.sections ? {
    ...source.sections,
    features: source.sections.features.map((feature) => {
      const p = feature.properties ?? {};
      const k = result.sections.get(Number(p.section_id ?? p.oid));
      return { ...feature, properties: { ...p, comparison_did: result.did, comparison_flow: k?.flow ?? null, comparison_density: k?.density ?? null, comparison_speed: k?.speed ?? null, comparison_interval: result.interval } };
    }),
  } : null;
  const lanes = source.lanes ? {
    ...source.lanes,
    features: source.lanes.features.map((feature) => {
      const p = feature.properties ?? {};
      const k = result.lanes.get(laneKey(Number(p.section_id ?? p.oid), Number(p.lane_index)));
      return { ...feature, properties: { ...p, comparison_did: result.did, comparison_flow: k?.flow ?? null, comparison_density: k?.density ?? null, comparison_speed: k?.speed ?? null, comparison_interval: result.interval } };
    }),
  } : null;
  return { ...source, sections, lanes };
}
function finite(value:unknown):number|null{if(value===null||value===undefined||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function usable(value:unknown):number|null{const n=finite(value);return n===null||n<0?null:n;}
function scenarioSelection(dataset:TestudoDatasetProvider,index:number,selectedDid:number|null):{scenarioId?:string|number;did?:number}{const declared=dataset.metadata.scenarios[index];if(declared){const valid=selectedDid!==null&&declared.replications.some(replication=>replication.did===selectedDid);const did=valid?selectedDid:declared.replications[0]?.did;if(did===undefined)throw new Error(`Scenario ${String(declared.scid)} declares no replication.`);return {scenarioId:declared.scid,did};}const did=selectedDid??dataset.metadata.datasets.find(item=>item.table.toUpperCase()==="MISECT")?.dids[0];return did===undefined?{}:{did};}
async function availableIntervals(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number}):Promise<number[]>{const key=`${String(selection.scenarioId??"")}:${String(selection.did??"")}`;const cached=intervalCache.get(key);if(cached)return cached;const result=await dataset.query({dataset:"MISECT",...selection,columns:["ent"],distinct:true,filters:[{column:"sid",op:"=",value:0}],limit:COMPARISON_ROW_LIMIT});if(result.truncated)throw new Error("Scenario comparison interval discovery exceeded its bounded query limit.");const values=[...new Set(result.rows.map(row=>finite(row.ent)).filter((value):value is number=>value!==null))].sort((a,b)=>a-b);const normalized=values.length?values:[0];intervalCache.set(key,normalized);return normalized;}
function intervalFor(requested:number,values:number[]):number{return values.includes(requested)?requested:values.includes(0)?0:(values[0]??0);}
function emptyKpi(did:number|null,interval:number,intervals:number[]):NetworkKpiResults{return {sections:new Map(),lanes:new Map(),intervals,sids:[0],dids:did===null?[]:[did],did,sid:0,interval};}
async function readKpi(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number},requestedInterval:number):Promise<NetworkKpiResults>{const values=await availableIntervals(dataset,selection);const interval=intervalFor(requestedInterval,values);const filters=[{column:"sid" as const,op:"=" as const,value:0},{column:"ent" as const,op:"=" as const,value:interval}];const sections=await dataset.query({dataset:"MISECT",...selection,columns:SECTION_KPI_COLUMNS,filters,limit:COMPARISON_ROW_LIMIT});if(sections.truncated)throw new Error("Scenario comparison section KPI query exceeded its bounded query limit.");let lanes:TestudoDatasetQueryResult={rows:[],columns:[],rowCount:0,truncated:false,source:sections.source,dataset:"MILANE",did:sections.did,scenarioId:sections.scenarioId,warnings:sections.warnings};try{lanes=await dataset.query({dataset:"MILANE",...selection,columns:LANE_KPI_COLUMNS,filters,limit:COMPARISON_ROW_LIMIT});if(lanes.truncated)throw new Error("Scenario comparison lane KPI query exceeded its bounded query limit.");}catch(error){if(error instanceof Error&&error.message.includes("exceeded its bounded query limit"))throw error;/* MILANE is optional for packages containing section KPIs only. */}const result=emptyKpi(selection.did??sections.did??null,interval,values);for(const row of sections.rows){const oid=finite(row.oid);if(oid===null)continue;result.sections.set(oid,{flow:usable(row.flow),speed:usable(row.speed),density:usable(row.density),delay:usable(row.dtime)});}for(const row of lanes.rows){const oid=finite(row.oid);const lane=finite(row.lane);if(oid===null||lane===null)continue;result.lanes.set(laneKey(oid,lane-1),{flow:usable(row.flow),speed:usable(row.speed),density:usable(row.density),delay:usable(row.dtime)});}result.did=sections.did??selection.did??null;return result;}
async function readCurrent(parentToken=loadToken){if(!provider)return;const dataset=provider;const token=++readToken;const selectionA=scenarioSelection(dataset,settings.scenarioA,settings.didA);const selectionB=scenarioSelection(dataset,settings.scenarioB,settings.didB);const [intervalsA,intervalsB]=await Promise.all([availableIntervals(dataset,selectionA),availableIntervals(dataset,selectionB)]);if(token!==readToken||parentToken!==loadToken)return;const common=intervalsA.filter(value=>intervalsB.includes(value));intervals=common.length?common:intervalsA;const requested=intervalFor(settings.interval,intervals);const [a,b]=await Promise.all([readKpi(dataset,selectionA,requested),readKpi(dataset,selectionB,requested)]);if(token!==readToken||parentToken!==loadToken)return;const [timelineA,timelineB]=await Promise.all([readSimulationTimeline(dataset,selectionA),readSimulationTimeline(dataset,selectionB)]);if(token!==readToken||parentToken!==loadToken)return;
// `database.read()` silently resolves a null/missing did to some default
// (network-kpi-data.ts's `dids[0]`), which can differ from the id shown in
// each side's dropdown. Write the resolved id back so state never diverges
// from what was actually queried/rendered, and so the dropdown's displayed
// value (which falls back to the first option while did is null) becomes
// the real committed selection instead of a value the user must re-click
// past to "unstick".
 intervals=common.length?common:[...new Set([...a.intervals,...b.intervals])].sort((x,y)=>x-y);status={...status,loading:false,intervals,timelineA,timelineB,sectionsA:a.sections.size||geometry?.sections?.features.length||0,sectionsB:b.sections.size||geometryB?.sections?.features.length||0,lanesA:a.lanes.size||geometry?.lanes?.features.length||0,lanesB:b.lanes.size||geometryB?.lanes?.features.length||0,turnsA:geometry?.turns?.features.length??0,turnsB:geometryB?.turns?.features.length??0};if(settings.didA!==a.did||settings.didB!==b.did)settings={...settings,didA:a.did,didB:b.did,interval:requested};
datasetA=geometry?withKpiData(geometry,a):null;datasetB=geometryB?withKpiData(geometryB,b):null;rows=buildScenarioComparisonRows(inputs(a),inputs(b));if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();}
function color(row:ComparisonRow):[number,number,number,number]{const value=row[settings.metric];const alpha=Math.round(settings.opacity*255);if(value===null||value===undefined)return [136,136,136,alpha];if(typeof value!=="string"){const n=Number(value);if(!Number.isFinite(n))return [136,136,136,alpha];const base=settings.metric.replace("_delta","") as NetworkKpiMetric;const max=KPI_RANGES[base]?.max??1000;const t=Math.max(-1,Math.min(1,n/max));const stops=[[33,102,172],[103,169,207],[247,247,247],[239,138,98],[178,24,43]] as const;const position=(t+1)*2;const i=Math.min(3,Math.floor(position));const f=position-i;const a=stops[i];const b=stops[i+1];return [Math.round(a[0]+(b[0]-a[0])*f),Math.round(a[1]+(b[1]-a[1])*f),Math.round(a[2]+(b[2]-a[2])*f),alpha];}const cat=comparisonCategoricalRamp(settings.metric)?.categories.find(c=>c.key===value);const h=(cat?.color??"#888").replace("#","");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),alpha];}
function validRing(ring:readonly [number,number][]):boolean{return ring.length>=3&&ring.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y));}
function render(){
  if(!deck)return;
  if(!geometry||settings.mode!=="diff"){setSharedDeckLayers("scenario-comparison",[]);return;}
  if(!visible||!layerVisible){setSharedDeckLayers("scenario-comparison",[]);return;}
  const rowsByKey=new Map(rows.map(row=>[String(row.key),row]));
  const numericDifference=settings.metric.endsWith("_delta");
  const threshold=Math.max(0,settings.differenceThreshold??50);
  const labels:Array<{position:[number,number];elevation:number;text:string;priority:number;widthPx:number}> = [];
  const features=geometry.sections?.features??[];
  const data=features.flatMap(f=>{
    const p=f.properties??{};
    const key=Number(p.section_id??p.oid);
    const row=rowsByKey.get(String(key))??{key,flow:null,density:null,speed:null,delay:null,flow_delta:null,density_delta:null,speed_delta:null,delay_delta:null,flow_pct_delta:null,density_pct_delta:null,flow_density_product_delta:null,cmp_flow_sign:"unknown",cmp_flow_density_quadrant:"unknown"} as ComparisonRow;
    const c=f.geometry?.coordinates;
    if(!Array.isArray(c)||f.geometry?.type!=="LineString")return [];
    const value=row[settings.metric];
    if(threshold>0&&!passesComparisonDifferenceFilter(settings.metric,value,row.flow_delta,row.density_delta,threshold))return [];
    const ring=bufferLineToRing(c as [number,number][],Number(p.total_width)||6);
    if(!ring||!validRing(ring))return [];
    const numericValue=value===null||value===undefined?Number.NaN:Number(value);
    const midpoint=numericDifference&&Number.isFinite(numericValue)?lineMidpoint(c as [number,number][]):null;
    if(midpoint&&Number.isFinite(numericValue)){
      const base=settings.metric.replace("_delta","") as NetworkKpiMetric;
      const elevation=settings.extruded?elevationByKpi(Math.abs(numericValue),base,settings.maxHeightM)+2:0;
      const text=formatRoundedDifference(numericValue);
      labels.push({position:midpoint,elevation,text,priority:Math.abs(numericValue),widthPx:text.length*9+12});
    }
    return [{ring,row}];
  });
  const layer=new deck.layers.PolygonLayer({id:"scenario-comparison-diff",data,getPolygon:(d:{ring:[number,number][]})=>d.ring,getFillColor:(d:{row:ComparisonRow})=>color(d.row),getElevation:(d:{row:ComparisonRow})=>{if(!settings.extruded)return 0;const base=settings.metric.replace("_delta","") as NetworkKpiMetric;const value=Number(d.row[settings.metric]);return Number.isFinite(value)?elevationByKpi(Math.abs(value),base,settings.maxHeightM):0;},extruded:settings.extruded,opacity:settings.opacity,pickable:true,updateTriggers:{getFillColor:[settings.metric,settings.opacity,settings.differenceThreshold,rows],getElevation:[settings.metric,settings.maxHeightM,settings.extruded,settings.differenceThreshold,rows]},...depthOcclusionParameters(settings.seeThroughBuildings)});
  const map=appRef?.getMap?.() as any;
  const visibleLabels=map?.project?declutterMapLabels(labels,(position)=>map.project(position.slice(0,2)),48):labels;
  const labelLayer=visibleLabels.length?new deck.layers.TextLayer({
    id:"scenario-comparison-diff-labels",
    data:visibleLabels,
    getPosition:(d:{position:[number,number];elevation:number})=>[d.position[0],d.position[1],d.elevation],
    getText:(d:{text:string})=>d.text,
    getSize:14,
    sizeUnits:"pixels",
    getColor:[15,35,58,255],
    opacity:settings.opacity,
    background:true,
    getBackgroundColor:[255,255,255,Math.round(238*settings.opacity)],
    getBorderColor:[24,52,80,190],
    getBorderWidth:1,
    backgroundPadding:[4,2],
    backgroundBorderRadius:3,
    billboard:true,
    pickable:false,
    ...depthOcclusionParameters(settings.seeThroughBuildings),
    updateTriggers:{getText:[settings.metric,settings.differenceThreshold,rows]},
  }):null;
  setSharedDeckLayers("scenario-comparison",[layer,labelLayer].filter(Boolean) as Layer[]);
}
export function reattachScenarioComparison(app:GeoLibreAppAPI):void{appRef=app;if(visible)openScenarioComparisonPanel(app);}
export const maplibreScenarioComparisonPlugin:GeoLibrePlugin={id:SCENARIO_COMPARISON_PLUGIN_ID,name:"Scenario comparison",version:"1.0.0",activeByDefault:false,activate:openScenarioComparisonPanel,deactivate:closeScenarioComparisonPanel,getProjectState:()=>visible?{open:true,...settings}:undefined,applyProjectState:(app,state)=>{if((state as {open?:boolean})?.open)openScenarioComparisonPanel(app);}};
export { comparisonCategoricalRamp };
