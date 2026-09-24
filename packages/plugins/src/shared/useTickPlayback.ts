import { formatSimulationTime } from "./simulation-timeline";

/**
 * Format a tick position as the scenario-local simulation clock.
 *
 * Extracted verbatim from `formatSimClock` in VehiclePlaybackPanel.tsx, which
 * is the only panel with this tick/dt-based clock — Network KPI, Emissions H3
 * and Scenario Comparison are interval-indexed instead (see
 * `useIntervalPlayback.ts`), a genuinely different state shape. Kept as a
 * standalone function so it is directly unit-testable without React.
 */
export function formatSimClock(tick: number, dt: number, initialTimeSeconds = 0): string {
  return formatSimulationTime(Math.max(0, initialTimeSeconds + tick * dt));
}

export interface TickTimelineProps {
  min: number;
  max: number;
  step: number;
  value: number;
  disabled: boolean;
}

/**
 * Prop wiring for the vehicle-playback timeline `<input type="range">`.
 *
 * Mirrors VehiclePlaybackPanel's inline `min={0} max={Math.max(1, maxTick)}
 * step={1} value={Math.round(tick)} disabled={!hasPackage}` — pulled out so
 * the derivation (in particular the `Math.max(1, maxTick)` guard against a
 * zero-width range before a package loads) lives in one tested place.
 */
export function tickTimelineProps(tick: number, maxTick: number, hasPackage: boolean): TickTimelineProps {
  return {
    min: 0,
    max: Math.max(1, maxTick),
    step: 1,
    value: Math.round(tick),
    disabled: !hasPackage,
  };
}

export interface UseTickPlaybackArgs {
  tick: number;
  dt: number;
  initialTimeSeconds?: number;
  maxTick: number;
  hasPackage: boolean;
}

export interface UseTickPlaybackResult {
  /** Scenario-local clock formatted as `HH:MM:SS`. */
  clock: string;
  /** Props ready to spread onto the timeline `<input type="range">`. */
  timeline: TickTimelineProps;
}

/**
 * Vehicle-Playback-only playback hook: owns clock formatting and timeline
 * range-input prop wiring.
 *
 * Deliberately NOT unified with `useIntervalPlayback` (confirmed by review):
 * ticks are a continuous float position within `[0, maxTick]`, driven by a
 * `requestAnimationFrame` clock, whereas interval playback steps through a
 * discrete list of database-reported values plus an aggregate sentinel.
 * Forcing one hook to cover both would need a branchy mode flag for no real
 * code reuse.
 */
export function useTickPlayback(args: UseTickPlaybackArgs): UseTickPlaybackResult {
  const { tick, dt, initialTimeSeconds = 0, maxTick, hasPackage } = args;
  return {
    clock: formatSimClock(tick, dt, initialTimeSeconds),
    timeline: tickTimelineProps(tick, maxTick, hasPackage),
  };
}
