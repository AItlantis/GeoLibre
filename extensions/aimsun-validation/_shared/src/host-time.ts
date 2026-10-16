/**
 * Host-owned time model shared by the Aimsun analysis plugins (contract C15).
 * All times are seconds since midnight; end_s may exceed 86400.
 */

/** Window + cursor pushed by the host (`setTimeWindow`). from_s <= cursor_s < to_s. */
export interface HostTimeWindow {
  from_s: number;
  to_s: number;
  cursor_s: number;
}

export interface HostAnalysisPeriod {
  start_s: number;
  end_s: number;
  interval_s: number;
}

export type HostCursorMode = "window" | "cursor";

/** Info a plugin reports to the host through the callback given to `onHostInfo(cb)`. */
export interface HostAnalysisInfo {
  plugin: string;
  run: string | null;
  generation: number;
  period: HostAnalysisPeriod | null;
  bucket_s: number | null;
  mode: string | null;
  cursorMode: HostCursorMode;
  busy: boolean;
}

export type HostInfoCallback = (info: HostAnalysisInfo) => void;

/** Optional plugin hooks driven by the bridge. */
export interface HostTimeAwarePlugin {
  setTimeWindow?(win: HostTimeWindow): void;
  onHostInfo?(cb: HostInfoCallback | null): void;
}

/**
 * Auto bucket: w <= 3h -> 900 s; w <= 8h -> 1800 s; else 3600 s.
 * Never smaller than interval_s; if w <= interval_s the whole window is one bucket.
 */
export function autoBucketSeconds(from_s: number, to_s: number, interval_s: number): number {
  const w = to_s - from_s;
  const interval = Number.isFinite(interval_s) && interval_s > 0 ? interval_s : 0;
  if (!(w > 0)) return interval > 0 ? interval : 900;
  if (interval > 0 && w <= interval) return w;
  const base = w <= 3 * 3600 ? 900 : w <= 8 * 3600 ? 1800 : 3600;
  return interval > 0 ? Math.max(base, interval) : base;
}

export function isFiniteWindow(win: { from_s: unknown; to_s: unknown; cursor_s: unknown }): win is HostTimeWindow {
  return (
    typeof win.from_s === "number" && Number.isFinite(win.from_s) &&
    typeof win.to_s === "number" && Number.isFinite(win.to_s) &&
    typeof win.cursor_s === "number" && Number.isFinite(win.cursor_s) &&
    win.from_s <= win.cursor_s && win.cursor_s < win.to_s
  );
}

/** Clamp a window into [start_s, end_s] and keep from <= cursor < to. Returns null if the period is empty. */
export function clampWindow(win: HostTimeWindow, period: { start_s: number; end_s: number }): HostTimeWindow | null {
  if (!(period.end_s > period.start_s)) return null;
  const from_s = Math.min(Math.max(win.from_s, period.start_s), period.end_s);
  const to_s = Math.min(Math.max(win.to_s, from_s), period.end_s);
  if (!(to_s > from_s)) return null;
  const cursor_s = Math.min(Math.max(win.cursor_s, from_s), Math.max(from_s, to_s - 1e-6));
  return { from_s, to_s, cursor_s };
}

/** Snap a time down onto the interval grid anchored at start_s (clamped to the period). */
export function snapToInterval(t_s: number, start_s: number, interval_s: number, end_s?: number): number {
  let v = t_s;
  if (interval_s > 0) v = start_s + Math.floor((t_s - start_s) / interval_s) * interval_s;
  if (v < start_s) v = start_s;
  if (end_s !== undefined && v > end_s) v = end_s;
  return v;
}

/** Index of the bucket (width interval_s from start_s) containing the cursor, clamped to [0, count-1]. */
export function bucketIndexAt(cursor_s: number, start_s: number, interval_s: number, count: number): number {
  if (!(interval_s > 0) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((cursor_s - start_s) / interval_s)));
}
