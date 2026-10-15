/** Host-managed time window (contract C15): seconds -> controller window + auto bucket. Pure, unit-tested. */
import { autoBucketSeconds, type HostTimeWindow } from "../../../_shared/src/host-time.ts";
import { WHOLE_PERIOD } from "./sql.ts";

export interface HostPeriodS {
  start_s: number;
  end_s: number;
  interval_s: number;
}

export interface HostWindowPlan {
  fromMin: number;
  toMin: number;
  /** Controller bucket value (minutes, or WHOLE_PERIOD). */
  bucket: number;
  /** Effective bucket length reported to the host. */
  bucket_s: number;
}

/**
 * Snap the host window onto the data interval grid (from down, to up, at least one interval), keep it inside the
 * period, and pick the auto bucket among the controller's options (largest option <= the auto size, else the smallest).
 */
export function planHostWindow(win: HostTimeWindow, period: HostPeriodS, bucketOptions: readonly number[]): HostWindowPlan {
  const iv = period.interval_s > 0 ? period.interval_s : 3600;
  const lo = period.start_s;
  const hi = Math.max(period.end_s, lo + iv);
  let from = lo + Math.floor((Math.max(win.from_s, lo) - lo) / iv + 1e-9) * iv;
  let to = lo + Math.ceil((Math.min(win.to_s, hi) - lo) / iv - 1e-9) * iv;
  if (to <= from) to = from + iv;
  if (to > hi) { to = hi; from = Math.max(lo, to - iv); }
  const fromMin = Math.min(1439, Math.max(0, Math.round(from / 60)));
  const toMin = Math.min(1440, Math.max(fromMin + 1, Math.round(to / 60)));
  const wantS = autoBucketSeconds(from, to, iv);
  const numeric = bucketOptions.filter((b) => b !== WHOLE_PERIOD && b > 0).sort((a, b) => a - b);
  let bucket: number;
  if (to - from <= iv || wantS >= to - from) bucket = bucketOptions.includes(WHOLE_PERIOD) ? WHOLE_PERIOD : (numeric[0] ?? WHOLE_PERIOD);
  else bucket = [...numeric].reverse().find((b) => b * 60 <= wantS) ?? numeric[0] ?? WHOLE_PERIOD;
  const bucket_s = bucket === WHOLE_PERIOD ? (toMin - fromMin) * 60 : bucket * 60;
  return { fromMin, toMin, bucket, bucket_s };
}
