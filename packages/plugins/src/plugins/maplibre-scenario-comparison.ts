import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibrePlugin } from "../types";
import { useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import { depthOcclusionParameters, ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import { buildScenarioComparisonRows, defaultScenarioComparisonPair, scenarioComparisonMetricDelta, type ComparisonInput, type ComparisonRow } from "./scenario-comparison-data";
import { COMPARISON_CONTINUOUS_RAMPS, comparisonCategoricalRamp, comparisonDifferenceColor, comparisonThresholdDefault, isComparisonDifferenceMetric, isComparisonMetric, type ComparisonMetric } from "./comparison-ramps";
import { matchScenarioIntervals, type MatchedScenarioInterval } from "./scenario-comparison-timeline";
import { aggregateNetworkKpiDashboardSeries, createNetworkKpiDirectorySource, createNetworkKpiHttpSource, fetchNetworkKpiManifestJson, laneKey, loadNetworkKpiGeometry, networkSectionLengthKm, parseNetworkKpiManifest, readLocalNetworkKpiManifestJson, type NetworkFeatureCollection, type NetworkKpiDashboardScope, type NetworkKpiDashboardSeries, type NetworkKpiDirectoryHandle, type NetworkKpiGeometry, type NetworkKpiPackageSource, type NetworkKpiResults, type NetworkKpiSectionSeries } from "./network-kpi-data";
import { supportsLocalPackageFolders } from "./vehicle-playback-data";
import { listVehicleManifestScenarios, type VehicleManifestScenario } from "./vehicle-playback-data";
import { openTestudoDatasetProvider, type TestudoDatasetProvider, type TestudoDatasetQueryResult } from "./testudo-dataset-provider";
import type { GeolibreReplication } from "./geolibre-package-loader";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";
import { createIntervalPlaybackController, stepInterval } from "../shared/useIntervalPlayback";
import { assertScenarioSelectionSucceeded } from "../shared/scenario-selection";
import { boundedFingerprint, liveIdentityState, testudoLiveDiagnosticsEnabled } from "../shared/testudo-live-diagnostics";
import { installOpenedResourceIfCurrent } from "../shared/opened-resource";
import { activeRamp, elevationByKpi, LOD_ZOOM_THRESHOLD, type NetworkKpiMetric } from "./network-kpi-ramps";
import { getNetworkKpiSnapshot } from "./maplibre-network-kpi";
import { buildLaneGeometryRows, buildSectionGeometryRows } from "./network-kpi-geometry";
import { readSimulationTimeline, type SimulationTimeline } from "../shared/simulation-timeline";
import { declutterMapLabels, formatRoundedDifference, lineMidpoint, passesComparisonDifferenceFilter } from "../shared/map-labels";
import { mountTestudoComparisonGeometry } from "../shared/testudo-persistent-network";
import type { TestudoMapHandle } from "../shared/testudo-feature-session";
export const SCENARIO_COMPARISON_CONTINUOUS_RAMPS = COMPARISON_CONTINUOUS_RAMPS;
export const SCENARIO_COMPARISON_PLUGIN_ID = "geolibre-scenario-comparison";
export const SCENARIO_COMPARISON_STORE_LAYER_ID = "geolibre-scenario-comparison-layer";
export interface ScenarioComparisonSettings { manifestUrl: string | null; scenarioA: number; scenarioB: number; didA: number | null; didB: number | null; mode: "side-by-side" | "diff"; metric: ComparisonMetric; differenceThreshold: number; flowDifferenceScale: number; extruded: boolean; maxHeightM: number; interval: number; intervalPlaying: boolean; playbackSpeed: number; loop: boolean; opacity: number; seeThroughBuildings: boolean; }
export interface ScenarioComparisonStatus { loading: boolean; error: string|null; timeMatchReason: "missing-timeline" | "period-mismatch" | "no-matching-times" | null; aggregateAvailable: boolean; currentTimeSeconds: number | null; scenarios: VehicleManifestScenario[]; intervals: number[]; matchedIntervals: MatchedScenarioInterval[]; timelineA?: SimulationTimeline|null; timelineB?: SimulationTimeline|null; replicationsA: GeolibreReplication[]; replicationsB: GeolibreReplication[]; sectionsA: number; sectionsB: number; lanesA: number; lanesB: number; turnsA: number; turnsB: number; }
export interface ScenarioComparisonDashboardEntity { kind: "section" | "lane" | "turn"; id: number; sectionId: number; laneIndex?: number; turnId?: number; name: string; }
export interface ScenarioComparisonDashboardSide { label: string; scenarioId: string | number | null; did: number | null; replicationLabel: string | null; }
export interface ScenarioComparisonDashboardValue { flow: number | null; density: number | null; speed: number | null; delay: number | null; available: boolean; source: "entity" | "section-fallback" | "aggregate" | "missing"; }
export interface ScenarioComparisonDashboardSample { timeSeconds: number; intervalA: number; intervalB: number; scenarioA: ScenarioComparisonDashboardValue; scenarioB: ScenarioComparisonDashboardValue; delta: { flow: number | null; density: number | null; speed: number | null; delay: number | null; }; }
export interface ScenarioComparisonDashboardSnapshot { scope: NetworkKpiDashboardScope; selectedEntity: ScenarioComparisonDashboardEntity | null; loading: boolean; error: string | null; scenarioA: ScenarioComparisonDashboardSide; scenarioB: ScenarioComparisonDashboardSide; currentTimeSeconds: number | null; samples: ScenarioComparisonDashboardSample[]; seriesA: NetworkKpiDashboardSeries | null; seriesB: NetworkKpiDashboardSeries | null; }
export const DEFAULT_SCENARIO_COMPARISON_SETTINGS: ScenarioComparisonSettings = {manifestUrl:null,scenarioA:0,scenarioB:0,didA:null,didB:null,mode:"diff",metric:"flow_delta",differenceThreshold:comparisonThresholdDefault("flow_delta"),flowDifferenceScale:COMPARISON_CONTINUOUS_RAMPS.flow_delta.domainMax,extruded:false,maxHeightM:10,interval:0,intervalPlaying:false,playbackSpeed:1,loop:true,opacity:.85,seeThroughBuildings:true};
let settings={...DEFAULT_SCENARIO_COMPARISON_SETTINGS}, visible=false, layerVisible=true; const listeners=new Set<()=>void>(); let rows: ComparisonRow[]=[]; let geometry:NetworkKpiGeometry|null=null; let geometryB:NetworkKpiGeometry|null=null; let datasetA:NetworkKpiGeometry|null=null; let datasetB:NetworkKpiGeometry|null=null; let provider:TestudoDatasetProvider|null=null; let appRef:GeoLibreAppAPI|null=null; let deck:GeoLibreDeckGL|null=null; let loadToken=0; let readToken=0; let geometryReadToken=0; let intervals:number[]=[]; let matchedIntervals:MatchedScenarioInterval[]=[]; let labelMapMoveBound=false; const playback=createIntervalPlaybackController(()=>stepScenarioComparisonInterval(1)); let status:ScenarioComparisonStatus={loading:false,error:null,timeMatchReason:null,aggregateAvailable:false,currentTimeSeconds:null,scenarios:[],intervals:[],matchedIntervals:[],replicationsA:[],replicationsB:[],sectionsA:0,sectionsB:0,lanesA:0,lanesB:0,turnsA:0,turnsB:0};
const dashboardListeners=new Set<()=>void>();let dashboardReadToken=0;let dashboardGeneration=0;
const EMPTY_COMPARISON_DASHBOARD:ScenarioComparisonDashboardSnapshot={scope:"viewport",selectedEntity:null,loading:false,error:null,scenarioA:{label:"Reference",scenarioId:null,did:null,replicationLabel:null},scenarioB:{label:"Compared",scenarioId:null,did:null,replicationLabel:null},currentTimeSeconds:null,samples:[],seriesA:null,seriesB:null};
let dashboardState:ScenarioComparisonDashboardSnapshot={...EMPTY_COMPARISON_DASHBOARD};
let geometryEpsgA:number|null=null;let geometryEpsgB:number|null=null;
let committedComparisonIdentity: { scenarioA: { scid: string | number | null; did: number | null; interval: number; sampleCount: number; sampleFingerprint: string | null }; scenarioB: { scid: string | number | null; did: number | null; interval: number; sampleCount: number; sampleFingerprint: string | null }; sampleCount: number; sampleFingerprint: string } | null = null;
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
let sidePrimarySectionLayerId:string|null=null;let sidePrimaryLaneLayerId:string|null=null;
let sideSecondarySectionLayerId:string|null=null;let sideSecondaryLaneLayerId:string|null=null;
let sidePrimaryHasLaneRows=false;let sideSecondaryHasLaneRows=false;
let sidePrimaryZoomHandler:(()=>void)|null=null;let sideSecondaryZoomHandler:(()=>void)|null=null;
let sidePrimaryZoomMap:any=null;let sideSecondaryZoomMap:any=null;
let sideSecondaryClickMap:any=null;let sideSecondaryClickHandler:((event:any)=>void)|null=null;
let sidePrimaryGeometryDispose:(()=>void)|null=null; let sideSecondaryGeometryDispose:(()=>void)|null=null;
let sideSecondaryMap:TestudoMapHandle|null=null; let comparisonMapEventsBound=false;
let sideBySideLifecycle=0; let sideBySideRetryTimer:ReturnType<typeof setTimeout>|null=null;
const onComparisonMapReady=(event:Event)=>{const detail=(event as CustomEvent<{viewId?:unknown;map?:unknown}>).detail;if(typeof detail?.viewId!=="string"||detail.viewId!==sidePaneId||!detail.map)return;sideSecondaryGeometryDispose?.();sideSecondaryMap=detail.map as TestudoMapHandle;syncComparisonMapGeneration(sideSecondaryMap);sideSecondaryGeometryDispose=mountTestudoComparisonGeometry(sideSecondaryMap,geometryB,`testudo-comparison-${detail.viewId}`);bindSideBySideZoomHandlers();bindSideBySideSelection();};
const onComparisonMapDisposed=(event:Event)=>{const detail=(event as CustomEvent<{viewId?:unknown;map?:unknown}>).detail;if(detail?.viewId===sidePaneId&&detail.map===sideSecondaryMap){const store=useAppStore.getState();if(store.comparisonMapPresentation?.owner==="scenario-comparison"&&store.comparisonMapPresentation.secondaryPaneId===sidePaneId)store.setComparisonMapPresentation(null);unbindSideBySideZoomHandlers();unbindSideBySideSelection();sideSecondaryGeometryDispose?.();sideSecondaryGeometryDispose=null;sideSecondaryMap=null;}};
function syncComparisonMapGeneration(map:unknown):void{const primary=appRef?.getMap?.() as any;const generation=primary?.__testudoGeneration;if(map&&Number.isSafeInteger(generation)&&generation>0)(map as any).__testudoGeneration=generation;}
function bindSideBySideSelection():void{
 unbindSideBySideSelection();const map=sideSecondaryMap as any;if(!map?.on||!map?.queryRenderedFeatures)return;
 sideSecondaryClickMap=map;sideSecondaryClickHandler=(event:any)=>{syncComparisonMapGeneration(map);const generation=map.__testudoGeneration;if(!Number.isSafeInteger(generation)||generation<1)return;const layers=[`testudo-comparison-${sidePaneId}-turns`,`testudo-comparison-${sidePaneId}-lanes`,`testudo-comparison-${sidePaneId}-sections`].filter(id=>map.getLayer?.(id));if(!layers.length)return;let features:any[]=[];try{features=map.queryRenderedFeatures(event.point,{layers});}catch{return;}const feature=features[0];if(!feature)return;const layerId=String(feature.layer?.id??"");const kind=layerId.endsWith("-turns")?"turn":layerId.endsWith("-lanes")?"lane":"section";const properties=feature.properties??{};const sectionId=properties.section_id??properties.sectionId??(kind==="section"?properties.oid??properties.id:undefined);const laneIndex=properties.lane_index??properties.laneIndex;const turnId=properties.turn_id??properties.turnId??properties.oid??properties.id;const featureId=kind==="turn"?turnId:kind==="lane"?properties.oid??properties.id:sectionId;window.dispatchEvent(new CustomEvent("testudo-network-feature-selected",{detail:{map,generation,kind,featureId,sectionId,laneIndex,turnId,properties,lngLat:event.lngLat,ctrlKey:Boolean(event.originalEvent?.ctrlKey),shiftKey:Boolean(event.originalEvent?.shiftKey)}}));};map.on("click",sideSecondaryClickHandler);
}
function unbindSideBySideSelection():void{if(sideSecondaryClickMap&&sideSecondaryClickHandler)sideSecondaryClickMap.off?.("click",sideSecondaryClickHandler);sideSecondaryClickMap=null;sideSecondaryClickHandler=null;}
function bindComparisonMapEvents(){if(comparisonMapEventsBound)return;window.addEventListener("testudo-comparison-map-ready",onComparisonMapReady);window.addEventListener("testudo-comparison-map-disposed",onComparisonMapDisposed);window.addEventListener("testudo-network-feature-selected",onNetworkFeatureSelected);comparisonMapEventsBound=true;}
function unbindComparisonMapEvents(){if(!comparisonMapEventsBound)return;window.removeEventListener("testudo-comparison-map-ready",onComparisonMapReady);window.removeEventListener("testudo-comparison-map-disposed",onComparisonMapDisposed);window.removeEventListener("testudo-network-feature-selected",onNetworkFeatureSelected);comparisonMapEventsBound=false;}
function applySideBySideLodVisibility():void{
 const store=useAppStore.getState();
 const primaryZoom=(appRef?.getMap?.() as TestudoMapHandle|null|undefined)?.getZoom?.()??0;
 const secondaryZoom=sideSecondaryMap?.getZoom?.()??0;
 const primaryUsesLanes=primaryZoom>=LOD_ZOOM_THRESHOLD&&sidePrimaryHasLaneRows;
 const secondaryUsesLanes=secondaryZoom>=LOD_ZOOM_THRESHOLD&&sideSecondaryHasLaneRows;
 if(sidePrimarySectionLayerId)store.setLayerVisibility(sidePrimarySectionLayerId,layerVisible&&!primaryUsesLanes);
 if(sidePrimaryLaneLayerId)store.setLayerVisibility(sidePrimaryLaneLayerId,layerVisible&&primaryUsesLanes);
 if(sidePaneId&&sideSecondarySectionLayerId)store.setSecondaryLayerVisibility(sidePaneId,sideSecondarySectionLayerId,layerVisible&&!secondaryUsesLanes);
 if(sidePaneId&&sideSecondaryLaneLayerId)store.setSecondaryLayerVisibility(sidePaneId,sideSecondaryLaneLayerId,layerVisible&&secondaryUsesLanes);
}
function unbindSideBySideZoomHandlers():void{
 if(sidePrimaryZoomMap&&sidePrimaryZoomHandler)sidePrimaryZoomMap.off?.("zoomend",sidePrimaryZoomHandler);
 if(sideSecondaryZoomMap&&sideSecondaryZoomHandler)sideSecondaryZoomMap.off?.("zoomend",sideSecondaryZoomHandler);
 sidePrimaryZoomHandler=null;sideSecondaryZoomHandler=null;
 sidePrimaryZoomMap=null;sideSecondaryZoomMap=null;
}
function bindSideBySideZoomHandlers():void{
 unbindSideBySideZoomHandlers();
 const primary=appRef?.getMap?.() as any;
 const secondary=sideSecondaryMap as any;
 if(primary?.on){sidePrimaryZoomMap=primary;sidePrimaryZoomHandler=()=>applySideBySideLodVisibility();primary.on("zoomend",sidePrimaryZoomHandler);}
 if(secondary?.on){sideSecondaryZoomMap=secondary;sideSecondaryZoomHandler=()=>applySideBySideLodVisibility();secondary.on("zoomend",sideSecondaryZoomHandler);}
 applySideBySideLodVisibility();
}
const notify=()=>listeners.forEach(f=>f());
export const getScenarioComparisonSnapshot=()=>settings; export const subscribeScenarioComparison=(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);};
export function getScenarioComparisonDashboardSnapshot():ScenarioComparisonDashboardSnapshot{return dashboardState;}
export function subscribeScenarioComparisonDashboard(listener:()=>void):()=>void{dashboardListeners.add(listener);return()=>dashboardListeners.delete(listener);}
export function setScenarioComparisonDashboardScope(scope:NetworkKpiDashboardScope):void{if(scope!=="selected"&&scope!=="viewport"&&scope!=="network"||dashboardState.scope===scope)return;dashboardState={...dashboardState,scope,samples:[],seriesA:null,seriesB:null,error:null};notifyComparisonDashboard();void refreshComparisonDashboard();}
// useSyncExternalStore requires a stable snapshot between store updates.
// Returning a newly-created object on every read can cause a render loop.
export const getScenarioComparisonStatus=()=>status; export const subscribeScenarioComparisonStatus=(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);};
export function getScenarioComparisonLiveDiagnostics() {
  const scenarioA = status.scenarios[settings.scenarioA]; const scenarioB = status.scenarios[settings.scenarioB];
  const match = matchedIntervals.find(item => item.entA === settings.interval);
  const requested = { scenarioA: { scid: scenarioA?.scid ?? null, did: settings.didA, interval: settings.interval },
    scenarioB: { scid: scenarioB?.scid ?? null, did: settings.didB, interval: match?.entB ?? settings.interval } };
  return { loading: status.loading, error: Boolean(status.error), requested, loaded: committedComparisonIdentity };
}
function comparisonSideIdentity(result:NetworkKpiResults,scid:string|number|undefined){const entries=[...result.sections.entries()].sort((a,b)=>a[0]-b[0]);return {scid:scid??null,did:result.did,interval:result.interval,sampleCount:result.sections.size,sampleFingerprint:boundedFingerprint(entries.slice(0,32).flatMap(([oid,value])=>[oid,value.flow,value.density,value.speed,value.delay]))};}
export const isScenarioComparisonPanelVisible=()=>visible; function registerScenarioComparisonStoreLayer(){appRef?.registerExternalNativeLayer?.({id:SCENARIO_COMPARISON_STORE_LAYER_ID,name:"Scenario comparison",type:"geojson",nativeLayerIds:[],paintMode:"plugin",metadata:{customLayerType:"deck.gl"},paintBridge:{setOpacity:(opacity)=>{settings={...settings,opacity};if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();},setVisibility:(next)=>{layerVisible=next;applySideBySideLodVisibility();if(next)render();else setSharedDeckLayers("scenario-comparison",[]);}}});} export function openScenarioComparisonPanel(app:GeoLibreAppAPI){appRef=app;visible=true;bindComparisonMapEvents();if(sidePaneId)bindSideBySideZoomHandlers();if(!labelMapMoveBound){const map=app.getMap?.() as any;if(map?.on){map.on("moveend",render);labelMapMoveBound=true;}}registerScenarioComparisonStoreLayer();registerDuckDbLayer({pluginId:"scenario-comparison",dispose:()=>{const closing=provider;provider=null;if(closing)void closing.close();}});if(app.getDeckGL)void app.getDeckGL().then(async d=>{deck=d;await ensureSharedDeckOverlay(app);render();notify();}).catch(error=>{console.warn("[GeoLibre] scenario-comparison: deck.gl unavailable",error);status={...status,error:error instanceof Error?error.message:String(error)};notify();});notify();}
// `provider` (a TestudoDatasetProvider, holding a DuckDB connection/worker) was
// previously only ever closed on manifest replace (setScenarioComparisonManifestUrl
// / loadLocalScenarioComparisonFolder) — closing the panel dropped the reference
// without releasing it, leaking the DuckDB instance. `deactivate` is bound
// directly to this function, so this one fix covers both the panel-close and
// plugin-deactivate paths.
export function closeScenarioComparisonPanel(_app?:GeoLibreAppAPI){committedComparisonIdentity=null;loadToken++;readToken++;geometryReadToken++;visible=false;dashboardReadToken++;dashboardState={...dashboardState,selectedEntity:null,loading:false,error:null,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();playback.dispose();settings={...settings,intervalPlaying:false};releaseDuckDbLayer("scenario-comparison");appRef?.unregisterExternalNativeLayer?.(SCENARIO_COMPARISON_STORE_LAYER_ID);disableSideBySide();unbindComparisonMapEvents();setSharedDeckLayers("scenario-comparison",[]);const closing=provider;provider=null;if(closing)void closing.close();notify();}
function updateReplications(dataset:TestudoDatasetProvider):void { status={...status,replicationsA:dataset.metadata.scenarios[settings.scenarioA]?.replications??[],replicationsB:dataset.metadata.scenarios[settings.scenarioB]?.replications??[]}; }
export async function setScenarioComparisonSettings(next:Partial<ScenarioComparisonSettings>):Promise<void>{
 const modeChanged=next.mode!==undefined&&next.mode!==settings.mode;
 const requestedMetric=next.metric;
 let nextMetric=requestedMetric??settings.metric;
 const selectedResults=modeChanged&&next.mode==="side-by-side"?getNetworkKpiSnapshot():null;
 if(modeChanged&&next.mode==="side-by-side"){
  // Results owns the base metric in side-by-side mode, even if a stale delta
  // metric was included in the mode-change request.
  nextMetric=selectedResults?.metric??getNetworkKpiSnapshot().metric;
 }else if(modeChanged&&next.mode==="diff"&&(!requestedMetric||requestedMetric===settings.metric)){
  // Returning from side-by-side should show the corresponding B - A result.
  // Categorical Results metrics have no meaningful numeric difference.
  nextMetric=isNetworkMetric(settings.metric)?`${settings.metric}_delta` as ComparisonMetric:"flow_delta";
 }
 const metricChanged=nextMetric!==settings.metric;
 const scenarioAChanged=next.scenarioA!==undefined&&next.scenarioA!==settings.scenarioA;
 const scenarioBChanged=next.scenarioB!==undefined&&next.scenarioB!==settings.scenarioB;
 const identityChanged=next.didA!==undefined||next.didB!==undefined||scenarioAChanged||scenarioBChanged;
 const selectionChanged=next.interval!==undefined||identityChanged;
 settings={...settings,...next,...(selectedResults?{
  opacity:next.opacity??selectedResults.opacity,
  extruded:next.extruded??selectedResults.extruded,
  maxHeightM:next.maxHeightM??selectedResults.maxHeightM,
}:{}),metric:nextMetric};
 if(settings.intervalPlaying&&intervals.filter(value=>value!==0).length<2)settings={...settings,intervalPlaying:false};
 if(metricChanged&&next.differenceThreshold===undefined)settings={...settings,differenceThreshold:comparisonThresholdDefault(settings.metric)};
 if(scenarioAChanged||scenarioBChanged){settings={...settings,intervalPlaying:false};playback.sync(false);}
 else if(next.intervalPlaying!==undefined||next.playbackSpeed!==undefined)playback.sync(settings.intervalPlaying,Math.max(100,1000/settings.playbackSpeed));
 if(provider&&(next.scenarioA!==undefined||next.scenarioB!==undefined))updateReplications(provider);
 if(modeChanged){if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else{disableSideBySide();if(layerVisible)render();}}
 const sidePresentationChanged=next.opacity!==undefined||next.extruded!==undefined||next.maxHeightM!==undefined;
 if(!modeChanged&&settings.mode==="side-by-side"&&(metricChanged||sidePresentationChanged)){disableSideBySide();enableSideBySide();}
 const geometryPromise=(scenarioAChanged||scenarioBChanged)?reloadScenarioGeometry(scenarioAChanged,scenarioBChanged):Promise.resolve();
 if(selectionChanged){status={...status,loading:true,error:null,...(identityChanged?{timeMatchReason:null,aggregateAvailable:false,currentTimeSeconds:null,timelineA:null,timelineB:null,intervals:[],matchedIntervals:[]}: {})};rows=[];setSharedDeckLayers("scenario-comparison",[]);await readCurrent(); if(identityChanged)await geometryPromise;}
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
async function reloadScenarioGeometry(reloadA:boolean,reloadB:boolean):Promise<void>{if(!packageSource||!manifestRaw)return;const token=++geometryReadToken;const parentToken=loadToken;try{const manifestA=parseNetworkKpiManifest(manifestRaw,manifestBaseUrl,settings.scenarioA);const manifestB=parseNetworkKpiManifest(manifestRaw,manifestBaseUrl,settings.scenarioB);const [nextGeometry,nextGeometryB]=await Promise.all([reloadA?loadNetworkKpiGeometry(packageSource,manifestA.geometry):Promise.resolve(geometry),reloadB?loadNetworkKpiGeometry(packageSource,manifestB.geometry):Promise.resolve(geometryB)]);if(token!==geometryReadToken||parentToken!==loadToken)return;geometry=nextGeometry;geometryB=nextGeometryB;if(reloadA)geometryEpsgA=manifestA.geometryEpsg;if(reloadB)geometryEpsgB=manifestB.geometryEpsg;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();void refreshComparisonDashboard();}catch(error){if(token!==geometryReadToken||parentToken!==loadToken)return;status={...status,error:error instanceof Error?error.message:String(error)};notify();}}
export async function selectScenarioComparisonPair(scenarioA:number,scenarioB:number):Promise<void>{await setScenarioComparisonSettings({scenarioA,scenarioB});if(settings.scenarioA!==scenarioA||settings.scenarioB!==scenarioB)throw new Error("Scenario comparison selection was superseded.");assertScenarioSelectionSucceeded(status,"Scenario comparison");}
export function swapScenarioComparisonSides():void{const scenarioA=settings.scenarioA;const didA=settings.didA;settings={...settings,scenarioA:settings.scenarioB,scenarioB:scenarioA,didA:settings.didB,didB:didA};[geometry,geometryB]=[geometryB,geometry];[geometryEpsgA,geometryEpsgB]=[geometryEpsgB,geometryEpsgA];[datasetA,datasetB]=[datasetB,datasetA];if(provider)updateReplications(provider);void readCurrent();notify();}
function scenarioLabel(index:number):string{return status.scenarios[index]?.label??`Scenario ${index+1}`;}

function notifyComparisonDashboard():void{for(const listener of dashboardListeners)listener();}
function dashboardSide(index:number,did:number|null,side:"A"|"B"):ScenarioComparisonDashboardSide{const scenario=status.scenarios[index];const replications=side==="A"?status.replicationsA:status.replicationsB;const replication=did===null?undefined:replications.find(item=>item.did===did);return{label:scenario?.label??`Scenario ${index+1}`,scenarioId:scenario?.scid??null,did,replicationLabel:replication?.xname??replication?.didname??(did===null?null:`Replication ${did}`)};}
function dashboardValues(value?:{flow:number|null;density:number|null;speed:number|null;delay:number|null}|null,source:ScenarioComparisonDashboardValue["source"]="entity"):ScenarioComparisonDashboardValue{return value?{...value,available:[value.flow,value.density,value.speed].some(item=>item!==null),source}:{flow:null,density:null,speed:null,delay:null,available:false,source:"missing"};}
function dashboardDelta(a:ScenarioComparisonDashboardValue,b:ScenarioComparisonDashboardValue){return scenarioComparisonMetricDelta(a,b);}
function featureSelectionFromEvent(detail:any):ScenarioComparisonDashboardEntity|null{
 if(!detail||!(detail.kind==="section"||detail.kind==="lane"||detail.kind==="turn"))return null;
 const props=detail.properties??{};const sectionId=Number(detail.sectionId??props.section_id??props.sectionId??(detail.kind==="section"?detail.featureId:NaN));
 if(!Number.isSafeInteger(sectionId))return null;
 const laneIndex=detail.kind==="lane"?Number(detail.laneIndex??props.lane_index??props.laneIndex):undefined;
 const turnId=detail.kind==="turn"?Number(detail.turnId??props.turn_id??props.turnId??detail.featureId):undefined;
 const rawId=detail.kind==="section"?sectionId:detail.kind==="lane"?laneIndex:turnId;
 if(!Number.isSafeInteger(rawId))return null;
 const id=Number(rawId);const rawName=props.name??props.Name??props.label??props.section_name;
 return{kind:detail.kind,id,sectionId,...(laneIndex===undefined?{}:{laneIndex}),...(turnId===undefined?{}:{turnId}),name:typeof rawName==="string"&&rawName.trim()?rawName.trim():`${detail.kind[0].toUpperCase()}${detail.kind.slice(1)} ${id}`};
}
function onNetworkFeatureSelected(event:Event):void{
 const detail=(event as CustomEvent).detail;const primary=appRef?.getMap?.() as any;const map=detail?.map;
 if(map===sideSecondaryMap)syncComparisonMapGeneration(map);
 if(!detail||!primary||!(map===primary||map===sideSecondaryMap)||!Number.isSafeInteger(detail.generation)||detail.generation<1||detail.generation!==map.__testudoGeneration)return;
 if(dashboardGeneration&&detail.generation<dashboardGeneration)return;
 dashboardGeneration=detail.generation;const selectedEntity=featureSelectionFromEvent(detail);if(!selectedEntity)return;
 dashboardReadToken++;dashboardState={...dashboardState,scope:"selected",selectedEntity,loading:Boolean(provider),error:null,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();void refreshComparisonDashboard();
}
function comparisonSelectionIds(scope:NetworkKpiDashboardScope):number[]{
 const features=[...(geometry?.sections?.features??[]),...(geometryB?.sections?.features??[])];
 if(scope==="network")return [...new Set(features.map(feature=>finite(feature.properties?.section_id??feature.properties?.oid??feature.properties?.id)).filter((id):id is number=>id!==null).map(Math.trunc))].sort((a,b)=>a-b);
 if(scope==="selected")return dashboardState.selectedEntity?[dashboardState.selectedEntity.sectionId]:[];
 const map=appRef?.getMap?.() as any;let bounds:any;try{bounds=map?.getBounds?.();}catch{return[];}if(!bounds)return[];
 const west=bounds.getWest(),east=bounds.getEast(),south=bounds.getSouth(),north=bounds.getNorth();
 const ids=new Set<number>();for(const feature of features){const id=finite(feature.properties?.section_id??feature.properties?.oid??feature.properties?.id);if(id===null)continue;const coords:any[]=[];const visit=(value:any)=>{if(Array.isArray(value)&&value.length>=2&&Number.isFinite(Number(value[0]))&&Number.isFinite(Number(value[1]))){coords.push([Number(value[0]),Number(value[1])]);return;}if(Array.isArray(value))for(const item of value)visit(item);};visit(feature.geometry?.coordinates);if(!coords.length)continue;const xs=coords.map(point=>point[0]),ys=coords.map(point=>point[1]);if(Math.max(...xs)>=west&&Math.min(...xs)<=east&&Math.max(...ys)>=south&&Math.min(...ys)<=north)ids.add(Math.trunc(id));}
 return [...ids].sort((a,b)=>a-b);
}
function comparisonLengths(source:NetworkKpiGeometry|null,epsg:number|null,ids:readonly number[]):Map<number,number>{const wanted=new Set(ids);const lengths=new Map<number,number>();for(const feature of source?.sections?.features??[]){const id=finite(feature.properties?.section_id??feature.properties?.oid??feature.properties?.id);if(id===null||!wanted.has(Math.trunc(id)))continue;const length=networkSectionLengthKm(feature,epsg);if(length!==null)lengths.set(Math.trunc(id),length);}return lengths;}
function sectionSeriesFromResults(result:NetworkKpiResults,ids:readonly number[]):NetworkKpiSectionSeries[]{return ids.map(sectionId=>{const row=result.sections.get(sectionId);return{sectionId,samples:row?[{interval:result.interval,flow:row.flow,density:row.density,speed:row.speed,delay:row.delay}]:[]};});}
function mergeSectionSeries(values:readonly NetworkKpiSectionSeries[]):NetworkKpiSectionSeries[]{const merged=new Map<number,NetworkKpiSectionSeries["samples"]>();for(const item of values){const samples=merged.get(item.sectionId)??[];samples.push(...item.samples);merged.set(item.sectionId,samples);}return[...merged].map(([sectionId,samples])=>({sectionId,samples}));}
async function readTurnValue(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number},turnId:number,interval:number):Promise<{value:{flow:number|null;density:number|null;speed:number|null;delay:number|null}|null;did:number|null}>{
 try{const result=await dataset.query({dataset:"MITURN",...selection,columns:["oid","flow","speed","density","dtime","sid","ent","did"],filters:[{column:"sid",op:"=",value:0},{column:"ent",op:"=",value:interval}],limit:COMPARISON_ROW_LIMIT});if(result.truncated)throw new Error("Scenario comparison turn KPI query exceeded its bounded query limit.");const row=result.rows.find(item=>finite(item.oid)===turnId||finite(item.turn_id)===turnId);if(!row)return{value:null,did:result.did??selection.did??null};return{value:{flow:usable(row.flow),density:usable(row.density),speed:usable(row.speed),delay:usable(row.dtime)},did:result.did??selection.did??null};}catch{return{value:null,did:selection.did??null};}
}
function comparisonLaneCount(source:NetworkKpiGeometry|null,sectionId:number):number{
 const seen=new Set<number>();
 for(const feature of source?.lanes?.features??[]){
  const p=feature.properties??{};const id=finite(p.section_id??p.sectionId??p.oid);
  if(id!==null&&Math.trunc(id)===sectionId){const lane=finite(p.lane_index??p.laneIndex);if(lane!==null)seen.add(Math.trunc(lane));}
 }
 return Math.max(1,seen.size);
}
function perLaneComparisonValue(value:{flow:number|null;density:number|null;speed:number|null;delay:number|null}|null,source:NetworkKpiGeometry|null,sectionId:number){
 if(!value||value.flow===null)return value;
 return{...value,flow:value.flow/comparisonLaneCount(source,sectionId)};
}
async function readDashboardEntityValue(dataset:TestudoDatasetProvider,selection:{scenarioId?:string|number;did?:number},entity:ScenarioComparisonDashboardEntity,interval:number,source:NetworkKpiGeometry|null):Promise<{value:ScenarioComparisonDashboardValue;did:number|null}>{
 if(entity.kind==="turn"){
  const turn=await readTurnValue(dataset,selection,entity.turnId??entity.id,interval);
  if(turn.value)return{value:dashboardValues(perLaneComparisonValue(turn.value,source,entity.sectionId),"entity"),did:turn.did};
  const section=await readKpi(dataset,selection,interval);return{value:dashboardValues(perLaneComparisonValue(section.sections.get(entity.sectionId)??null,source,entity.sectionId),"section-fallback"),did:section.did};
 }
 const result=await readKpi(dataset,selection,interval);
 const value=entity.kind==="lane"?result.lanes.get(laneKey(entity.sectionId,entity.laneIndex??-1)):result.sections.get(entity.sectionId);
 return{value:dashboardValues(entity.kind==="section"?perLaneComparisonValue(value??null,source,entity.sectionId):value??null),did:result.did};
}
async function refreshComparisonDashboard():Promise<void>{
 const dataset=provider;const parentToken=loadToken;const token=++dashboardReadToken;const scope=dashboardState.scope;const entity=dashboardState.selectedEntity;
 if(!dataset||status.loading||!matchedIntervals.length){dashboardState={...dashboardState,loading:false,error:null,samples:[],seriesA:null,seriesB:null,scenarioA:dashboardSide(settings.scenarioA,settings.didA,"A"),scenarioB:dashboardSide(settings.scenarioB,settings.didB,"B"),currentTimeSeconds:status.currentTimeSeconds};notifyComparisonDashboard();return;}
 if(scope==="selected"&&!entity){dashboardState={...dashboardState,loading:false,error:null,samples:[],seriesA:null,seriesB:null,scenarioA:dashboardSide(settings.scenarioA,settings.didA,"A"),scenarioB:dashboardSide(settings.scenarioB,settings.didB,"B"),currentTimeSeconds:status.currentTimeSeconds};notifyComparisonDashboard();return;}
 const sideA=scenarioSelection(dataset,settings.scenarioA,settings.didA),sideB=scenarioSelection(dataset,settings.scenarioB,settings.didB);
 dashboardState={...dashboardState,loading:true,error:null,scenarioA:dashboardSide(settings.scenarioA,sideA.did??null,"A"),scenarioB:dashboardSide(settings.scenarioB,sideB.did??null,"B"),currentTimeSeconds:status.currentTimeSeconds};notifyComparisonDashboard();
 try{
  const ids=comparisonSelectionIds(scope);if(scope!=="selected"&&!ids.length){dashboardState={...dashboardState,loading:false,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();return;}
  const perIntervalA:NetworkKpiSectionSeries[]=[],perIntervalB:NetworkKpiSectionSeries[]=[];const samples:ScenarioComparisonDashboardSample[]=[];
  for(const match of matchedIntervals){if(token!==dashboardReadToken||parentToken!==loadToken||dataset!==provider)return;
   if(scope==="selected"){
    const [a,b]=await Promise.all([readDashboardEntityValue(dataset,sideA,entity!,match.entA,geometry),readDashboardEntityValue(dataset,sideB,entity!,match.entB,geometryB)]);
    samples.push({timeSeconds:match.timeSeconds,intervalA:match.entA,intervalB:match.entB,scenarioA:a.value,scenarioB:b.value,delta:dashboardDelta(a.value,b.value)});
   }else{
    const [a,b]=await Promise.all([readKpi(dataset,sideA,match.entA),readKpi(dataset,sideB,match.entB)]);
    perIntervalA.push(...sectionSeriesFromResults(a,ids));perIntervalB.push(...sectionSeriesFromResults(b,ids));
   }
  }
  if(token!==dashboardReadToken||parentToken!==loadToken||dataset!==provider)return;
  let seriesA:NetworkKpiDashboardSeries|null=null,seriesB:NetworkKpiDashboardSeries|null=null;
  if(scope!=="selected"){
   seriesA=aggregateNetworkKpiDashboardSeries(mergeSectionSeries(perIntervalA),comparisonLengths(geometry,geometryEpsgA,ids),scope);
   seriesB=aggregateNetworkKpiDashboardSeries(mergeSectionSeries(perIntervalB),comparisonLengths(geometryB,geometryEpsgB,ids),scope);
   const mapA=new Map(seriesA.samples.map(sample=>[sample.interval,sample]));const mapB=new Map(seriesB.samples.map(sample=>[sample.interval,sample]));
   for(const match of matchedIntervals){const a=mapA.get(match.entA),b=mapB.get(match.entB);const scenarioA=dashboardValues(a??null,"aggregate"),scenarioB=dashboardValues(b??null,"aggregate");samples.push({timeSeconds:match.timeSeconds,intervalA:match.entA,intervalB:match.entB,scenarioA,scenarioB,delta:dashboardDelta(scenarioA,scenarioB)});}
  }
  dashboardState={...dashboardState,loading:false,error:null,samples,seriesA,seriesB,scenarioA:dashboardSide(settings.scenarioA,sideA.did??null,"A"),scenarioB:dashboardSide(settings.scenarioB,sideB.did??null,"B"),currentTimeSeconds:status.currentTimeSeconds};notifyComparisonDashboard();
 }catch(error){if(token!==dashboardReadToken)return;dashboardState={...dashboardState,loading:false,error:error instanceof Error?error.message:String(error),samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();}
}

function isNetworkMetric(metric:ComparisonMetric):metric is NetworkKpiMetric{
 return metric==="flow"||metric==="density"||metric==="speed"||metric==="delay";
}

function comparisonSidePolygons(source:NetworkKpiGeometry|null,metric:NetworkKpiMetric,maxHeightM:number):{sections:NetworkFeatureCollection;lanes:NetworkFeatureCollection}{
 const sections:NetworkFeatureCollection["features"]=[];const lanes:NetworkFeatureCollection["features"]=[];
 if(!source)return {sections:{type:"FeatureCollection",features:sections},lanes:{type:"FeatureCollection",features:lanes}};
 const sectionValues=new Map((source.sections?.features??[]).map(feature=>{
  const p=feature.properties??{};
  return [Number(p.section_id??p.oid),finite(p[`comparison_${metric}`])] as const;
 }));
 const laneValues=new Map((source.lanes?.features??[]).map(feature=>{
  const p=feature.properties??{};
  return [laneKey(Number(p.section_id??p.oid),Number(p.lane_index)),finite(p[`comparison_${metric}`])] as const;
 }));
 const append=(rows:ReturnType<typeof buildSectionGeometryRows>,lane:boolean)=>{
  for(const row of rows){
   const value=lane
    ?laneValues.get(laneKey(row.sectionId,row.laneIndex??-1))
    :sectionValues.get(row.sectionId);
   if(value===null||value===undefined||!Number.isFinite(value))continue;
   (lane?lanes:sections).push({type:"Feature",geometry:{type:"Polygon",coordinates:[row.ring]},properties:{comparison_metric:value,comparison_height:elevationByKpi(value,metric,maxHeightM),comparison_section_id:row.sectionId,comparison_lane_index:row.laneIndex}});
  }
 };
 append(buildSectionGeometryRows(source.sections),false);
 append(buildLaneGeometryRows(source.lanes),true);
 return {sections:{type:"FeatureCollection",features:sections},lanes:{type:"FeatureCollection",features:lanes}};
}

function enableSideBySide():void {
 const token=++sideBySideLifecycle;
 const mount=()=>{
  if(token!==sideBySideLifecycle||!visible||!appRef||!datasetA)return;
  const store=useAppStore.getState();store.setMapGrid(1,2);const pane=store.secondaryMapViews.at(-1);
  if(!pane){sideBySideRetryTimer=setTimeout(mount,100);return;}
  sidePaneId=pane.id;bindComparisonMapEvents();
  const primaryMap=appRef.getMap?.() as TestudoMapHandle|null|undefined;
  if(primaryMap&&geometry)sidePrimaryGeometryDispose=mountTestudoComparisonGeometry(primaryMap,geometry,"testudo-comparison-primary");
  const metric=isNetworkMetric(settings.metric)?settings.metric:getNetworkKpiSnapshot().metric;
  const ramp=activeRamp(metric);
  const colorExpression:[string,...unknown[]]=["interpolate",["linear"],["to-number",["get","comparison_metric"],0],...ramp.stops.flatMap((value,index)=>[value,ramp.colors[index]])];
  const style={strokeColor:"#64748b",strokeWidth:0,fillOpacity:settings.opacity,vectorStyleMode:"expression" as const,vectorStyleProperty:"comparison_metric",vectorStyleExpression:JSON.stringify(colorExpression),extrusionEnabled:settings.extruded,extrusionColor:"#94a3b8",extrusionOpacity:settings.opacity,extrusionHeightProperty:"comparison_height",extrusionHeightScale:1};
  const sideA=comparisonSidePolygons(datasetA,metric,settings.maxHeightM);
  sidePrimaryHasLaneRows=sideA.lanes.features.length>0;
  const aSections=appRef.addGeoJsonLayer(`${scenarioLabel(settings.scenarioA)} sections`,sideA.sections as never);
  const aLanes=appRef.addGeoJsonLayer(`${scenarioLabel(settings.scenarioA)} lanes`,sideA.lanes as never);
  for(const id of [aSections,aLanes]){store.setLayerStyle(id,style);store.setLayerVisibility(id,false);store.setSecondaryLayerVisibility(pane.id,id,false);}
  const sideB=datasetB?comparisonSidePolygons(datasetB,metric,settings.maxHeightM):null;
  if(!sideB){console.warn("[GeoLibre] scenario-comparison: Scenario B dataset failed to load; showing Scenario A only");sideLayerIds=[aSections,aLanes];return;}
  store.setComparisonMapPresentation({owner:"scenario-comparison",secondaryPaneId:pane.id,primaryLabel:scenarioLabel(settings.scenarioA),secondaryLabel:scenarioLabel(settings.scenarioB)});
  sideSecondaryHasLaneRows=sideB.lanes.features.length>0;
  const bSections=appRef.addGeoJsonLayer(`${scenarioLabel(settings.scenarioB)} sections`,sideB.sections as never);
  const bLanes=appRef.addGeoJsonLayer(`${scenarioLabel(settings.scenarioB)} lanes`,sideB.lanes as never);
  for(const id of [bSections,bLanes]){store.setLayerStyle(id,style);store.setLayerVisibility(id,false);store.setSecondaryLayerVisibility(pane.id,id,false);}
  sideLayerIds=[aSections,aLanes,bSections,bLanes];
  sidePrimarySectionLayerId=aSections;sidePrimaryLaneLayerId=aLanes;sideSecondarySectionLayerId=bSections;sideSecondaryLaneLayerId=bLanes;
  bindSideBySideZoomHandlers();
  if(sideSecondaryMap)sideSecondaryGeometryDispose=mountTestudoComparisonGeometry(sideSecondaryMap,geometryB,`testudo-comparison-${pane.id}`);
 };
 mount();
}
function disableSideBySide(){sideBySideLifecycle++;if(sideBySideRetryTimer!==null){clearTimeout(sideBySideRetryTimer);sideBySideRetryTimer=null;}unbindSideBySideZoomHandlers();unbindSideBySideSelection();const store=useAppStore.getState();const presentation=store.comparisonMapPresentation;if(presentation?.owner==="scenario-comparison"&&(!sidePaneId||presentation.secondaryPaneId===sidePaneId))store.setComparisonMapPresentation(null);sidePrimaryGeometryDispose?.();sidePrimaryGeometryDispose=null;sideSecondaryGeometryDispose?.();sideSecondaryGeometryDispose=null;sideSecondaryMap=null;for(const id of sideLayerIds)store.removeLayer(id);if(sidePaneId)store.removeSecondaryMapView(sidePaneId);sidePaneId=null;sideLayerIds=[];sidePrimarySectionLayerId=null;sidePrimaryLaneLayerId=null;sideSecondarySectionLayerId=null;sideSecondaryLaneLayerId=null;sidePrimaryHasLaneRows=false;sideSecondaryHasLaneRows=false;setSharedDeckLayers("scenario-comparison",[]);}
export function computeScenarioComparison(a:readonly ComparisonInput[],b:readonly ComparisonInput[]){rows=buildScenarioComparisonRows(a,b);notify();return rows;}
export function getScenarioComparisonRows(){return rows;}
export function stepScenarioComparisonInterval(direction:1|-1){const values=intervals.filter(v=>v!==0);if(values.length<2)return;const current=values.indexOf(settings.interval);const nextIndex=current<0?(direction===1?0:values.length-1):current+direction;if(!settings.loop&&(nextIndex<0||nextIndex>=values.length)){settings={...settings,intervalPlaying:false};playback.sync(false);notify();return;}const next=values[(nextIndex+values.length)%values.length];setScenarioComparisonSettings({interval:next});}
function selectDistinctInitialPair(scenarios:readonly VehicleManifestScenario[]):void{const pair=defaultScenarioComparisonPair(scenarios.map(scenario=>scenario.index),settings.scenarioA,settings.scenarioB,settings.didA,settings.didB);if(pair)settings={...settings,...pair};}
export function toggleScenarioComparisonIntervalPlaying(){settings={...settings,intervalPlaying:!settings.intervalPlaying&&intervals.filter(value=>value!==0).length>1};playback.sync(settings.intervalPlaying,Math.max(100,1000/settings.playbackSpeed));notify();}
export async function setScenarioComparisonManifestUrl(url:string){disableSideBySide();committedComparisonIdentity=null;const token=++loadToken;dashboardReadToken++;dashboardState={...dashboardState,selectedEntity:null,loading:false,error:null,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();settings={...settings,intervalPlaying:false};playback.sync(false);const oldProvider=provider;provider=null;intervalCache.clear();if(oldProvider)await oldProvider.close();rows=[];intervals=[];matchedIntervals=[];setSharedDeckLayers("scenario-comparison",[]);geometry=null;geometryB=null;geometryEpsgA=null;geometryEpsgB=null;datasetA=null;datasetB=null;manifestRaw=null;packageSource=null;manifestBaseUrl=null;status={...status,loading:Boolean(url.trim()),error:null,timelineA:null,timelineB:null,intervals:[],matchedIntervals:[],currentTimeSeconds:null};notify();if(!url.trim()){settings={...settings,manifestUrl:null};status={...status,loading:false,scenarios:[],intervals:[],matchedIntervals:[],timeMatchReason:null,aggregateAvailable:false,currentTimeSeconds:null};notify();return;} settings={...settings,manifestUrl:url};try{const raw=await fetchNetworkKpiManifestJson(url);if(token!==loadToken)return;const scenarios=listVehicleManifestScenarios(raw);status={...status,scenarios};selectDistinctInitialPair(scenarios);const source=createNetworkKpiHttpSource(url);const manifestA=parseNetworkKpiManifest(raw,url,settings.scenarioA);const manifestB=parseNetworkKpiManifest(raw,url,settings.scenarioB);geometryEpsgA=manifestA.geometryEpsg;geometryEpsgB=manifestB.geometryEpsg;[geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]);if(token!==loadToken)return;manifestRaw=raw;packageSource=source;manifestBaseUrl=url;if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);if(!await installOpenedResourceIfCurrent(openTestudoDatasetProvider({source,manifest:raw}),()=>token===loadToken,opened=>{provider=opened;}))return;await readCurrent(token);if(token!==loadToken)return;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();}catch(error){if(token!==loadToken)return;disableSideBySide();status={...status,loading:false,error:error instanceof Error?error.message:String(error)};notify();}}
export function canLoadLocalScenarioComparisonPackage(): boolean { return supportsLocalPackageFolders(); }
export async function loadLocalScenarioComparisonFolder(selectedDirectory?:NetworkKpiDirectoryHandle): Promise<void> { disableSideBySide();committedComparisonIdentity=null;const token=++loadToken;settings={...settings,intervalPlaying:false};playback.sync(false); if(!selectedDirectory&&!canLoadLocalScenarioComparisonPackage()){status={...status,error:"Local folders are not supported in this browser."};notify();return;} const oldProvider=provider;provider=null;dashboardReadToken++;dashboardState={...dashboardState,selectedEntity:null,loading:false,error:null,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();intervalCache.clear();if(oldProvider)await oldProvider.close(); rows=[];intervals=[];matchedIntervals=[];setSharedDeckLayers("scenario-comparison",[]);geometry=null;geometryB=null;geometryEpsgA=null;geometryEpsgB=null;datasetA=null;datasetB=null; manifestRaw=null;packageSource=null;manifestBaseUrl=null; status={...status,loading:true,error:null,timelineA:null,timelineB:null,intervals:[],matchedIntervals:[],currentTimeSeconds:null};notify(); try { const root=selectedDirectory??await(window as any).showDirectoryPicker() as NetworkKpiDirectoryHandle; if(token!==loadToken)return; const raw=await readLocalNetworkKpiManifestJson(root); if(token!==loadToken)return; const scenarios=listVehicleManifestScenarios(raw);status={...status,scenarios};selectDistinctInitialPair(scenarios); const source=createNetworkKpiDirectorySource(root); const manifestA=parseNetworkKpiManifest(raw,null,settings.scenarioA); const manifestB=parseNetworkKpiManifest(raw,null,settings.scenarioB); [geometry,geometryB]=await Promise.all([loadNetworkKpiGeometry(source,manifestA.geometry),loadNetworkKpiGeometry(source,manifestB.geometry)]); if(token!==loadToken)return; geometryEpsgA=manifestA.geometryEpsg;geometryEpsgB=manifestB.geometryEpsg;manifestRaw=raw;packageSource=source;manifestBaseUrl=null; if(manifestA.bounds)appRef?.fitBounds?.(manifestA.bounds);if(!await installOpenedResourceIfCurrent(openTestudoDatasetProvider({source,manifest:raw}),()=>token===loadToken,opened=>{provider=opened;}))return;await readCurrent(token);if(token!==loadToken)return; if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render(); notify(); } catch(error) { if(token!==loadToken)return;disableSideBySide(); const cancelled=error instanceof Error&&error.name==="AbortError"; status={...status,loading:false,error:cancelled?null:error instanceof Error?error.message:String(error)}; notify(); } }
function inputs(result:NetworkKpiResults){return [
 ...[...result.sections].map(([key,v])=>({key:`s:${key}`,flow:v.flow??null,density:v.density??null,speed:v.speed??null,delay:v.delay??null})),
 ...[...result.lanes].map(([key,v])=>({key:`l:${key}`,flow:v.flow??null,density:v.density??null,speed:v.speed??null,delay:v.delay??null})),
];}
function withKpiData(source: NetworkKpiGeometry, result: NetworkKpiResults): NetworkKpiGeometry {
  const sections = source.sections ? {
    ...source.sections,
    features: source.sections.features.map((feature) => {
      const p = feature.properties ?? {};
      const k = result.sections.get(Number(p.section_id ?? p.oid));
      return { ...feature, properties: { ...p, comparison_did: result.did, comparison_flow: k?.flow ?? null, comparison_density: k?.density ?? null, comparison_speed: k?.speed ?? null, comparison_delay: k?.delay ?? null, comparison_interval: result.interval } };
    }),
  } : null;
  const lanes = source.lanes ? {
    ...source.lanes,
    features: source.lanes.features.map((feature) => {
      const p = feature.properties ?? {};
      const k = result.lanes.get(laneKey(Number(p.section_id ?? p.oid), Number(p.lane_index)));
      return { ...feature, properties: { ...p, comparison_did: result.did, comparison_flow: k?.flow ?? null, comparison_density: k?.density ?? null, comparison_speed: k?.speed ?? null, comparison_delay: k?.delay ?? null, comparison_interval: result.interval } };
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
async function readCurrent(parentToken=loadToken):Promise<void>{if(!provider)return;const dataset=provider;const token=++readToken;dashboardReadToken++;const selectionA=scenarioSelection(dataset,settings.scenarioA,settings.didA);const selectionB=scenarioSelection(dataset,settings.scenarioB,settings.didB);try{
 const [intervalsA,intervalsB,timelineA,timelineB]=await Promise.all([availableIntervals(dataset,selectionA),availableIntervals(dataset,selectionB),readSimulationTimeline(dataset,selectionA),readSimulationTimeline(dataset,selectionB)]);
 if(token!==readToken||parentToken!==loadToken)return;
 const match=matchScenarioIntervals(intervalsA,timelineA,intervalsB,timelineB);matchedIntervals=match.intervals;intervals=match.intervals.map(item=>item.entA);
 const aggregate=match.aggregateAvailable&&settings.interval===0;
 const selected=aggregate?null:(match.intervals.find(item=>item.entA===settings.interval)??match.intervals[0]??null);
 status={...status,loading:false,error:null,timeMatchReason:match.reason,aggregateAvailable:match.aggregateAvailable,currentTimeSeconds:aggregate?null:selected?.timeSeconds??null,matchedIntervals:match.intervals,intervals,timelineA,timelineB};
 if(!aggregate&&!selected){settings={...settings,interval:0,intervalPlaying:false};playback.sync(false);rows=[];datasetA=null;datasetB=null;setSharedDeckLayers("scenario-comparison",[]);if(settings.mode==="side-by-side")disableSideBySide();status={...status,sectionsA:0,sectionsB:0,lanesA:0,lanesB:0};void refreshComparisonDashboard();notify();return;}
 const entA=aggregate?0:selected!.entA;const entB=aggregate?0:selected!.entB;
 const [a,b]=await Promise.all([readKpi(dataset,selectionA,entA),readKpi(dataset,selectionB,entB)]);
 if(token!==readToken||parentToken!==loadToken)return;
 intervals=match.intervals.map(item=>item.entA);
 status={...status,loading:false,error:null,intervals,matchedIntervals:match.intervals,timeMatchReason:null,aggregateAvailable:match.aggregateAvailable,currentTimeSeconds:aggregate?null:selected!.timeSeconds,sectionsA:a.sections.size||geometry?.sections?.features.length||0,sectionsB:b.sections.size||geometryB?.sections?.features.length||0,lanesA:a.lanes.size||geometry?.lanes?.features.length||0,lanesB:b.lanes.size||geometryB?.lanes?.features.length||0,turnsA:geometry?.turns?.features.length??0,turnsB:geometryB?.turns?.features.length??0};
 if(settings.didA!==a.did||settings.didB!==b.did)settings={...settings,didA:a.did,didB:b.did};settings={...settings,interval:aggregate?0:entA};
  datasetA=geometry?withKpiData(geometry,a):null;datasetB=geometryB?withKpiData(geometryB,b):null;rows=buildScenarioComparisonRows(inputs(a),inputs(b));if(testudoLiveDiagnosticsEnabled(import.meta.env.DEV||import.meta.env.MODE==="test",typeof window==="undefined"?"":window.location.search)){committedComparisonIdentity={scenarioA:comparisonSideIdentity(a,selectionA.scenarioId),scenarioB:comparisonSideIdentity(b,selectionB.scenarioId),sampleCount:rows.length,sampleFingerprint:boundedFingerprint(rows.slice(0,32).flatMap(row=>[row.key,row.flow,row.density,row.speed,row.flow_delta,row.density_delta,row.speed_delta]))};}else committedComparisonIdentity=null;if(settings.mode==="side-by-side"){disableSideBySide();enableSideBySide();}else render();notify();void refreshComparisonDashboard();
 }catch(error){if(token!==readToken||parentToken!==loadToken)return;settings={...settings,intervalPlaying:false};playback.sync(false);status={...status,loading:false,error:error instanceof Error?error.message:String(error),timelineA:null,timelineB:null,intervals:[],matchedIntervals:[],currentTimeSeconds:null};rows=[];intervals=[];matchedIntervals=[];setSharedDeckLayers("scenario-comparison",[]);dashboardState={...dashboardState,loading:false,error:status.error,samples:[],seriesA:null,seriesB:null};notifyComparisonDashboard();notify();}}

function color(row:ComparisonRow):[number,number,number,number]{const value=row[settings.metric];const alpha=Math.round(settings.opacity*255);if(value===null||value===undefined)return [136,136,136,alpha];if(isComparisonDifferenceMetric(settings.metric)){const rgb=comparisonDifferenceColor(settings.metric,Number(value),settings.flowDifferenceScale);return [...rgb,alpha];}const cat=comparisonCategoricalRamp(settings.metric)?.categories.find(c=>c.key===value);const h=(cat?.color??"#888888").replace("#","");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),alpha];}
function render(){
  if(!deck)return;
  if(!geometry||settings.mode!=="diff"){setSharedDeckLayers("scenario-comparison",[]);return;}
  if(!visible||!layerVisible){setSharedDeckLayers("scenario-comparison",[]);return;}
  const rowsByKey=new Map(rows.map(row=>[String(row.key),row]));
  const numericDifference=isComparisonDifferenceMetric(settings.metric);
  const threshold=Math.max(0,settings.differenceThreshold??comparisonThresholdDefault(settings.metric));
  const labels:Array<{position:[number,number];elevation:number;text:string;priority:number;widthPx:number}> = [];
  const sectionRows=buildSectionGeometryRows(geometry.sections);
  const laneRows=buildLaneGeometryRows(geometry.lanes);
  const matchingGeometry=new Set([
    ...buildSectionGeometryRows(geometryB?.sections??null).map(row=>row.key),
    ...buildLaneGeometryRows(geometryB?.lanes??null).map(row=>row.key),
  ]);
  const sectionFeatures=new Map((geometry.sections?.features??[]).map(feature=>{
    const p=feature.properties??{};
    return [Number(p.section_id??p.oid),feature] as const;
  }));
  const data=[...sectionRows.map(row=>({geometryRow:row,lane:false})),...laneRows.map(row=>({geometryRow:row,lane:true}))].flatMap(({geometryRow,lane})=>{
    const row=rowsByKey.get(geometryRow.key);
    if(!row||!row.hasReference||!row.hasCompared||!matchingGeometry.has(geometryRow.key))return [];
    const value=row[settings.metric];
    if(isComparisonDifferenceMetric(settings.metric)&&threshold>0&&!passesComparisonDifferenceFilter(settings.metric,value,row.flow_delta,row.density_delta,threshold))return [];
    if(!lane){
      const feature=sectionFeatures.get(geometryRow.sectionId);
      const coordinates=feature?.geometry?.coordinates;
      if(Array.isArray(coordinates)&&feature?.geometry?.type==="LineString"){
        const numericValue=value===null||value===undefined?Number.NaN:Number(value);
        const midpoint=numericDifference&&Number.isFinite(numericValue)?lineMidpoint(coordinates as [number,number][]):null;
        if(midpoint&&Number.isFinite(numericValue)){
          const base=settings.metric.replace("_delta","") as NetworkKpiMetric;
          const elevation=settings.extruded?elevationByKpi(Math.abs(numericValue),base,settings.maxHeightM)+2:0;
          const text=formatRoundedDifference(numericValue);
          labels.push({position:midpoint,elevation,text,priority:Math.abs(numericValue),widthPx:text.length*9+12});
        }
      }
    }
    return [{ring:geometryRow.ring,row}];
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
