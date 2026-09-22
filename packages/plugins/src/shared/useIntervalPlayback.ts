import { useMemo } from "react";

export interface IntervalPlaybackDerivation {
  /** Every real time slice, excluding the `0` whole-period-aggregate sentinel. */
  realIntervals: number[];
  /** Index of the currently selected interval within `realIntervals`, clamped to 0. */
  scrubberIndex: number;
  /** Whether the scrubber/step controls have anything to operate on (>=1 real interval). */
  hasRealIntervals: boolean;
  /** Whether the "whole period" aggregate is the active selection. */
  isAggregate: boolean;
}

/**
 * Pure derivation shared by Network KPI, Emissions H3 and Scenario
 * Comparison's interval scrubber: which real (non-aggregate) intervals exist,
 * where the scrubber sits among them, and whether the `interval === 0`
 * whole-period aggregate sentinel is the active selection.
 *
 * Extracted as a plain function (not a hook) so it is directly unit-testable
 * without a React renderer, per the DuckDB-free extraction pattern already
 * used for `parquet-catalog.ts` / `emissions-h3-ramps.ts`. `useIntervalPlayback`
 * below is the thin hook wrapper panels actually call.
 *
 * Re-derives the shape duplicated (with differing local variable names, e.g.
 * `realIntervals` in NetworkKpiPanel, `values` in the scenario-comparison and
 * emissions-h3 plugin modules) across all three panels/plugins.
 */
export function deriveIntervalPlayback(
  intervals: readonly number[],
  currentInterval: number,
): IntervalPlaybackDerivation {
  const realIntervals = intervals.filter((value) => value !== 0);
  const rawIndex = realIntervals.indexOf(currentInterval);
  return {
    realIntervals,
    scrubberIndex: Math.max(0, rawIndex),
    hasRealIntervals: realIntervals.length > 0,
    isAggregate: currentInterval === 0,
  };
}

/**
 * Step to the next/previous real interval, wrapping around, and starting at
 * the first (or last, stepping backward) frame when currently on the
 * aggregate or on a value outside the real slices.
 *
 * Mirrors `stepNetworkKpiInterval` / `stepEmissionsH3Interval` /
 * `stepScenarioComparisonInterval`'s shared logic. Returns `null` when there
 * are fewer than two real intervals to step between (a no-op in the plugins).
 */
export function stepInterval(
  intervals: readonly number[],
  currentInterval: number,
  direction: 1 | -1,
): number | null {
  const realIntervals = intervals.filter((value) => value !== 0);
  if (realIntervals.length < 2) return null;
  const currentIndex = realIntervals.indexOf(currentInterval);
  return currentIndex === -1
    ? realIntervals[direction === 1 ? 0 : realIntervals.length - 1]
    : realIntervals[(currentIndex + direction + realIntervals.length) % realIntervals.length];
}

/** Shared timer controller for module-level interval playback. */
export interface IntervalPlaybackController {
  sync(playing: boolean, intervalMs?: number): void;
  dispose(): void;
}

export interface PlaybackSemantics {
  playing: boolean;
  speed: number;
  loop: boolean;
}

export const DEFAULT_PLAYBACK_SEMANTICS: PlaybackSemantics = { playing: false, speed: 1, loop: true };

export function normalizePlaybackSemantics(value: Partial<PlaybackSemantics> | null | undefined): PlaybackSemantics {
  const speed = Number(value?.speed);
  return {
    playing: value?.playing === true,
    speed: Number.isFinite(speed) ? Math.min(16, Math.max(0.1, speed)) : 1,
    loop: value?.loop !== false,
  };
}

export function stepPlaybackIndex(index: number, count: number, direction: 1 | -1, loop: boolean): { index: number; playing: boolean } {
  if (count <= 0) return { index: 0, playing: false };
  const next = index + direction;
  if (next >= 0 && next < count) return { index: next, playing: true };
  if (loop) return { index: (next + count) % count, playing: true };
  return { index: Math.min(count - 1, Math.max(0, next)), playing: false };
}

export function createIntervalPlaybackController(onStep: () => void, intervalMs = 1000): IntervalPlaybackController {
  let timer: ReturnType<typeof setInterval> | null = null;
  const dispose = () => { if (timer) clearInterval(timer); timer = null; };
  return { sync(playing, nextIntervalMs = intervalMs) { dispose(); if (playing) timer = setInterval(onStep, Math.max(50, nextIntervalMs)); }, dispose };
}

/**
 * Toggle the aggregate checkbox: checking it selects the `0` sentinel;
 * unchecking it falls back to the first real interval (or `0` again if there
 * are none, matching the plugins' own guard against selecting a value that
 * does not exist).
 */
export function toggleAggregateInterval(
  intervals: readonly number[],
  checked: boolean,
): number {
  if (checked) return 0;
  const realIntervals = intervals.filter((value) => value !== 0);
  return realIntervals[0] ?? 0;
}

export interface UseIntervalPlaybackArgs {
  intervals: readonly number[];
  interval: number;
  onIntervalChange: (interval: number) => void;
  onStep: (direction: 1 | -1) => void;
  onTogglePlaying: () => void;
}

export interface UseIntervalPlaybackResult extends IntervalPlaybackDerivation {
  /** Move the scrubber to the real interval at this index within `realIntervals`. */
  setScrubberIndex: (index: number) => void;
  /** Step to the next/previous real interval (delegates to the plugin's own stepper). */
  step: (direction: 1 | -1) => void;
  /** Set/clear the whole-period aggregate. */
  setAggregate: (checked: boolean) => void;
  /** Toggle interval-cycling playback (the play/pause timer stays module-level in the plugin). */
  togglePlaying: () => void;
}

/**
 * Thin per-render wrapper around {@link deriveIntervalPlayback}, plus the
 * setter callbacks the panel wires to its scrubber/step/aggregate/play
 * controls.
 *
 * Deliberately does NOT own the play/pause timer itself — each plugin's
 * `setInterval`-driven auto-advance stays module-level (`intervalTimer` in
 * maplibre-network-kpi.ts, `timer` in maplibre-emissions-h3.ts /
 * maplibre-scenario-comparison.ts) precisely so it survives the panel
 * component unmounting and remounting while playback continues.
 */
export function useIntervalPlayback(args: UseIntervalPlaybackArgs): UseIntervalPlaybackResult {
  const { intervals, interval, onIntervalChange, onStep, onTogglePlaying } = args;
  const derived = useMemo(() => deriveIntervalPlayback(intervals, interval), [intervals, interval]);

  return {
    ...derived,
    setScrubberIndex: (index: number) => {
      const target = derived.realIntervals[index];
      if (target !== undefined) onIntervalChange(target);
    },
    step: onStep,
    setAggregate: (checked: boolean) => {
      onIntervalChange(toggleAggregateInterval(intervals, checked));
    },
    togglePlaying: onTogglePlaying,
  };
}
