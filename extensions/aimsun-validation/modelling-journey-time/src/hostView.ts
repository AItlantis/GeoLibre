/**
 * Host-managed view helpers (contract C15). Pure functions, no DOM: the Testudo host owns the time window
 * and cursor; the plugin only maps them onto its 15-minute bucket and reports the period it can show.
 */
import type { HostAnalysisInfo, HostAnalysisPeriod, HostTimeWindow } from "../../_shared/src/host-time";
import { derivePeriod, type PeriodInfo } from "./period";
import type { SimRow } from "./validation";

/** Width of the map bucket in minutes (the old 'Map by time of day' slider step). */
export const JT_BUCKET_MIN = 15;
export const JT_BUCKET_S = JT_BUCKET_MIN * 60;

/** Cursor (seconds since midnight, may exceed 86400) -> bucket start in minutes of the day: floor(cursor_s / 60 / 15) * 15. */
export function cursorToBucketMin(cursor_s: number, bucketMin = JT_BUCKET_MIN): number {
  if (!Number.isFinite(cursor_s) || cursor_s < 0) return 0;
  const m = Math.floor(cursor_s / 60 / bucketMin) * bucketMin;
  return ((m % 1440) + 1440) % 1440;
}

/** Host window (seconds) -> minute-of-day window used by the validation pairing; null when it collapses. */
export function windowToMinutes(win: Pick<HostTimeWindow, "from_s" | "to_s">): { from: number; to: number } | null {
  if (!Number.isFinite(win.from_s) || !Number.isFinite(win.to_s)) return null;
  const from = Math.max(0, Math.min(1439, Math.floor(win.from_s / 60)));
  const to = Math.max(0, Math.min(1440, Math.ceil(win.to_s / 60)));
  return to > from ? { from, to } : null;
}

/** Period the plugin can show: the manifest run_period, else the simulated span, else null (typical-day observed only). */
export function journeyPeriod(info: PeriodInfo, run: string | null, sim: readonly SimRow[]): HostAnalysisPeriod | null {
  const stated = (run !== null ? info.runPeriods[run] : undefined) ?? info.defaultPeriod;
  const p = stated ?? derivePeriod(sim);
  if (!p || !(p.end_s > p.start_s)) return null;
  const interval = p.interval_s && p.interval_s > 0 ? p.interval_s : (derivePeriod(sim)?.interval_s ?? JT_BUCKET_S);
  return { start_s: p.start_s, end_s: p.end_s, interval_s: interval };
}

export function journeyHostInfo(a: { plugin: string; run: string | null; generation: number; period: HostAnalysisPeriod | null; mode: string | null; busy: boolean }): HostAnalysisInfo {
  return { plugin: a.plugin, run: a.run, generation: a.generation, period: a.period, bucket_s: JT_BUCKET_S, mode: a.mode, cursorMode: "cursor", busy: a.busy };
}
