import type { SimulationTimeline } from "../shared/simulation-timeline";
import { timelineTimeAtSliceIndex } from "../shared/simulation-timeline";

/** One pair of result intervals that refer to the same absolute simulation time. */
export interface MatchedScenarioInterval {
  entA: number;
  entB: number;
  timeSeconds: number;
}

export interface ScenarioIntervalMatch {
  intervals: MatchedScenarioInterval[];
  aggregateAvailable: boolean;
  reason: "missing-timeline" | "period-mismatch" | "no-matching-times" | null;
}

export const SCENARIO_TIME_TOLERANCE_SECONDS = 1e-6;

/**
 * Resolve Aimsun's documented 1-based statistics interval to the provider's
 * zero-based timeline position. Interval 0 is the whole-period aggregate and
 * deliberately has no point in time.
 */
export function scenarioIntervalTime(
  ent: number,
  timeline: SimulationTimeline | null | undefined,
): number | null {
  if (!Number.isInteger(ent) || ent < 1 || !timeline) return null;
  const count = timeline.intervalCount;
  if (!Number.isInteger(count) || count == null || count < 1 || ent > count) return null;
  return timelineTimeAtSliceIndex(timeline, ent - 1, count);
}

function periodBounds(timeline: SimulationTimeline | null | undefined): [number, number] | null {
  if (!timeline || timeline.initialTimeSeconds == null || !Number.isFinite(timeline.initialTimeSeconds)) return null;
  const duration = timeline.durationSeconds ?? (
    timeline.intervalCount != null && timeline.intervalDurationSeconds != null
      ? timeline.intervalCount * timeline.intervalDurationSeconds
      : null
  );
  if (duration == null || !Number.isFinite(duration) || duration < 0) return null;
  return [timeline.initialTimeSeconds, timeline.initialTimeSeconds + duration];
}

function samePeriod(a: SimulationTimeline | null | undefined, b: SimulationTimeline | null | undefined): boolean {
  const boundsA = periodBounds(a);
  const boundsB = periodBounds(b);
  return Boolean(boundsA && boundsB
    && Math.abs(boundsA[0] - boundsB[0]) <= SCENARIO_TIME_TOLERANCE_SECONDS
    && Math.abs(boundsA[1] - boundsB[1]) <= SCENARIO_TIME_TOLERANCE_SECONDS);
}

/**
 * Match intervals by resolved absolute time, never by `ent` equality or rank.
 * `ent` is 1-based and each side's result ID is retained for its own query.
 */
export function matchScenarioIntervals(
  intervalsA: readonly number[],
  timelineA: SimulationTimeline | null | undefined,
  intervalsB: readonly number[],
  timelineB: SimulationTimeline | null | undefined,
): ScenarioIntervalMatch {
  if (!timelineA || !timelineB) {
    return { intervals: [], aggregateAvailable: false, reason: "missing-timeline" };
  }
  if (!samePeriod(timelineA, timelineB)) {
    return { intervals: [], aggregateAvailable: false, reason: "period-mismatch" };
  }

  const byTimeB = intervalsB
    .filter((ent) => ent !== 0)
    .map((ent) => ({ ent, timeSeconds: scenarioIntervalTime(ent, timelineB) }))
    .filter((item): item is { ent: number; timeSeconds: number } => item.timeSeconds != null)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);

  const intervals: MatchedScenarioInterval[] = [];
  let bIndex = 0;
  for (const entA of [...new Set(intervalsA)].filter((ent) => ent !== 0).sort((a, b) => a - b)) {
    const timeA = scenarioIntervalTime(entA, timelineA);
    if (timeA == null) continue;
    while (bIndex < byTimeB.length && byTimeB[bIndex].timeSeconds < timeA - SCENARIO_TIME_TOLERANCE_SECONDS) bIndex += 1;
    const candidate = byTimeB[bIndex];
    if (candidate && Math.abs(candidate.timeSeconds - timeA) <= SCENARIO_TIME_TOLERANCE_SECONDS) {
      intervals.push({ entA, entB: candidate.ent, timeSeconds: (timeA + candidate.timeSeconds) / 2 });
      bIndex += 1;
    }
  }

  return {
    intervals,
    aggregateAvailable: intervalsA.includes(0) && intervalsB.includes(0) && samePeriod(timelineA, timelineB),
    reason: intervals.length ? null : "no-matching-times",
  };
}
