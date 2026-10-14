import type { Pt, FC, Feature } from "./calc.ts";
import { jenksBreaks, volumeOpacity } from "../analytics.ts";

/** One colour language across dots, ends, bars, labels and the legend. */
export const OD_COLORS = { origin: "#e66100", destination: "#1c71d8", both: "#7e3fa8", line: "#26547c", dot: "#8a8f98", group: "#596a7b" } as const;
/** Centre offset (m) of each of the two bars: they touch with a small gap, never overlap (offset > size/2). */
export function barOffset(size: number): number { return Math.max(1, size) * 0.6; }

export interface Zone { id: string; name: string; group: string; lon: number; lat: number }
export interface Flow { origin: string; destination: string; trips: number }
export interface GroupNode { id: string; name: string; lon: number; lat: number; trips: number; members: number }

/** Trip-weighted group location, with member volume based on incident trips. */
export function aggregateGroups(zones: readonly Zone[], flows: readonly Flow[]): GroupNode[] {
  const volume = new Map<string, number>();
  for (const f of flows) {
    if (!Number.isFinite(f.trips)) continue;
    volume.set(f.origin, (volume.get(f.origin) ?? 0) + f.trips);
    volume.set(f.destination, (volume.get(f.destination) ?? 0) + f.trips);
  }
  const groups = new Map<string, { w: number; lon: number; lat: number; members: number; trips: number }>();
  for (const z of zones) {
    if (!Number.isFinite(z.lon) || !Number.isFinite(z.lat)) continue;
    const v = Math.max(0, volume.get(z.id) ?? 0);
    const a = groups.get(z.group) ?? { w: 0, lon: 0, lat: 0, members: 0, trips: 0 };
    const weight = v || 1;
    a.w += weight; a.lon += z.lon * weight; a.lat += z.lat * weight; a.members++; a.trips += v;
    groups.set(z.group, a);
  }
  return [...groups].map(([name, a]) => ({ id: name, name, lon: a.lon / a.w, lat: a.lat / a.w, trips: a.trips, members: a.members }));
}

export function aggregateGroupFlows(flows: readonly Flow[], groupByZone: ReadonlyMap<string, string>): Flow[] {
  const sums = new Map<string, Flow>();
  for (const f of flows) {
    const origin = groupByZone.get(f.origin) ?? f.origin, destination = groupByZone.get(f.destination) ?? f.destination;
    const key = `${origin}\u0000${destination}`, row = sums.get(key) ?? { origin, destination, trips: 0 };
    row.trips += f.trips; sums.set(key, row);
  }
  return [...sums.values()];
}

export function barHeight(trips: number, metresPerThousand: number, cap: number, logarithmic = false): number {
  if (!(trips > 0) || !(metresPerThousand > 0) || !(cap > 0)) return 0;
  const linear = trips / 1000 * metresPerThousand;
  const h = logarithmic ? metresPerThousand * Math.log1p(trips / 1000) : linear;
  return Math.min(cap, h);
}

export function barSquare(lon: number, lat: number, offsetMetres: number, sizeMetres: number): Pt[] {
  const dLat = sizeMetres / 111320, dLon = sizeMetres / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  const cx = lon + offsetMetres / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  const cy = lat;
  return [[cx-dLon/2,cy-dLat/2],[cx+dLon/2,cy-dLat/2],[cx+dLon/2,cy+dLat/2],[cx-dLon/2,cy+dLat/2],[cx-dLon/2,cy-dLat/2]];
}

export interface LegendConfig { neutral: number; decrease: number; increase: number; scheme: "RdBu" | "PuOr" | "blue-orange"; classification: "linear" | "quantile" | "jenks" | "manual"; breaks: number[]; classes?: number; opacityFollowsVolume?: boolean }
export function validateLegend(c: LegendConfig): boolean {
  return Number.isFinite(c.neutral) && c.neutral > 0 && Number.isFinite(c.decrease) && c.decrease > c.neutral && Number.isFinite(c.increase) && c.increase > c.neutral && (c.classification !== "manual" || c.breaks.length > 0) && c.breaks.every(x=>Number.isFinite(x)&&x>0) && c.breaks.every((x,i,a) => i === 0 || x > a[i-1]);
}
export function quantileBreaks(values: readonly number[], classes = 5): number[] {
  const a = values.filter(Number.isFinite).map(Math.abs).sort((x,y) => x-y);
  return Array.from({length: Math.max(1, classes)-1}, (_,i) => a.length ? a[Math.min(a.length-1, Math.floor((i+1)*a.length/classes))] : 0);
}
export function classifyValue(value: number, c: LegendConfig, data: readonly number[] = []): number {
  if (c.classification === "manual") return c.breaks.filter((b) => Math.abs(value) >= b).length;
  if (c.classification === "quantile") return quantileBreaks(data).filter((b) => Math.abs(value) >= b).length;
  if (c.classification === "jenks") return jenksBreaks(data.filter(v => Math.sign(v) === Math.sign(value)).map(Math.abs), Math.max(3, Math.min(9, c.classes ?? 5))).filter((b) => Math.abs(value) >= b).length;
  return Math.min(c.classes ?? 5, Math.floor(Math.abs(value) / Math.max(1e-9, value < 0 ? c.decrease : c.increase) * (c.classes ?? 5)));
}
export function legendColor(value: number, c: LegendConfig, data: readonly number[] = []): string {
  if(Math.abs(value)<=c.neutral) return "#f7f7f7";
  const limit=value<0?c.decrease:c.increase;
  let magnitude=Math.max(0,Math.min(1,Math.abs(value)/limit));
  if(c.classification==="manual"&&c.breaks.length)magnitude=Math.max(1,c.breaks.filter(b=>Math.abs(value)>=b).length)/c.breaks.length;
  if(c.classification==="quantile"){const cuts=quantileBreaks(data);if(cuts.length)magnitude=Math.max(1,cuts.filter(b=>Math.abs(value)>=b).length)/cuts.length;}
  if(c.classification==="jenks"){const cuts=jenksBreaks(data.filter(v=>Math.sign(v)===Math.sign(value)).map(Math.abs),Math.max(3,Math.min(9,c.classes??5)));if(cuts.length)magnitude=Math.max(1,cuts.filter(b=>Math.abs(value)>=b).length)/cuts.length;}
  const t = Math.sign(value)*magnitude;
  const ramps: Record<LegendConfig["scheme"], [number[],number[],number[]]> = {
    RdBu: [[33,102,172],[247,247,247],[178,24,43]], PuOr: [[118,42,131],[247,247,247],[230,97,1]], "blue-orange": [[0,114,178],[255,255,255],[230,159,0]],
  };
  const [lo,mid,hi] = ramps[c.scheme], end = t < 0 ? lo : hi, ratio = Math.abs(t);
  return `#${mid.map((v,i) => Math.round(v+(end[i]-v)*ratio).toString(16).padStart(2,"0")).join("")}`;
}
export { volumeOpacity };
export function bellHeight(t: number, peak: number): number { const x = Math.max(0, Math.min(1, t)); return Math.max(0, 4*x*(1-x)*Math.max(0, peak)); }
export function animationPhase(nowMs: number, speed: number, paused: boolean): number { return paused ? 0 : ((Math.max(0,nowMs)*Math.max(0,speed)/1000)%1); }

export function tabsEnabled(available: readonly string[]): { trips: true; beforeAfter: boolean; difference: boolean } {
  const both = available.includes("before") && available.includes("after");
  return { trips: true, beforeAfter: both, difference: both };
}

export function barsGeoJson(rows: readonly { id:string; name:string; lon:number; lat:number; origins:number; destinations:number }[], scale:number, cap:number, logarithmic=false, size=50): FC {
  const off = barOffset(size);
  const features: Feature<{type:"Polygon";coordinates:Pt[][]}>[] = [];
  for (const r of rows) for (const [kind,value,offset,color] of [["origin",r.origins,-off,OD_COLORS.origin],["destination",r.destinations,off,OD_COLORS.destination]] as const) {
    features.push({type:"Feature",geometry:{type:"Polygon",coordinates:[barSquare(r.lon,r.lat,offset,size)]},properties:{id:r.id,kind,height:barHeight(value,scale,cap,logarithmic),trips:value,c:color,tip:`${r.name} (${r.id})\nOrigins: ${r.origins}\nDestinations: ${r.destinations}\nNet: ${r.origins-r.destinations}`}});
  }
  return {type:"FeatureCollection",features};
}

export function beforeAfterBarsGeoJson(rows: readonly {id:string;name:string;lon:number;lat:number;prodBefore:number;prodAfter:number;attrBefore:number;attrAfter:number}[], scale:number, cap:number, size=18, logarithmic=false): FC {
  const features: Feature<{type:"Polygon";coordinates:Pt[][]}>[]=[];
  for(const r of rows) for(const [kind,value,offset,color] of [["origins before",r.prodBefore,-45,"#f2b987"],["origins after",r.prodAfter,-15,OD_COLORS.origin],["destinations before",r.attrBefore,15,"#8db8ec"],["destinations after",r.attrAfter,45,OD_COLORS.destination]] as const){
    features.push({type:"Feature",geometry:{type:"Polygon",coordinates:[barSquare(r.lon,r.lat,offset,size)]},properties:{id:r.id,kind,height:barHeight(value,scale,cap,logarithmic),trips:value,c:color,tip:`${r.name} (${r.id})\nOrigins: ${r.prodBefore} → ${r.prodAfter} (Δ ${r.prodAfter-r.prodBefore})\nDestinations: ${r.attrBefore} → ${r.attrAfter} (Δ ${r.attrAfter-r.attrBefore})`}});
  }
  return {type:"FeatureCollection",features};
}

/** Small tapered extrusion segments whose heights trace a parabolic desire-line arch. */
export function archRibbon(o: Pt, d: Pt, peak: number, widthMetres: number, parts=12): FC {
  const dx=d[0]-o[0],dy=d[1]-o[1],len=Math.hypot(dx,dy)||1;
  const features: Feature<{type:"Polygon";coordinates:Pt[][]}>[]=[];
  for(let i=0;i<parts;i++){
    const t0=i/parts,t1=(i+1)/parts;
    const p0:[number,number]=[o[0]+dx*t0,o[1]+dy*t0],p1:[number,number]=[o[0]+dx*t1,o[1]+dy*t1];
    const lat=(p0[1]+p1[1])/2,scaleX=111320*Math.max(.01,Math.cos(lat*Math.PI/180)),scaleY=111320;
    const nx=-dy/len*widthMetres/2/scaleX,ny=dx/len*widthMetres/2/scaleY;
    features.push({type:"Feature",geometry:{type:"Polygon",coordinates:[[[p0[0]+nx,p0[1]+ny],[p1[0]+nx,p1[1]+ny],[p1[0]-nx,p1[1]-ny],[p0[0]-nx,p0[1]-ny],[p0[0]+nx,p0[1]+ny]]]},properties:{base:0,height:bellHeight((t0+t1)/2,peak),c:"#3979ad",phase:t0}});
  }
  return {type:"FeatureCollection",features};
}

