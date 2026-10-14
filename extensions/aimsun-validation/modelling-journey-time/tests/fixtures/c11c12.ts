// Fixtures for C11 (period matching) and C12 (per-section delay). Built from the contract shapes (contracts_v6):
//  - typical-day observed rows (time-only, supplied min/mean/max), 5-minute simulated buckets with ts = interval END,
//  - a Jumeira-like micro run, a second synthetic model with unrelated names, a static run (no simulated rows),
//  - window-declared observations, per-section geometry + per-section simulated values.
import type { GeoJSONFC } from "../../src/host.ts";
import type { ObsRow } from "../../src/profile.ts";
import type { SimRow } from "../../src/validation.ts";
import type { SecRow } from "../../src/sections.ts";

export const SRC = "journeytime.csv";
export const H = 3600;

export interface RouteSpec {
  route: string;
  dir: string;
  oid: number;
  /** simulated value of bucket index k (0 = first bucket of the run) is base + k. */
  base: number;
}

/** Jumeira-like: exact names, NB/SB directions (never equated with IB/OB). */
export const JUMEIRA: RouteSpec[] = [
  { route: "Route 01 - Jumeirah St NB", dir: "NB", oid: 294383, base: 700 },
  { route: "Route 02 - Jumeirah St SB", dir: "SB", oid: 294384, base: 600 },
  { route: "Route 03 - Al Wasl Rd NB", dir: "NB", oid: 294382, base: 500 },
  { route: "Route 04 - Al Wasl Rd SB", dir: "SB", oid: 294380, base: 400 },
  { route: "Route 05 - Umm Suqeim St NB", dir: "NB", oid: 294385, base: 300 },
  { route: "Route 06 - Umm Suqeim St SB", dir: "SB", oid: 294386, base: 200 },
];

/** A different model: nothing in common with Jumeira (names, directions, oids, times). */
export const SYNTH: RouteSpec[] = [
  { route: "Corridor Alpha", dir: "IB", oid: 11, base: 120 },
  { route: "Ring Road", dir: "OB", oid: 12, base: 340 },
];

export const sim = (spec: RouteSpec, startS: number, endS: number, run: string, dur = 300): SimRow[] => {
  const out: SimRow[] = [];
  for (let s = startS, k = 0; s < endS; s += dur, k++) {
    out.push({ route: spec.route, direction_norm: spec.dir, bucket_start_min: Math.floor(s / 60), sim_s: spec.base + k, n: 1, interval_start_s: s, duration_s: dur, run });
  }
  return out;
};

export interface ObsSpec {
  spec: RouteSpec;
  tS: number;
  mean: number;
  min?: number | null;
  max?: number | null;
  win?: [number, number];
}

export const obs = (o: ObsSpec, source = SRC): ObsRow => ({
  route: o.spec.route, direction_norm: o.spec.dir, source, bucket_start_min: Math.floor(o.tS / 900) * 15, n_days: 1,
  mean_s: o.mean, median_s: o.mean, min_s: o.mean, max_s: o.mean, subpath_oid: String(o.spec.oid), match_method: "exact-name", source_id: source, date_kind: "typical",
  sup_min_s: o.min ?? null, sup_max_s: o.max ?? null, window_start_s: o.win?.[0] ?? null, window_end_s: o.win?.[1] ?? null, t_s: o.tS,
});

/** 6 Jumeira routes, observed at 09:00 and 18:00 (Route 04 only at 18:00), against an AM run 07:00-10:00. */
export function jumeiraAm(): { obs: ObsRow[]; sim: SimRow[] } {
  const [r1, r2, r3, r4, r5, r6] = JUMEIRA;
  // AM run 07:00-10:00, 5-min buckets, ts = interval end. Obs at 09:00 -> bucket (08:55, 09:00] = index 23 -> base + 23.
  const k = 23;
  const rows: ObsRow[] = [
    obs({ spec: r1, tS: 9 * H, mean: r1.base + k, min: r1.base + k - 20, max: r1.base + k + 20 }), // sim == obs: pass
    obs({ spec: r1, tS: 18 * H, mean: 900, min: 850, max: 950 }),
    obs({ spec: r2, tS: 9 * H, mean: (r2.base + k) / 1.2, min: (r2.base + k) / 1.2 - 5, max: (r2.base + k) / 1.2 + 5 }), // sim = +20 %: warn
    obs({ spec: r3, tS: 9 * H, mean: (r3.base + k) / 1.5, min: 100, max: 120 }), // sim = +50 %: fail
    obs({ spec: r3, tS: 18 * H, mean: 540, min: 500, max: 600 }),
    obs({ spec: r4, tS: 18 * H, mean: 610, min: 580, max: 650 }), // only outside the period
    obs({ spec: r5, tS: 9 * H, mean: 400, min: 380, max: 430 }), // no simulated series
    obs({ spec: r6, tS: 9 * H, mean: r6.base + k + 10, min: null, max: null }), // no supplied band, |err| < 15 %
  ];
  const simRows = [r1, r2, r3, r4, r6].flatMap((r) => sim(r, 7 * H, 10 * H, "AM"));
  return { obs: rows, sim: simRows };
}

// ---- C12 section fixtures ------------------------------------------------------------------------------------------
export function sectionGeo(oid: number, n: number, x0 = 55.2): GeoJSONFC {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: n }, (_, i) => ({
      type: "Feature" as const,
      geometry: { type: "LineString", coordinates: [[x0 + i * 0.001, 25.2], [x0 + (i + 1) * 0.001, 25.2]] },
      properties: { subpath_oid: oid, seq: i + 1, section_id: 1000 + i, length_m: 100 + i, name: `S${i + 1}`, geometry_method: "section-geometry" },
    })),
  };
}

/** section_sim_tt rows: sections 1..n of one subpath over 5-minute buckets; delay of section s in bucket k = s * 10 + k. */
export function sectionTt(oid: number, n: number, startS: number, endS: number, run: string): SecRow[] {
  const out: SecRow[] = [];
  for (let s = startS, k = 0; s < endS; s += 300, k++) {
    for (let i = 1; i <= n; i++) {
      out.push({ subpath_oid: String(oid), seq: i, section_id: String(1000 + i - 1), run, interval_start_s: s, duration_s: 300, ttime_s: 60 + i * 10 + k, dtime_s: i * 10 + k, speed_kmh: 50 - i * 5, flow: 100 });
    }
  }
  return out;
}
