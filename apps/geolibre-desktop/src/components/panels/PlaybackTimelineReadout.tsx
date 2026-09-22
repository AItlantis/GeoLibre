import type { SimulationTimeline } from "@geolibre/plugins";
import { formatSimulationTime, timelineTimeAtSliceIndex } from "@geolibre/plugins";

export function PlaybackTimelineReadout({ timeline, currentSeconds, intervalSeconds }: { timeline?: SimulationTimeline | null; currentSeconds?: number | null; intervalSeconds?: number | null }) {
  if (!timeline) return null;
  const current = currentSeconds ?? timeline.initialTimeSeconds;
  return (
    <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground" aria-label="Simulation time">
      <span>Start <b className="text-foreground">{formatSimulationTime(timeline.initialTimeSeconds)}</b></span>
      <span>Current <b className="text-foreground">{formatSimulationTime(current)}</b></span>
      <span>End <b className="text-foreground">{formatSimulationTime(timeline.finalTimeSeconds)}</b></span>
      {intervalSeconds != null && <span className="col-span-3">Interval <b className="text-foreground">{Math.round(intervalSeconds)} s</b></span>}
    </div>
  );
}

export function intervalCurrentSeconds(timeline: SimulationTimeline | null | undefined, intervals: readonly number[], interval: number): number | null {
  if (!timeline || interval === 0) return timeline?.initialTimeSeconds ?? null;
  const index = intervals.filter((value) => value !== 0).indexOf(interval);
  return index < 0 ? null : timelineTimeAtSliceIndex(timeline, index);
}
