export type PathMetric = "percentage" | "trips";
export const PATH_METRICS: readonly PathMetric[] = ["percentage", "trips"];
export const PATH_RAMPS = { percentage: { stops: [0,25,50,75,100], colors: ["#dbeafe","#60a5fa","#22c55e","#f59e0b","#dc2626"], unit: "%", label: "Percentage" }, trips: { stops: [0,25,100,500,2000], colors: ["#dbeafe","#60a5fa","#22c55e","#f59e0b","#dc2626"], unit: "trips", label: "Trips" } } as const;
function rgb(h:string){const n=Number.parseInt(h.slice(1),16);return [n>>16&255,n>>8&255,n&255]}
export function pathColorRgb(v:number,m:PathMetric):[number,number,number]{const r=PATH_RAMPS[m],x=Math.max(r.stops[0],Math.min(r.stops[4],v));let i=r.stops.findIndex(s=>s>=x);if(i<=0)return rgb(r.colors[0]) as [number,number,number];if(i<0)i=4;const a=r.stops[i-1],b=r.stops[i],p=rgb(r.colors[i-1]),q=rgb(r.colors[i]),t=(x-a)/(b-a);return [0,1,2].map(k=>Math.round(p[k]+(q[k]-p[k])*t)) as [number,number,number]}
export function pathElevation(v:number,m:PathMetric,max:number){return .1+Math.max(0,Math.min(1,v/PATH_RAMPS[m].stops[4]))*(max-.1)}
export interface PathPercentageMatch { demand:number; percentage:number; }
/** Express each matched route as a share of the selected section's matched demand. */
export function normalizeSelectedPathPercentages<T extends PathPercentageMatch>(matches:readonly T[]):T[]{const numeric=matches.map(match=>({...match,demand:Number(match.demand),percentage:Number(match.percentage)}));const total=numeric.reduce((sum,match)=>sum+(Number.isFinite(match.demand)&&match.demand>0?match.demand:0),0);return numeric.map(match=>({...match,percentage:total>0&&Number.isFinite(match.demand)&&match.demand>0?match.demand/total:0}))}
export function pathMetricValue(match:Pick<PathPercentageMatch,"demand"|"percentage">,metric:PathMetric):number{return metric==="trips"?match.demand:match.percentage*100}
export function pathMetricRampExpression(metric:PathMetric):unknown[]{const expression:unknown[]=["interpolate",["linear"],["get","value"]];PATH_RAMPS[metric].stops.forEach((stop,index)=>expression.push(stop,PATH_RAMPS[metric].colors[index]));return expression}
