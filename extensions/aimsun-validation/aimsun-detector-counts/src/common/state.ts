/** Panel state + reducer shared by both detector plugins (pure, unit-tested). */
import type { SortDir, SortKey } from "./aggregate.ts";
import type { ObsSource } from "./sql.ts";

export type Phase = "empty" | "loading" | "ready" | "error";

export interface PanelState {
  phase: Phase;
  error: string | null;
  sourceLabel: string | null;
  runs: string[];
  run: string | null;
  obsSource: ObsSource;
  /** Time window [fromMin, toMin) in minutes since midnight of the reference day. */
  fromMin: number;
  toMin: number;
  bucket: number;
  bucketOptions: number[];
  selectedId: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  topN: number;
  /** True while a run is being (re)queried. */
  busy: boolean;
}

export const initialState = (): PanelState => ({
  phase: "empty",
  error: null,
  sourceLabel: null,
  runs: [],
  run: null,
  obsSource: "both",
  fromMin: 0,
  toMin: 1440,
  bucket: 60,
  bucketOptions: [60],
  selectedId: null,
  sortKey: "geh",
  sortDir: "desc",
  topN: 20,
  busy: false,
});

export type Action =
  | { type: "package-loading" }
  | { type: "package-loaded"; label: string; runs: string[]; run: string }
  | { type: "run-selected"; run: string }
  | { type: "probe-ready"; fromMin: number; toMin: number; bucket: number; bucketOptions: number[] }
  | { type: "set-obs-source"; value: ObsSource }
  | { type: "set-window"; fromMin: number; toMin: number }
  | { type: "set-bucket"; bucket: number }
  | { type: "select-detector"; id: string | null }
  | { type: "sort"; key: SortKey }
  | { type: "set-top-n"; n: number }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** from in [0, 1439], to in [from + 1, 1440]; non-finite input keeps the previous bound. */
export function normalizeWindow(fromMin: number, toMin: number, prev: [number, number] = [0, 1440]): [number, number] {
  const f = clamp(Math.round(Number.isFinite(fromMin) ? fromMin : prev[0]), 0, 1439);
  const t = clamp(Math.round(Number.isFinite(toMin) ? toMin : prev[1]), f + 1, 1440);
  return [f, t];
}

export function reduce(s: PanelState, a: Action): PanelState {
  switch (a.type) {
    case "package-loading":
      return { ...s, phase: "loading", error: null, busy: true };
    case "package-loaded":
      return { ...s, phase: "loading", error: null, sourceLabel: a.label, runs: a.runs, run: a.run, selectedId: null };
    case "run-selected":
      // a new run resets what depends on its data
      return { ...s, run: a.run, selectedId: null, phase: "loading", error: null, busy: true };
    case "probe-ready": {
      const [f, t] = normalizeWindow(a.fromMin, a.toMin);
      return { ...s, fromMin: f, toMin: t, bucket: a.bucket, bucketOptions: a.bucketOptions, phase: "ready", busy: false };
    }
    case "set-obs-source":
      return { ...s, obsSource: a.value, selectedId: null, busy: true };
    case "set-window": {
      const [f, t] = normalizeWindow(a.fromMin, a.toMin, [s.fromMin, s.toMin]);
      return { ...s, fromMin: f, toMin: t, busy: true };
    }
    case "set-bucket":
      return s.bucketOptions.includes(a.bucket) ? { ...s, bucket: a.bucket, busy: true } : s;
    case "select-detector":
      return { ...s, selectedId: a.id };
    case "sort":
      return s.sortKey === a.key
        ? { ...s, sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { ...s, sortKey: a.key, sortDir: a.key === "id" ? "asc" : "desc" };
    case "set-top-n":
      return { ...s, topN: clamp(Math.round(a.n) || s.topN, 1, 500) };
    case "busy":
      return { ...s, busy: a.busy };
    case "error":
      return { ...s, phase: "error", error: a.message, busy: false };
  }
}

export function minToLabel(min: number): string {
  const m = clamp(Math.round(min), 0, 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Every 15 minutes, 00:00 .. 24:00. */
export const TIME_STEPS: number[] = Array.from({ length: 97 }, (_, i) => i * 15);
