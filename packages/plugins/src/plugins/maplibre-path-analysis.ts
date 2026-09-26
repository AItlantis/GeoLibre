// @ts-nocheck
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { createHttpPackageSource, supportsLocalPackageFolders, type VehicleDirectoryHandle } from "./vehicle-playback-data";
import { fetchNetworkKpiManifestJson } from "./network-kpi-data";
import { depthOcclusionParameters, ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import { canLoadLocalPathAnalysisPackage, createPathAnalysisDirectorySource, loadPathAnalysis, parsePathAnalysisManifest, readLocalPathAnalysisManifestJson, type PathAnalysisData, type PathMatch, type PathRule } from "./path-analysis-data";
import { pathColorRgb, pathElevation, pathMetricRampExpression, pathMetricValue, type PathMetric } from "./path-analysis-ramps";
import { bufferLineToRing } from "./network-kpi-geometry";
import { registerDuckDbLayer, releaseDuckDbLayer } from "../shared/duckdb-layer-registry";
import { MAPLIBRE_LABEL_LAYOUT, MAPLIBRE_LABEL_PAINT, formatTripVolume } from "../shared/map-labels";
export const PATH_ANALYSIS_PLUGIN_ID="geolibre-path-analysis";
export const PATH_ANALYSIS_STORE_LAYER_ID="geolibre-path-analysis-layer";
const SECTION_SOURCE="geolibre-path-analysis-sections",PATH_SOURCE="geolibre-path-analysis-paths",LABEL_SOURCE="geolibre-path-analysis-labels",SELECTED_SOURCE="geolibre-path-analysis-selected";
const SELECTED_LAYER="geolibre-path-analysis-selected-highlight";
const PATH_RIBBON_WIDTH_M=12;
let pathAnalysisLayerVisible=true;
let pathLayerOpacity = 1;
let loadToken=0;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
export interface PathAnalysisSettings{manifestUrl:string|null;rule:PathRule;metric:PathMetric;displayMode:"section-volumes"|"origin-destination";extruded:boolean;maxHeightM:number;seeThroughBuildings:boolean;labelSize:number;visible:boolean;interval:number;intervalPlaying:boolean;playbackSpeed:number;loop:boolean}
export interface PathAnalysisSnapshot{settings:PathAnalysisSettings;loading:boolean;selectionLoading:boolean;selectionError:string|null;error:string|null;summary:Record<string,unknown>|null;intervals:number[];selectedSections:number[];selectedSection:number|null;selectedSectionName:string|null;selectedVolume:number;sectionVolumes:Array<{section_id:number;volume:number;totalVolume:number;percentage:number;role:"upstream"|"selected"|"downstream"}>;matches:PathMatch[]}
let snapshot:PathAnalysisSnapshot={settings:{manifestUrl:null,rule:"or",metric:"percentage",displayMode:"section-volumes",extruded:false,maxHeightM:20,seeThroughBuildings:true,labelSize:11,visible:true,interval:0,intervalPlaying:false,playbackSpeed:1,loop:true},loading:false,selectionLoading:false,selectionError:null,error:null,summary:null,intervals:[],selectedSections:[],selectedSection:null,selectedSectionName:null,selectedVolume:0,sectionVolumes:[],matches:[]};let visible=false;let engine:PathAnalysisEngine|null=null;let appRef:GeoLibreAppAPI|null=null;const listeners=new Set<()=>void>(),panelListeners=new Set<()=>void>();const notify=()=>listeners.forEach(f=>f());
export const getPathAnalysisSnapshot=()=>snapshot;export const subscribePathAnalysis=(f:()=>void)=>(listeners.add(f),()=>listeners.delete(f));export const isPathAnalysisPanelVisible=()=>visible;export const subscribePathAnalysisPanel=(f:()=>void)=>(panelListeners.add(f),()=>panelListeners.delete(f));
function fitPathAnalysisBounds(bounds:[number,number,number,number]|null){if(bounds)appRef?.fitBounds?.(bounds)}
function registerPathAnalysisStoreLayer(){appRef?.registerExternalNativeLayer?.({id:PATH_ANALYSIS_STORE_LAYER_ID,name:"Path analysis",type:"geojson",nativeLayerIds:[SECTION_SOURCE,PATH_SOURCE,LABEL_SOURCE,SELECTED_LAYER],paintMode:"plugin",metadata:{customLayerType:"maplibre"},paintBridge:{setOpacity:(opacity)=>{pathLayerOpacity=Math.max(0,Math.min(1,opacity));const map=appRef?.getMap?.();if(map?.getLayer(SECTION_SOURCE))map.setPaintProperty(SECTION_SOURCE,"line-opacity",0.75*pathLayerOpacity);if(map?.getLayer(PATH_SOURCE))map.setPaintProperty(PATH_SOURCE,"line-opacity",["*",["get","opacity"],pathLayerOpacity]);if(map?.getLayer(LABEL_SOURCE))map.setPaintProperty(LABEL_SOURCE,"text-opacity",pathLayerOpacity);if(map?.getLayer(SELECTED_LAYER))map.setPaintProperty(SELECTED_LAYER,"line-opacity",pathLayerOpacity);void engine?.render();},setVisibility:(next)=>{pathAnalysisLayerVisible=next;const map=appRef?.getMap?.();for(const id of [SECTION_SOURCE,PATH_SOURCE,LABEL_SOURCE,SELECTED_LAYER])if(map?.getLayer(id))map.setLayoutProperty(id,"visibility",next?"visible":"none");void engine?.render();}}});}
export function openPathAnalysisPanel(app:GeoLibreAppAPI){appRef=app;visible=true;registerPathAnalysisStoreLayer();registerDuckDbLayer({pluginId:"path-analysis",dispose:()=>{engine?.disposeData()}});panelListeners.forEach(f=>f());if(!engine){const map=app.getMap?.();if(map)engine=new PathAnalysisEngine(app,map)}}
// Disposes the engine's current PathAnalysisData (conn.close()/db.terminate()/
// worker.terminate() in path-analysis-data.ts) so closing the panel actually
// releases the DuckDB instance instead of leaking it. `engine.disposeData()`
// nulls out its own `data` field after closing, so a close-then-immediate-
// reload race (setData() firing right after) never double-closes: setData()'s
// own `this.data?.close()` sees the already-nulled field and no-ops.
export function closePathAnalysisPanel(){visible=false;loadToken++;stopPathAnalysisTimer();snapshot={...snapshot,loading:false,settings:{...snapshot.settings,intervalPlaying:false}};releaseDuckDbLayer("path-analysis");appRef?.unregisterExternalNativeLayer?.(PATH_ANALYSIS_STORE_LAYER_ID);engine?.disposeData();panelListeners.forEach(f=>f())}
export async function setPathAnalysisManifestUrl(url:string){const token=++loadToken;stopPathAnalysisTimer();engine?.disposeData();snapshot={...snapshot,summary:null,intervals:[],selectedSections:[],selectedSection:null,selectedSectionName:null,selectedVolume:0,sectionVolumes:[],matches:[],settings:{...snapshot.settings,manifestUrl:url,interval:0,intervalPlaying:false},loading:true,error:null,selectionLoading:false,selectionError:null};notify();try{const p=parsePathAnalysisManifest(await fetchNetworkKpiManifestJson(url),url);if(token!==loadToken)return;if(!p.available)throw new Error(p.unavailableReason??"Path data is unavailable in this package.");const d=await loadPathAnalysis(createHttpPackageSource(url),p);if(token!==loadToken){d.close();return}engine?.setData(d);fitPathAnalysisBounds(p.bounds);snapshot={...snapshot,loading:false,summary:d.summary,intervals:d.intervals??[],settings:{...snapshot.settings,interval:0,intervalPlaying:false},selectedSections:[],selectedSection:null,selectedSectionName:null,matches:[]}}catch(e){if(token!==loadToken)return;snapshot={...snapshot,loading:false,error:e instanceof Error?e.message:String(e)};notify()}notify()}
export async function loadLocalPathAnalysisFolder(selectedDirectory?:VehicleDirectoryHandle){const token=++loadToken;if(!selectedDirectory&&!supportsLocalPackageFolders()){snapshot={...snapshot,error:"Local folders are not supported in this browser."};notify();return}stopPathAnalysisTimer();engine?.disposeData();snapshot={...snapshot,summary:null,intervals:[],selectedSections:[],selectedSection:null,selectedSectionName:null,selectedVolume:0,sectionVolumes:[],matches:[],selectionLoading:false,selectionError:null,loading:true,error:null,settings:{...snapshot.settings,interval:0,intervalPlaying:false}};notify();try{const root=selectedDirectory??await(window as any).showDirectoryPicker() as VehicleDirectoryHandle;if(token!==loadToken)return;const p=parsePathAnalysisManifest(await readLocalPathAnalysisManifestJson(root),null);if(token!==loadToken)return;const d=await loadPathAnalysis(createPathAnalysisDirectorySource(root),p);if(token!==loadToken){d.close();return}engine?.setData(d);fitPathAnalysisBounds(p.bounds);snapshot={...snapshot,loading:false,summary:d.summary,intervals:d.intervals??[],settings:{...snapshot.settings,interval:0,intervalPlaying:false,manifestUrl:null},selectedSections:[],selectedSection:null,selectedSectionName:null,matches:[]};notify()}catch(e){if(token!==loadToken)return;snapshot={...snapshot,loading:false,error:(e as Error).name!=="AbortError"?(e instanceof Error?e.message:String(e)):null};notify()}}
export{canLoadLocalPathAnalysisPackage};export function reattachPathAnalysis(app:GeoLibreAppAPI){appRef=app;if(visible){registerPathAnalysisStoreLayer();if(!engine){const map=app.getMap?.();if(map)engine=new PathAnalysisEngine(app,map)}}}export function setPathAnalysisSettings(p:Partial<PathAnalysisSettings>){const previous=snapshot.settings;snapshot={...snapshot,settings:{...snapshot.settings,...p}};const queryChanged=previous.interval!==snapshot.settings.interval||previous.rule!==snapshot.settings.rule;if(queryChanged)void engine?.refresh();else void engine?.render();if(previous.intervalPlaying!==snapshot.settings.intervalPlaying||previous.playbackSpeed!==snapshot.settings.playbackSpeed||previous.loop!==snapshot.settings.loop)syncPathAnalysisTimer();notify()}export function clearPathAnalysisSelection(){void engine?.clearSelection()}
function stopPathAnalysisTimer(){if(intervalTimer){clearInterval(intervalTimer);intervalTimer=null}}
function syncPathAnalysisTimer(){stopPathAnalysisTimer();if(snapshot.settings.intervalPlaying&&snapshot.intervals.filter((value)=>value!==0).length>0)intervalTimer=setInterval(()=>{if(!snapshot.selectionLoading)stepPathAnalysisInterval(1)},Math.max(100,1000/Math.max(0.1,snapshot.settings.playbackSpeed||1)))}
export function togglePathAnalysisIntervalPlaying(){setPathAnalysisSettings({intervalPlaying:!snapshot.settings.intervalPlaying})}
export function stepPathAnalysisInterval(direction:1|-1){const values=snapshot.intervals.filter((value)=>value!==0);if(values.length===0)return;const index=values.indexOf(snapshot.settings.interval);const next=index<0?(direction===1?0:values.length-1):index+direction;if(!snapshot.settings.loop&&(next<0||next>=values.length)){setPathAnalysisSettings({intervalPlaying:false});return}setPathAnalysisSettings({interval:values[(next+values.length)%values.length]})}
// Per-chip removal for the multi-select list, distinct from clearSelection()'s
// full reset — drops just the one id and re-runs the OR/AND query on what's left.
export function removePathAnalysisSection(id:number){const selectedSections=snapshot.selectedSections.filter(x=>x!==id);const selectedSection=snapshot.selectedSection===id?(selectedSections.at(-1)??null):snapshot.selectedSection;snapshot={...snapshot,selectedSections,selectedSection,selectedSectionName:selectedSection==null?null:engine?.getSectionName(selectedSection)??null,selectionLoading:selectedSections.length>0,selectionError:null};engine?.highlightSelectedSection(selectedSection);void engine?.refresh();notify()}
class LegacyPathAnalysisEngine{private data:PathAnalysisData|null=null;private bound=false;private selectionToken=0;constructor(private app:GeoLibreAppAPI,private map:MapLibreMap){}
// Close and null out whatever data this engine currently holds. Idempotent —
// safe to call from closePathAnalysisPanel() even when setData() has already
// run (or never ran), since `this.data` is null in both those cases.
disposeData(){this.data?.close();this.data=null}
setData(d:PathAnalysisData){this.data?.close();this.data=d;const s=d.geometry.sections;const sectionSource=this.map.getSource(SECTION_SOURCE) as any;if(sectionSource)sectionSource.setData(s as any);else this.map.addSource(SECTION_SOURCE,{type:"geojson",data:s as any});snapshot={...snapshot,selectedSections:[],selectedSection:null,matches:[]};void this.render();notify();if(!this.map.getLayer(SECTION_SOURCE))this.map.addLayer({id:SECTION_SOURCE,type:"line",source:SECTION_SOURCE,layout:{visibility:"visible"},paint:{"line-color":"#0f766e","line-width":4,"line-opacity":.85}});if(!this.bound){this.map.on("click",(e)=>{const p=e.point;const features=this.map.queryRenderedFeatures([[p.x-8,p.y-8],[p.x+8,p.y+8]],{layers:[SECTION_SOURCE]});if(features.length)void this.select({...e,features} as MapMouseEvent)});this.bound=true}}private async select(e:MapMouseEvent){const id=Math.trunc(Number((e.features?.[0]?.properties as any)?.section_id??(e.features?.[0]?.properties as any)?.id));if(!Number.isFinite(id)||!this.data)return;const add=e.originalEvent.ctrlKey||e.originalEvent.shiftKey;const next=add?(snapshot.selectedSections.includes(id)?snapshot.selectedSections.filter(x=>x!==id):[...snapshot.selectedSections,id]):[id];snapshot={...snapshot,selectedSections:next,selectedSection:id};await this.refresh()}async refresh(){const token=++this.selectionToken;if(!this.data||!snapshot.selectedSections.length){if(token!==this.selectionToken)return;snapshot={...snapshot,matches:[]};await this.render();notify();return}const matches=await this.data.query(snapshot.selectedSections,snapshot.settings.rule,snapshot.settings.interval??0);if(token!==this.selectionToken)return;snapshot={...snapshot,matches};await this.render();notify()}async clearSelection(){snapshot={...snapshot,selectedSections:[],selectedSection:null,matches:[]};await this.render();notify()}async render(){if(!this.data)return;const sections=new Map<number,any>();for(const f of (this.data.geometry.sections as any).features??[]){const p=f.properties??{},id=Number(p.section_id??p.id??p.ID);if(Number.isFinite(id))sections.set(id,f.geometry)}const matchList=snapshot.matches.slice(0,200);
// `sequence()` is async (a DuckDB query per route), so every route's section
// list must be awaited before its coordinates can be assembled — the previous
// `for...of this.data.sequence(...)` iterated the returned Promise itself,
// which isn't iterable and threw on every real selection.
const sequences=await Promise.all(matchList.map(m=>this.data!.sequence(m.route_id)));
const features:any[]=[],ribbonFeatures:any[]=[],labels:any[]=[];matchList.forEach((m,i)=>{const coords:any[]=[];for(const sid of sequences[i]){const g=sections.get(sid);if(g?.type==="LineString")coords.push(...(coords.length?g.coordinates.slice(1):g.coordinates));else if(g?.type==="MultiLineString")for(const line of g.coordinates)coords.push(...(coords.length?line.slice(1):line))}if(coords.length>1){const value=pathMetricValue(m,snapshot.settings.metric);const properties={value,demand:m.demand,percentage:m.percentage};features.push({type:"Feature",properties,geometry:{type:"LineString",coordinates:coords}});const ring=bufferLineToRing(coords as [number,number][],PATH_RIBBON_WIDTH_M);if(ring)ribbonFeatures.push({type:"Feature",properties,geometry:{type:"Polygon",coordinates:[ring]}});labels.push({type:"Feature",properties:{label:snapshot.settings.metric==="trips"?`${m.demand.toFixed(0)} trips`:`${(m.percentage*100).toFixed(1)}%`},geometry:{type:"Point",coordinates:coords[Math.floor(coords.length/2)]}})}});const set=(id:string,data:any)=>{const s=this.map.getSource(id) as any;if(s)s.setData(data);else this.map.addSource(id,{type:"geojson",data})};set(PATH_SOURCE,{type:"FeatureCollection",features});set(LABEL_SOURCE,{type:"FeatureCollection",features:labels});if(!this.map.getLayer(PATH_SOURCE))this.map.addLayer({id:PATH_SOURCE,type:"line",source:PATH_SOURCE,paint:{"line-color":pathMetricRampExpression(snapshot.settings.metric),"line-width":4}});else this.map.setPaintProperty(PATH_SOURCE,"line-color",pathMetricRampExpression(snapshot.settings.metric));if(!this.map.getLayer(LABEL_SOURCE))this.map.addLayer({id:LABEL_SOURCE,type:"symbol",source:LABEL_SOURCE,layout:{"text-field":["get","label"],"text-size":11,"text-allow-overlap":true},paint:{"text-color":"#172554","text-halo-color":"#fff","text-halo-width":1.5}});if(this.app.getDeckGL)void this.app.getDeckGL().then((deck:any)=>ensureSharedDeckOverlay(this.app).then(()=>setSharedDeckLayers("path-analysis",snapshot.settings.extruded?[new deck.layers.PolygonLayer({id:"geolibre-path-analysis-3d",data:ribbonFeatures,getPolygon:(d:any)=>d.geometry.coordinates[0],getFillColor:(d:any)=>[...pathColorRgb(d.properties.value,snapshot.settings.metric),220],getElevation:(d:any)=>snapshot.settings.extruded?pathElevation(d.properties.value,snapshot.settings.metric,snapshot.settings.maxHeightM):0,extruded:snapshot.settings.extruded,filled:true,stroked:false,elevationScale:1,pickable:false,...depthOcclusionParameters(snapshot.settings.seeThroughBuildings),updateTriggers:{getFillColor:[snapshot.settings.metric],getElevation:[snapshot.settings.metric,snapshot.settings.extruded,snapshot.settings.maxHeightM]}} as any)]:[])))}}
class PathAnalysisEngine {
  private data: PathAnalysisData | null = null;
  private bound = false;
  private styleBound = false;
  private selectionToken = 0;
  private renderGeneration = 0;
  constructor(private app: GeoLibreAppAPI, private map: MapLibreMap) {}

  disposeData() {
    this.selectionToken++; this.renderGeneration++; this.data?.close(); this.data = null;
    for (const id of [SECTION_SOURCE, PATH_SOURCE, LABEL_SOURCE, SELECTED_SOURCE]) {
      const source = this.map.getSource(id) as any;
      source?.setData({ type: "FeatureCollection", features: [] });
    }
    for (const id of [SECTION_SOURCE, PATH_SOURCE, LABEL_SOURCE, SELECTED_LAYER]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", "none");
    }
    setSharedDeckLayers("path-analysis", []);
  }

  setData(data: PathAnalysisData) {
    this.selectionToken++;
    this.data?.close();
    this.data = data;
    this.ensureLayerSources();
    const sections = this.map.getSource(SECTION_SOURCE) as any;
    sections?.setData(data.geometry.sections as any);
    if (!this.styleBound) {
      this.map.on("style.load", () => {
        if (!this.data) return;
        // setStyle() drops plugin-owned sources and layers. Rebuild the source
        // graph and rehydrate its data so the network remains selectable.
        this.ensureLayerSources();
        (this.map.getSource(SECTION_SOURCE) as any)?.setData(this.data.geometry.sections as any);
        this.setSelectedFeature(snapshot.selectedSection);
        void this.render();
      });
      this.styleBound = true;
    }
    snapshot = { ...snapshot, selectedSections: [], selectedSection: null, selectedSectionName: null, selectionLoading: false, selectionError: null, selectedVolume: 0, sectionVolumes: [], matches: [] };
    this.setSelectedFeature(null);
    if (!this.bound) {
      this.map.on("click", (event) => {
        const p = event.point;
        const features = this.map.queryRenderedFeatures([[p.x - 8, p.y - 8], [p.x + 8, p.y + 8]], { layers: [SECTION_SOURCE] });
        if (features.length) void this.select({ ...event, features } as MapMouseEvent);
      });
      this.bound = true;
    }
    void this.render();
    notify();
  }

  private ensureLayerSources() {
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of [SECTION_SOURCE, PATH_SOURCE, LABEL_SOURCE, SELECTED_SOURCE]) {
      if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: empty as any });
    }
    if (!this.map.getLayer(SECTION_SOURCE)) this.map.addLayer({ id: SECTION_SOURCE, type: "line", source: SECTION_SOURCE, paint: { "line-color": "#64748b", "line-width": 3, "line-opacity": 0.75 * pathLayerOpacity } });
    if (!this.map.getLayer(PATH_SOURCE)) this.map.addLayer({ id: PATH_SOURCE, type: "line", source: PATH_SOURCE, paint: { "line-color": ["get", "color"], "line-width": 7, "line-offset": ["get", "offset"], "line-opacity": ["*", ["get", "opacity"], pathLayerOpacity] } });
    if (!this.map.getLayer(LABEL_SOURCE)) this.map.addLayer({ id: LABEL_SOURCE, type: "symbol", source: LABEL_SOURCE, layout: { ...MAPLIBRE_LABEL_LAYOUT, "text-field": ["get", "label"], "text-size": snapshot.settings.labelSize }, paint: { ...MAPLIBRE_LABEL_PAINT, "text-opacity": pathLayerOpacity } });
    if (!this.map.getLayer(SELECTED_LAYER)) this.map.addLayer({ id: SELECTED_LAYER, type: "line", source: SELECTED_SOURCE, paint: { "line-color": "#ef4444", "line-width": 9, "line-opacity": pathLayerOpacity } });
  }

  private sectionFeature(id: number) {
    const features = (this.data?.geometry.sections as any)?.features ?? [];
    return features.find((feature: any) => Number(feature.properties?.section_id ?? feature.properties?.id ?? feature.properties?.ID) === id) ?? null;
  }

  getSectionName(id: number) {
    const properties = this.sectionFeature(id)?.properties ?? {};
    const name = properties.name ?? properties.Name ?? properties.section_name ?? properties.sectionName;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }

  private setSelectedFeature(id: number | null) {
    const source = this.map.getSource(SELECTED_SOURCE) as any;
    const feature = id == null ? null : this.sectionFeature(id);
    source?.setData({ type: "FeatureCollection", features: feature ? [{ ...feature, properties: { ...feature.properties, selected: true } }] : [] });
    if (id != null && this.map.getLayer(SELECTED_LAYER)) this.map.moveLayer(SELECTED_LAYER);
  }

  highlightSelectedSection(id: number | null) { this.setSelectedFeature(id); }

  private async select(event: MapMouseEvent) {
    const props = event.features?.[0]?.properties as any;
    const id = Math.trunc(Number(props?.section_id ?? props?.id ?? props?.ID));
    if (!Number.isFinite(id) || !this.data) return;
    const add = event.originalEvent.ctrlKey || event.originalEvent.shiftKey;
    const next = add ? (snapshot.selectedSections.includes(id) ? snapshot.selectedSections.filter((x) => x !== id) : [...snapshot.selectedSections, id]) : [id];
    this.selectionToken++;
    snapshot = { ...snapshot, selectedSections: next, selectedSection: next.includes(id) ? id : (next.at(-1) ?? null), selectedSectionName: this.getSectionName(next.includes(id) ? id : (next.at(-1) ?? null)), selectionLoading: next.length > 0, selectionError: null, selectedVolume: 0, sectionVolumes: [], matches: [] };
    this.setSelectedFeature(snapshot.selectedSection);
    await this.render();
    notify();
    await this.refresh();
  }

  async refresh() {
    const token = ++this.selectionToken;
    const selected = snapshot.selectedSection;
    if (!this.data || !snapshot.selectedSections.length || selected == null) {
      snapshot = { ...snapshot, selectionLoading: false, selectionError: null, selectedVolume: 0, sectionVolumes: [], matches: [] };
      await this.render(); notify(); return;
    }
    snapshot = { ...snapshot, selectionLoading: true, selectionError: null, selectedVolume: 0, sectionVolumes: [], matches: [] };
    await this.render();
    notify();
    try {
      const result = await this.data.querySectionVolumes(snapshot.selectedSections, snapshot.settings.rule, snapshot.settings.interval ?? 0, selected);
      if (token !== this.selectionToken) return;
      snapshot = { ...snapshot, matches: result.matches, selectedVolume: result.selectedVolume, sectionVolumes: result.sections, selectionLoading: false, selectionError: null };
    } catch (error) {
      if (token !== this.selectionToken) return;
      snapshot = { ...snapshot, matches: [], selectedVolume: 0, sectionVolumes: [], selectionLoading: false, selectionError: error instanceof Error ? error.message : String(error) };
    }
    await this.render(); notify();
  }

  async clearSelection() {
    this.selectionToken++;
    snapshot = { ...snapshot, selectedSections: [], selectedSection: null, selectedSectionName: null, selectionLoading: false, selectionError: null, selectedVolume: 0, sectionVolumes: [], matches: [] };
    this.setSelectedFeature(null);
    await this.render(); notify();
  }

  async render() {
    if (!this.data) return;
    this.ensureLayerSources();
    const sectionMap = new Map<number, any>();
    for (const feature of ((this.data.geometry.sections as any).features ?? [])) {
      const p = feature.properties ?? {}, id = Number(p.section_id ?? p.id ?? p.ID);
      if (Number.isFinite(id)) sectionMap.set(id, feature);
    }
    const totalsById = new Map<number, number>();
    const pathFeatures: any[] = [], labels: any[] = [], ribbons: any[] = [];
    const valuesToRender = snapshot.settings.displayMode === "origin-destination"
      ? snapshot.sectionVolumes
      : [...new Map(snapshot.sectionVolumes.map((value) => [value.section_id, { ...value, volume: value.totalVolume, percentage: snapshot.selectedVolume > 0 ? value.totalVolume / snapshot.selectedVolume * 100 : 0, role: value.section_id === snapshot.selectedSection ? "selected" as const : value.role }])).values()];
    for (const value of valuesToRender) {
      const id = value.section_id;
      const feature = sectionMap.get(id); if (!feature) continue;
      totalsById.set(id, value.totalVolume);
      const percentage = Math.max(0, Math.min(100, value.percentage));
      let color: string;
      if (snapshot.settings.displayMode === "origin-destination") {
        if (value.role === "selected") color = "#ef4444";
        else if (value.role === "upstream") color = interpolateColor("#dbeafe", "#1d4ed8", percentage / 100);
        else color = interpolateColor("#dcfce7", "#15803d", percentage / 100);
      } else {
        color = colorToHex(pathColorRgb(snapshot.settings.metric === "trips" ? value.volume : percentage, snapshot.settings.metric));
      }
      const opacity = value.role === "selected" ? 1 : 0.32 + 0.68 * percentage / 100;
      const metricValue = snapshot.settings.metric === "trips" ? value.volume : percentage;
      const offset = snapshot.settings.displayMode === "origin-destination" ? (value.role === "upstream" ? -4 : value.role === "downstream" ? 4 : 0) : 0;
      pathFeatures.push({ type: "Feature", properties: { ...feature.properties, section_id: id, color, opacity, offset, volume: value.volume, percentage, role: value.role, value: metricValue }, geometry: feature.geometry });
      if (snapshot.settings.extruded) for (const line of geometryLines(feature.geometry)) {
        const lateralOffset = snapshot.settings.displayMode === "origin-destination" ? (value.role === "upstream" ? -(PATH_RIBBON_WIDTH_M / 2 + 1) : value.role === "downstream" ? PATH_RIBBON_WIDTH_M / 2 + 1 : 0) : 0;
        const ring = bufferLineToRing(lateralOffset === 0 ? line : offsetLineInMeters(line, lateralOffset), PATH_RIBBON_WIDTH_M);
        if (ring) ribbons.push({ type: "Feature", properties: { color, opacity, value: metricValue, role: value.role }, geometry: { type: "Polygon", coordinates: [ring] } });
      }
    }
    for (const [id, volume] of totalsById) {
      const feature = sectionMap.get(id), coords = flattenCoordinates(feature?.geometry);
      if (!coords.length) continue;
      const percentage = snapshot.selectedVolume > 0 ? volume / snapshot.selectedVolume * 100 : 0;
      const tripsLabel = formatTripVolume(volume);
      const labelPriority = id === snapshot.selectedSection ? 1000 : percentage;
      labels.push({ type: "Feature", properties: { priority: labelPriority, label: snapshot.settings.metric === "trips" ? `${tripsLabel} trips` : (percentage > 0 && percentage < 1 ? "<1%" : `${percentage.toFixed(1)}%`) }, geometry: { type: "Point", coordinates: coords[Math.floor(coords.length / 2)] } });
    }
    labels.sort((a, b) => b.properties.priority - a.properties.priority);
    const set = (id: string, data: any) => (this.map.getSource(id) as any)?.setData(data);
    set(PATH_SOURCE, { type: "FeatureCollection", features: pathFeatures });
    set(LABEL_SOURCE, { type: "FeatureCollection", features: labels });
    this.setSelectedFeature(snapshot.selectedSection);
    const visible = snapshot.settings.visible && pathAnalysisLayerVisible;
    for (const id of [SECTION_SOURCE, PATH_SOURCE, LABEL_SOURCE, SELECTED_LAYER]) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    if (this.map.getLayer(LABEL_SOURCE)) {
      this.map.setLayoutProperty(LABEL_SOURCE, "text-size", snapshot.settings.labelSize);
      this.map.setLayoutProperty(LABEL_SOURCE, "text-allow-overlap", false);
      this.map.setLayoutProperty(LABEL_SOURCE, "text-ignore-placement", false);
      this.map.setLayoutProperty(LABEL_SOURCE, "text-padding", 6);
    }
    const generation = ++this.renderGeneration;
    if (this.app.getDeckGL) void this.app.getDeckGL().then(async (deck: any) => {
      if (generation !== this.renderGeneration) return;
      await ensureSharedDeckOverlay(this.app);
      if (generation !== this.renderGeneration) return;
      setSharedDeckLayers("path-analysis", visible && snapshot.settings.extruded ? [new deck.layers.PolygonLayer({ id: "geolibre-path-analysis-3d", data: ribbons, getPolygon: (d: any) => d.geometry.coordinates[0], getFillColor: (d: any) => hexToRgba(d.properties.color, d.properties.opacity * pathLayerOpacity), getElevation: (d: any) => d.properties.role === "selected" ? snapshot.settings.maxHeightM : pathElevation(d.properties.value, snapshot.settings.metric, snapshot.settings.maxHeightM), extruded: true, filled: true, stroked: false, pickable: false, ...depthOcclusionParameters(snapshot.settings.seeThroughBuildings) } as any)] : []);
    }).catch((error) => console.warn("[GeoLibre] path-analysis: deck overlay failed", error));
  }
}

function flattenCoordinates(geometry: any): [number, number][] {
  if (geometry?.type === "LineString") return geometry.coordinates;
  if (geometry?.type === "MultiLineString") return geometry.coordinates.flat();
  return [];
}
function geometryLines(geometry: any): [number, number][][] { return geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.type === "MultiLineString" ? geometry.coordinates : []; }
function offsetLineInMeters(line: [number, number][], offsetM: number): [number, number][] {
  return line.map(([lon, lat], index) => {
    const before = line[Math.max(0, index - 1)], after = line[Math.min(line.length - 1, index + 1)];
    const meanLat = lat * Math.PI / 180, dx = (after[0] - before[0]) * 111320 * Math.cos(meanLat), dy = (after[1] - before[1]) * 110540;
    const length = Math.hypot(dx, dy) || 1, ox = -dy / length * offsetM, oy = dx / length * offsetM;
    return [lon + ox / (111320 * Math.cos(meanLat) || 1), lat + oy / 110540] as [number, number];
  });
}
function colorToHex(rgb: number[]) { return `#${rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`; }
function hexToRgba(hex: string, alpha: number): [number, number, number, number] { const value = Number.parseInt(hex.slice(1), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255, Math.round(alpha * 255)]; }
function interpolateColor(a: string, b: string, t: number) { const parse = (x: string) => [1, 3, 5].map((i) => Number.parseInt(x.slice(i, i + 2), 16)); const aa = parse(a), bb = parse(b); return `#${aa.map((v, i) => Math.round(v + (bb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`; }

export const maplibrePathAnalysisPlugin:GeoLibrePlugin={id:PATH_ANALYSIS_PLUGIN_ID,name:"Path analysis",version:"2.0.0",activate:app=>{openPathAnalysisPanel(app);return true},deactivate:()=>{void engine?.clearSelection();closePathAnalysisPanel();engine=null},getProjectState:()=>snapshot.settings,applyProjectState:(_a,s)=>{snapshot={...snapshot,settings:{...snapshot.settings,...s as any}};return true}};

export function applyPathAnalysisVisualSettings(settings: Pick<PathAnalysisSettings, "labelSize" | "visible">) {
  const map = appRef?.getMap?.() as any;
  if (!map) return;
  const visibility = settings.visible && pathAnalysisLayerVisible ? "visible" : "none";
  for (const id of [SECTION_SOURCE, PATH_SOURCE, LABEL_SOURCE, SELECTED_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }
  if (map.getLayer(LABEL_SOURCE)) {
    map.setLayoutProperty(LABEL_SOURCE, "text-size", settings.labelSize);
    map.setLayoutProperty(LABEL_SOURCE, "text-allow-overlap", false);
    map.setLayoutProperty(LABEL_SOURCE, "text-ignore-placement", false);
    map.setLayoutProperty(LABEL_SOURCE, "text-padding", 4);
  }
  if (map.getLayer(PATH_SOURCE)) map.setPaintProperty(PATH_SOURCE, "line-color", ["get", "color"]);
}
