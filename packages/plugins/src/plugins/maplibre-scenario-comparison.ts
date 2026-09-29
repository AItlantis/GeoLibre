import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibrePlugin } from "../types";
import { useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import { depthOcclusionParameters, ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import { buildScenarioComparisonRows, defaultScenarioComparisonPair, type ComparisonInput, type ComparisonRow } from "./scenario-comparison-data";
import { COMPARISON_CONTINUOUS_RAMPS, comparisonCategoricalRamp, comparisonDifferenceColor, comparisonThresholdDefault, isComparisonDifferenceMetric, isComparisonMetric, type ComparisonMetric } from "./comparison-ramps";
import { matchScenarioIntervals, type MatchedScenarioInterval } from "./scenario-comparison-timeline";
import { createNetworkKpiDirectorySource, createNetworkKpiHttpSource, fetchNetworkKpiManifestJson, laneKey, loadNetworkKpiGeometry, parseNetworkKpiManifest, readLocalNetworkKpiManifestJson, type NetworkKpiDirectoryHandle, type NetworkKpiGeometry, type NetworkKpiPackageSource, type NetworkKpiResults } from "./network-kpi-data";
import { supportsLocalPackageFolders } from "./vehicle-playback-data";
import { bufferLineToRing } from "./network-kpi-geometry";
import { listVehicleManifestScenarios, type VehicleManifestScenario } from "./vehicle-playback-data";
import { openTestudoDatasetProvider, type TestudoDatasetProvider, type TestudoDatasetQueryResult } from "./testudo-dataset-provider";
import type { GeolibreReplication } from "./geolibre-package-loader";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";
import { createIntervalPlaybackController, stepInterval } from "../shared/useIntervalPlayback";
import { elevationByKpi, KPI_RAMPS, type NetworkKpiMetric } from "./network-kpi-ramps";
import { readSimulationTimeline, type SimulationTimeline } from "../shared/simulation-timeline";
import { declutterMapLabels, formatRoundedDifference, lineMidpoint, passesComparisonDifferenceFilter } from "../shared/map-labels";
export const SCENARIO_COMPARISON_CONTINUOUS_RAMPS = COMPARISON_CONTINUOUS_RAMPS;
export const SCENARIO_COMPARISON_PLUGIN_ID = "geolibre-scenario-comparison";
export const SCENARIO_COMPARISON_STORE_LAYER_ID = "geolibre-scenario-comparison-layer";
export interface ScenarioComparisonSettings { manifestUrl: string | null; scenarioA: number; scenarioB: number; didA: number | null; didB: number | null; mode: "side-by-side" | "diff"; metric: ComparisonMetric; differenceThreshold: number; flowDifferenceScale: number; extruded: boolean; maxHeightM: number; interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean; opacity: number; seeThroughBuildings: boolean; }
export interface ScenarioComparisonStatus { loading: boolean; error: string|null; timeMatchReason: "missing-timeline" | "period-mismatch" | "no-matching-times" | null; aggregateAvailable: boolean; currentTimeSeconds: number | null; scenarios: VehicleManifestScenario[]; intervals: number[]; matchedIntervals: MatchedScenarioInterval[]; timelineA?: SimulationTimeline|null; timelineB?: SimulationTimeline|null; replicationsA: GeolibreReplication[]; replicationsB: GeolibreReplication[]; sectionsA: number; sectionsB: number; lanesA: number; lanesB: number; turnsA: number; turnsB: number; }
export const DEFAULT_SCENARIO_COMPARISON_SETTINGS: ScenarioComparisonSettings = {manifestUrl:null,scenarioA:0,scenarioB:0,didA:null,didB:null,mode:"diff",metric:"flow_delta",differenceThreshold:comparisonThresholdDefault("flow_delta"),flowDifferenceScale:COMPARISON_CONTINUOUS_RAMPS.flow_delta.domainMax,extruded:false,maxHeightM:10,interval:0,intervalPlaying:false,playbackSpeed:1,loop:true,opacity:.85,seeThroughBuildings:true};
let settings={...DEFAULT_SCENARIO_COMPARISON_SETTINGS}, visible=false, layerVisible=true; const listeners=new Set<()=>void>(); let rows: ComparisonRow[]=[]; let geometry:NetworkKpiGeometry|null=null; let geometryB:NetworkKpiGeometry|null=null; let datasetA:NetworkKpiGeometry|null=null; let datasetB:NetworkKpiGeometry|null=null; let provider:TestudoDatasetProvider|null=null; let appRef:GeoLibreAppAPI|null=null; let deck:GeoLibreDeckGL|null=null; let loadToken=0; let readToken=0; let geometryReadToken=0; let intervals:number[]=[]; let matchedIntervals:MatchedScenarioInterval[]=[]; let labelMapMoveBound=false; const playback=createIntervalPlaybackController(()=>stepScenarioComparisonInterval(1)); let status:ScenarioComparisonStatus={loading:false,error:null,timeMatchReason:null,aggregateAvailable:false,currentTimeSeconds:null,scenarios:[],intervals:[],matchedIntervals:[],replicationsA:[],replicationsB:[],sectionsA:0,sectionsB:0,lanesA:0,lanesB:0,turnsA:0,turnsB:0};
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
export function setScenarioComparisonSettings(next:Partial<ScenarioComparisonSettings>){
 const metricChanged=next.metric!==undefined&&next.metric!==settings.metric;
 const modeChanged=next.mode!==undefined&&next.mode!==settings.mode;
 const scenarioAChanged=next.scenarioA!==undefined&&next.scenarioA!==settings.scenarioA;
 const scenarioBChanged=next.scenarioB!==undefined&&next.scenarioB!==settings.scenarioB;
 const selectionChanged=next.interval!==undefined||next.didA!==undefined||next.didB!==undefined||scenarioAChanged||scenarioBChanged;
 settings={...settings,...next};
 if(metricChanged&&next.differenceThreshold===undefined)settings={...settings,differenceThreshold:comparisonThresholdDefault(settings.metric)};
 if(provider&&(next.scenarioA!==undefined||next.scenarioB!==undefined))updateReplications(provider);
 if(modeChanged){if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else{disableSideBySide();if(layerVisible)render();}}
 if(metricChanged&&settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}
 if(scenarioAChanged||scenarioBChanged)void reloadScenarioGeometry(scenarioAChanged,scenarioBChanged);
 if(selectionChanged){status={...status,loading:true};rows=[];setSharedDeckLayers("scenario-comparison",[]);void readCurrent();}
 else if(metricChanged||next.differenceThreshold!==undefined||next.flowDifferenceScale!==undefined||next.extruded!==undefined||next.maxHeightM!==undefined||next.opacity!==undefined||next.seeThroughBuildings!==undefined){
  if(settings.mode==="diff"&&layerVisible)render();
  else if(settings.mode==="diff")setSharedDeckLayers("scenario-comparison",[]);
 }
 notify();
}
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
function enableSideBySide(){if(!appRef||!datasetA?.sections)return;const store=useAppStore.getState();store.setMapGrid(1,2);const pane=store.secondaryMapViews.at(-1);if(!pane){setTimeout(enableSideBySide,100);return;}sidePaneId=pane.id;store.setSecondaryMapLabel(pane.id,replicationLabel(settings.scenarioB,settings.didB,"Compared"));const metric=settings.metric==="flow"||settings.metric==="density"||settings.metric==="speed"?settings.metric:"flow";const ramp=KPI_RAMPS[metric];const style={strokeColor:"#64748b",strokeWidth:2,fillOpacity:.85,vectorStyleMode:"graduated" as const,vectorStyleProperty:`comparison_${metric}`,vectorStyleClassCount:5,vectorStyleStops:ramp.stops.map((value,index)=>({value,color:ramp.colors[index]}))};const a=appRef.addGeoJsonLayer(replicationLabel(settings.scenarioA,settings.didA,"Reference"),datasetA.sections as never);store.setLayerStyle(a,style);if(!datasetB?.sections){console.warn("[GeoLibre] scenario-comparison: Compared dataset genuinely failed to load; showing only Reference");sideLayerIds=[a];return;}const b=appRef.addGeoJsonLayer(replicationLabel(settings.scenarioB,settings.didB,"Compared"),datasetB.sections as never);store.setLayerStyle(b,style);sideLayerIds=[a,b];store.setSecondaryLayerVisibility(pane.id,a,false);store.setSecondaryLayerVisibility(pane.id,b,true);}
function replicationLabel(index:number,did:number|null,role:"Reference"|"Compared"):string{const replication=provider?.metadata.scenarios[index]?.replications.find(item=>item.did===did);const name=replication?.xname??replication?.didname??(did===null?"":String(did));return name?`${name} [${role}]`:role;}
function disableSideBySide(){const store=useAppStore.getState();for(const id of sideLayerIds)store.removeLayer(id);if(sidePaneId)store.removeSecondaryMapView(sidePaneId);sidePaneId=null;sideLayerIds=[];setSharedDeckLayers("scenario-comparison",[]);}
export function computeScenarioComparison(a:readonly ComparisonInput[],b:readonly ComparisonInput[]){rows=buildScenarioComparisonRows(a,b);notify();return rows;}
export function getScenarioComparisonRows(){return rows;}
export function stepScenarioComparisonInterval(direction:1|-1){const values=intervals.filter(v=>v!==0);if(values.length<2)return;const current=values.indexOf(settings.interval);const nextIndex=current<0?(direction===1?0:values.length-1):current+direction;if(!settings.loop&&(nextIndex<0||nextIndex>=values.length)){settings={...settings,intervalPlaying:false};playback.sync(false);notify();return;}const next=values[(nextIndex+values.length)%values.length];setScenarioComparisonSettings({interval:next});}
function selectDistinctInitialPair(scenarios:readonly VehicleManifestScenario[]):void{const pair=defaultScenarioComparisonPair(scenarios.map(scenario=>scenario.index),settings.scenarioA,settings.scenarioB,settings.didA,settings.didB);if(pair)settings={...settings,...pair};}
export function toggleScenarioComparisonIntervalPlaying(){settings={...settings,intervalPlaying:!settings.intervalPlaying};playback.sync(settings.intervalPlaying,Math.max(100,1000/settings.playbackSpeed));notify();}
export async function setScenarioComparisonManifestUrl(url:string){const token=++loadToken;const oldProvider=provider;provider=null;intervalCache.clear();if(oldProvider)await oldProvider.close();rows=[];intervals=[];matchedIntervals=[];setSharedDeckLayers("scenario-comparison",[]);geometry=null;geometryB=null;datasetA=null;datasetB=null;manifestRaw=null;packageSource=null;manifestBaseUrl=null;status={...status,loading:Boolean(url.trim()),error:null};notify();if(!url.trim()){settings={...settings,manifestUrl:null};status={...status,loading:false,scenarios:[],intervals:[],matchedIntervals:[],timeMatchReason:null,aggregateAvailable:false,currentTimeSeconds:null};notify();return;} settings={...settings,manifestUrl:url};try{const raw=await fetchNetworkKpiManifestJson(url);if(token!==loadToken)return;const scenarios=listVehicleManifestScenarios(raw);status={...status,scenarios};selectDistinctInitialPair(scenarios);const source=createNetworkKpiHttpSource(url);const manifestA=parseNetworkKpiManifest(raw,url,settings.scenarioA);const manifestB=parseNetworkKpiManifest(raw,url,settings.scenarioB);[geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]);if(token!==loadToken)return;manifestRaw=raw;packageSource=source;manifestBaseUrl=url;if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);provider=await openTestudoDatasetProvider({source,manifest:raw});await readCurrent(token);if(token!==loadToken)return;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();}catch(error){if(token!==loadToken)return;status={...status,loading:false,error:error instanceof Error?error.message:String(error)};notify();}}
export function canLoadLocalScenarioComparisonPackage(): boolean { return supportsLocalPackageFolders(); }
export async function loadLocalScenarioComparisonFolder(selectedDirectory?:NetworkKpiDirectoryHandle): Promise<void> { const token=++loadToken; if(!selectedDirectory&&!canLoadLocalScenarioComparisonPackage()){status={...status,error:"Local folders are not supported in this browser."};notify();return;} const oldProvider=provider;provider=null;intervalCache.clear();if(oldProvider)await oldProvider.close(); rows=[];intervals=[];matchedIntervals=[];setSharedDeckLayers("scenario-comparison",[]);geometry=null;geometryB=null;datasetA=null;datasetB=null; manifestRaw=null;packageSource=null;manifestBaseUrl=null; status={...status,loading:true,error:null};notify(); try { const root=selectedDirectory??await(window as any).showDirectoryPicker() as NetworkKpiDirectoryHandle; if(token!==loadToken)return; const raw=await readLocalNetworkKpiManifestJson(root); if(token!==loadToken)return; const scenarios=listVehicleManifestScenarios(raw);status={...status,scenarios};selectDistinctInitialPair(scenarios); const source=createNetworkKpiDirectorySource(root); const manifestA=parseNetworkKpiManifest(raw,null,settings.scenarioA); const manifestB=parseNetworkKpiManifest(raw,null,settings.scenarioB); [geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]); if(token!==loadToken)return; manifestRaw=raw;packageSource=source;manifestBaseUrl=null; if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);provider=await openTestudoDatasetProvider({source,manifest:raw});await readCurrent(token);if(token!==loadToken)return; if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render(); notify(); } catch(error) { if(token!==loadToken)return; const cancelled=error instanceof Error&&error.name==="AbortError"; status={...status,loading:false,error:cancelled?null:error instanceof Error?error.message:String(error)}; notify(); } }
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
async function availableIntervals(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number}):Promise<number[]>{const key=`${String(selection.scenarioId??"")}:${String(selection.did??"")}`;const cached=intervalCache.get(key);if(cached)return cached;const result=await dataset.query({dataset:"MISECT",...selection,columns:["ent"],distinct:true,filters:[{column:"sid",op:"=",value:0}],limit:COMPARISON_ROW_LIMIT});if(result.truncated)throw new Error("Scenario comparison interval discovery exceeded its bounded query limit.");const values=[...new Set(result.rows.map(row=>finite(row.ent)).filter((value):value is number=>value!==null))].sort((a,b)=>a-b);intervalCache.set(key,values);return values;}

function emptyKpi(did:number|null,interval:number,intervals:number[]):NetworkKpiResults{return {sections:new Map(),lanes:new Map(),intervals,sids:[0],dids:did===null?[]:[did],did,sid:0,interval};}
async function readKpi(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number},requestedInterval:number):Promise<NetworkKpiResults>{const values=await availableIntervals(dataset,selection);if(!values.includes(requestedInterval))throw new Error(`Requested comparison interval ${requestedInterval} is unavailable.`);const interval=requestedInterval;const filters=[{column:"sid" as const,op:"=" as const,value:0},{column:"ent" as const,op:"=" as const,value:interval}];const sections=await dataset.query({dataset:"MISECT",...selection,columns:SECTION_KPI_COLUMNS,filters,limit:COMPARISON_ROW_LIMIT});if(sections.truncated)throw new Error("Scenario comparison section KPI query exceeded its bounded query limit.");let lanes:TestudoDatasetQueryResult={rows:[],columns:[],rowCount:0,truncated:false,source:sections.source,dataset:"MILANE",did:sections.did,scenarioId:sections.scenarioId,warnings:sections.warnings};try{lanes=await dataset.query({dataset:"MILANE",...selection,columns:LANE_KPI_COLUMNS,filters,limit:COMPARISON_ROW_LIMIT});if(lanes.truncated)throw new Error("Scenario comparison lane KPI query exceeded its bounded query limit.");}catch(error){if(error instanceof Error&&error.message.includes("exceeded its bounded query limit"))throw error;/* MILANE is optional for packages containing section KPIs only. */}const result=emptyKpi(selection.did??sections.did??null,interval,values);for(const row of sections.rows){const oid=finite(row.oid);if(oid===null)continue;result.sections.set(oid,{flow:usable(row.flow),speed:usable(row.speed),density:usable(row.density),delay:usable(row.dtime)});}for(const row of lanes.rows){const oid=finite(row.oid);const lane=finite(row.lane);if(oid===null||lane===null)continue;result.lanes.set(laneKey(oid,lane-1),{flow:usable(row.flow),speed:usable(row.speed),density:usable(row.density),delay:usable(row.dtime)});}result.did=sections.did??selection.did??null;return result;}
async function readCurrent(parentToken=loadToken){if(!provider)return;const dataset=provider;const token=++readToken;const selectionA=scenarioSelection(dataset,settings.scenarioA,settings.didA);const selectionB=scenarioSelection(dataset,settings.scenarioB,settings.didB);try{
 const [intervalsA,intervalsB,timelineA,timelineB]=await Promise.all([availableIntervals(dataset,selectionA),availableIntervals(dataset,selectionB),readSimulationTimeline(dataset,selectionA),readSimulationTimeline(dataset,selectionB)]);
 if(token!==readToken||parentToken!==loadToken)return;
 const match=matchScenarioIntervals(intervalsA,timelineA,intervalsB,timelineB);matchedIntervals=match.intervals;intervals=match.intervals.map(item=>item.entA);
 const aggregate=match.aggregateAvailable&&settings.interval===0;
 const selected=aggregate?null:(match.intervals.find(item=>item.entA===settings.interval)??match.intervals[0]??null);
 status={...status,loading:false,error:null,timeMatchReason:match.reason,aggregateAvailable:match.aggregateAvailable,currentTimeSeconds:aggregate?null:selected?.timeSeconds??null,matchedIntervals:match.intervals,intervals,timelineA,timelineB};
 if(!aggregate&&!selected){settings={...settings,interval:0,intervalPlaying:false};playback.sync(false);rows=[];datasetA=null;datasetB=null;setSharedDeckLayers("scenario-comparison",[]);if(settings.mode==="side-by-side")disableSideBySide();status={...status,sectionsA:0,sectionsB:0,lanesA:0,lanesB:0};notify();return;}
 const entA=aggregate?0:selected!.entA;const entB=aggregate?0:selected!.entB;
 const [a,b]=await Promise.all([readKpi(dataset,selectionA,entA),readKpi(dataset,selectionB,entB)]);
 if(token!==readToken||parentToken!==loadToken)return;
 intervals=match.intervals.map(item=>item.entA);
 status={...status,loading:false,error:null,intervals,matchedIntervals:match.intervals,timeMatchReason:null,aggregateAvailable:match.aggregateAvailable,currentTimeSeconds:aggregate?null:selected!.timeSeconds,sectionsA:a.sections.size||geometry?.sections?.features.length||0,sectionsB:b.sections.size||geometryB?.sections?.features.length||0,lanesA:a.lanes.size||geometry?.lanes?.features.length||0,lanesB:b.lanes.size||geometryB?.lanes?.features.length||0,turnsA:geometry?.turns?.features.length??0,turnsB:geometryB?.turns?.features.length??0};
 if(settings.didA!==a.did||settings.didB!==b.did)settings={...settings,didA:a.did,didB:b.did};settings={...settings,interval:aggregate?0:entA};
 datasetA=geometry?withKpiData(geometry,a):null;datasetB=geometryB?withKpiData(geometryB,b):null;rows=buildScenarioComparisonRows(inputs(a),inputs(b));if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();
 }catch(error){if(token!==readToken||parentToken!==loadToken)return;status={...status,loading:false,error:error instanceof Error?error.message:String(error)};rows=[];setSharedDeckLayers("scenario-comparison",[]);notify();}}

function color(row:ComparisonRow):[number,number,number,number]{const value=row[settings.metric];const alpha=Math.round(settings.opacity*255);if(value===null||value===undefined)return [136,136,136,alpha];if(isComparisonDifferenceMetric(settings.metric)){const rgb=comparisonDifferenceColor(settings.metric,Number(value),settings.flowDifferenceScale);return [...rgb,alpha];}const cat=comparisonCategoricalRamp(settings.metric)?.categories.find(c=>c.key===value);const h=(cat?.color??"#888888").replace("#","");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),alpha];}
function validRing(ring:readonly [number,number][]):boolean{return ring.length>=3&&ring.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y));}
function render(){
  if(!deck)return;
  if(!geometry||settings.mode!=="diff"){setSharedDeckLayers("scenario-comparison",[]);return;}
  if(!visible||!layerVisible){setSharedDeckLayers("scenario-comparison",[]);return;}
  const rowsByKey=new Map(rows.map(row=>[String(row.key),row]));
  const numericDifference=isComparisonDifferenceMetric(settings.metric);
  const threshold=Math.max(0,settings.differenceThreshold??comparisonThresholdDefault(settings.metric));
  const labels:Array<{position:[number,number];elevation:number;text:string;priority:number;widthPx:number}> = [];
  const features=geometry.sections?.features??[];
  const matchingGeometry=new Set((geometryB?.sections?.features??[]).map(feature=>String(Number(feature.properties?.section_id??feature.properties?.oid))));
  const data=features.flatMap(f=>{
    const p=f.properties??{};
    const key=Number(p.section_id??p.oid);
    const row=rowsByKey.get(String(key));
    if(!row||!row.hasReference||!row.hasCompared||!matchingGeometry.has(String(key)))return [];
    const c=f.geometry?.coordinates;
    if(!Array.isArray(c)||f.geometry?.type!=="LineString")return [];
    const value=row[settings.metric];
    if(isComparisonDifferenceMetric(settings.metric)&&threshold>0&&!passesComparisonDifferenceFilter(settings.metric,value,row.flow_delta,row.density_delta,threshold))return [];
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
  const layer=new deck.layers.PolygonLayer({id:"scenario-comparison-diff",data,getPolygon:(d:{ring:[number,number][]})=>d.ring,getFillColor:(d:{row:ComparisonRow})=>color(d.row),getElevation:(d:{row:ComparisonRow})=>{if(!settings.extruded)return 0;const base=settings.metric.replace("_delta","") as NetworkKpiMetric;const value=Number(d.row[settings.metric]);return Number.isFinite(value)?elevationByKpi(Math.abs(value),base,settings.maxHeightM):0;},extruded:settings.extruded,opacity:settings.opacity,pickable:true,updateTriggers:{getFillColor:[settings.metric,settings.opacity,settings.differenceThreshold,settings.flowDifferenceScale,rows],getElevation:[settings.metric,settings.maxHeightM,settings.extruded,settings.differenceThreshold,rows]},...depthOcclusionParameters(settings.seeThroughBuildings)});
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
export const maplibreScenarioComparisonPlugin:GeoLibrePlugin={id:SCENARIO_COMPARISON_PLUGIN_ID,name:"Scenario comparison",version:"1.0.0",activeByDefault:false,activate:openScenarioComparisonPanel,deactivate:closeScenarioComparisonPanel,getProjectState:()=>visible?{open:true,...settings}:undefined,applyProjectState:(app,state)=>{const {open,...saved}=state as Partial<ScenarioComparisonSettings>&{open?:boolean};if(!open)return;openScenarioComparisonPanel(app);const metric=saved.metric===undefined?settings.metric:isComparisonMetric(saved.metric)?saved.metric:(saved.mode??settings.mode)==="side-by-side"?"flow":"flow_delta";const scale=finite(saved.flowDifferenceScale);setScenarioComparisonSettings({...saved,metric,flowDifferenceScale:scale===null?settings.flowDifferenceScale:Math.max(10,Math.min(2000,scale))});if(saved.manifestUrl)void setScenarioComparisonManifestUrl(saved.manifestUrl);}};
export { comparisonCategoricalRamp };
