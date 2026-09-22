import type { TestudoDatasetProvider } from "../plugins/testudo-dataset-provider";

export interface SimulationTimeline {
  initialTimeSeconds: number | null;
  durationSeconds: number | null;
  intervalDurationSeconds: number | null;
  intervalCount: number | null;
  finalTimeSeconds: number | null;
  source: "SIM_INFO" | "manifest" | "derived";
}

const timelineCache = new WeakMap<object, Map<string, SimulationTimeline | null>>();

const finite = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
};

function value(row: Record<string, unknown>, names: string[]): number | null {
  const entries = Object.entries(row);
  for (const name of names) {
    const hit = entries.find(([key]) => key.replaceAll("_", "").toLowerCase() === name.replaceAll("_", "").toLowerCase());
    const parsed = hit ? finite(hit[1]) : null;
    if (parsed !== null) return parsed;
  }
  return null;
}

export function deriveSimulationTimeline(args: {
  initialTimeSeconds?: number | null;
  durationSeconds?: number | null;
  intervalDurationSeconds?: number | null;
  intervalCount?: number | null;
  source?: SimulationTimeline["source"];
}): SimulationTimeline | null {
  const initial = args.initialTimeSeconds ?? null;
  const duration = args.durationSeconds;
  const step = args.intervalDurationSeconds;
  const count = args.intervalCount && args.intervalCount > 0 ? Math.trunc(args.intervalCount) : null;
  if (initial !== null && !Number.isFinite(initial)) return null;
  if (duration !== null && duration !== undefined && (!Number.isFinite(duration) || duration < 0)) return null;
  if (step !== null && step !== undefined && (!Number.isFinite(step) || step <= 0)) return null;
  if (initial === null && duration == null && step == null && count == null) return null;
  const interval = step != null && Number.isFinite(step) && step > 0
    ? step
    : count && duration != null ? duration / count : null;
  return {
    initialTimeSeconds: initial,
    durationSeconds: duration ?? null,
    intervalDurationSeconds: interval,
    intervalCount: count,
    finalTimeSeconds: initial !== null && duration != null ? initial + duration : null,
    source: args.source ?? "derived",
  };
}

/** Query the optional SIM_INFO table without assuming a vendor-specific schema. */
export async function readSimulationTimeline(
  provider: TestudoDatasetProvider,
  selection: { scenarioId?: string | number; did?: number } = {},
): Promise<SimulationTimeline | null> {
  const key = `${String(selection.scenarioId ?? "")}:${String(selection.did ?? "")}`;
  let cache = timelineCache.get(provider);
  if (!cache) { cache = new Map(); timelineCache.set(provider, cache); }
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const result = await provider.readSimulationInfo(selection);
    const row = result.rows[0];
    if (!row) { cache.set(key, null); return null; }
    const initial = value(row, ["initial_time", "from_time", "start_time", "begin_time", "t0", "sim_start"]);
    const duration = value(row, ["duration", "simulation_duration", "period", "sim_duration"]);
    const step = value(row, ["interval", "interval_duration", "time_step", "dt", "step"]);
    const count = value(row, ["intervals", "interval_count", "n_intervals", "simstatintervals", "totalstatintervals", "n_ent"]);
    const timeline = deriveSimulationTimeline({ initialTimeSeconds: initial, durationSeconds: duration, intervalDurationSeconds: step, intervalCount: count, source: "SIM_INFO" });
    cache.set(key, timeline);
    return timeline;
  } catch {
    cache.set(key, null);
    return null;
  }
}

/** Resolve a zero-based slice position; callers must map sparse `ent` IDs first. */
export function timelineTimeAtSliceIndex(timeline: SimulationTimeline | null, sliceIndex: number, intervalCount?: number | null): number | null {
  if (!timeline) return null;
  if (timeline.initialTimeSeconds == null || timeline.intervalDurationSeconds == null) return null;
  const count = intervalCount ?? timeline.intervalCount;
  const index = Math.max(0, Math.trunc(sliceIndex));
  if (count && index >= count) return timeline.finalTimeSeconds;
  const result = timeline.initialTimeSeconds + index * timeline.intervalDurationSeconds;
  return timeline.finalTimeSeconds == null ? result : Math.min(timeline.finalTimeSeconds, result);
}

export function formatSimulationTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const whole = Math.max(0, Math.round(Math.abs(seconds)));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
