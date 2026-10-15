// Observation contract v2 (C7) and detector identity (C8) in the Counts plugin:
// observed_sources parsing, source selection by source_id, bucket options of the selected source,
// profile-only sources, units normalisation, legacy packages unchanged, shared-eid pooling.
// Jumeira-like fixture: micro 5-min simulation, pattern_rds_4.csv (15-min, comparable) and
// traffic_survey_rds.csv (sparse points, window unknown: profile-only).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DetController } from "../src/common/controller.ts";
import { parseObservedSources, parseReports, itemsFromManifest, buildIndex } from "../src/common/package-source.ts";
import { WHOLE_PERIOD, defaultSourceChoice, resolveSources, selectedSources, sourceChoices, sourcesHomogeneous, type ObservedSource } from "../src/common/sql.ts";
import { openNodeDb } from "./node-db.ts";

const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const enc = (o: unknown): ArrayBuffer => ab(new TextEncoder().encode(JSON.stringify(o)));
type Db = Awaited<ReturnType<typeof openNodeDb>>["db"];

const PATTERN = { source_id: "pattern4", file: "pattern_rds_4.csv", adapter: "rds-idcolumn-time-flow", role: "counts", referenceDay: "2020-01-01", dateKind: "typical", gridSeconds: 900, durationSeconds: 900, timestampConvention: "interval-end", units: "veh/h", unitConfidence: "declared", eligibility: "comparable", rows: 8, detectors: 2 };
const SURVEY = { source_id: "survey", file: "traffic_survey_rds.csv", adapter: "rds-idcolumn-time-flow", role: "counts", referenceDay: "2020-01-01", dateKind: "typical", gridSeconds: null, durationSeconds: null, timestampConvention: "unknown", units: "unknown", unitConfidence: "unknown", eligibility: "profile-only", rows: 4, detectors: 2 };
const JT = { source_id: "jt", file: "journeytime.csv", role: "journey_time", eligibility: "profile-only" };
const REPORTS = [{ name: "observed_report.json", path: "observed_report.json", format: "json", sha256: "a".repeat(64), bytes: 1234 }, { name: "rds_inventory.json", path: "rds_inventory.json", format: "json", sha256: "b".repeat(64), bytes: 99 }];
const OBSERVED_C3 = { referenceDay: "2020-01-01", gridSeconds: 900, units: "veh/h", timestampConvention: "interval-end", source: "pattern_rds_4.csv" };

/**
 * Simulation (micro, 5 min, 07:00-08:00): E1 600, E2 1200, J383_A = three oids (149 / 136 / 130) sharing one eid.
 * Observed (extended columns): pattern4 on E1 (540 each quarter) and E2; survey points; optional extras.
 */
async function fixture(db: Db, extraObsSql = ""): Promise<{ sim: Uint8Array; obs: Uint8Array }> {
  await db.exec(`
CREATE TABLE s_sim AS
SELECT 294179 AS did, 'MICRO' AS run, oid, eid, ent, 0 AS sid, 25200 + (ent - 1) * 300 AS interval_start_s, 300 AS duration_s, flow, flow * 300 / 3600.0 AS volume
FROM (VALUES (1, 'E1', 600.0), (2, 'E2', 1200.0), (10, 'J383_A', 149.0), (11, 'J383_A', 136.0), (12, 'J383_A', 130.0)) d(oid, eid, flow), range(1, 13) t(ent);
CREATE TABLE s_obs(detector_id VARCHAR, ts TIMESTAMP, flow DOUBLE, source_file VARCHAR, duration_s INTEGER, source_id VARCHAR, units VARCHAR,
  unit_confidence VARCHAR, flow_min DOUBLE, flow_max DOUBLE, oid BIGINT, eligibility VARCHAR);
INSERT INTO s_obs
SELECT d, TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), CASE WHEN d = 'E1' THEN 540.0 WHEN i = 1 THEN 600.0 ELSE 1200.0 END,
       'pattern_rds_4.csv', 900, 'pattern4', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable'
FROM (VALUES ('E1'), ('E2'), ('J383_A')) x(d), range(0, 4) t(i);
UPDATE s_obs SET flow = 140.0 WHERE detector_id = 'J383_A';
INSERT INTO s_obs VALUES ('E1', TIMESTAMP '2020-01-01 07:00:00', 300.0, 'traffic_survey_rds.csv', NULL, 'survey', 'unknown', 'unknown', NULL, NULL, NULL, 'profile-only'),
  ('E2', TIMESTAMP '2020-01-01 07:30:00', 700.0, 'traffic_survey_rds.csv', NULL, 'survey', 'unknown', 'unknown', NULL, NULL, NULL, 'profile-only');
${extraObsSql}
COPY s_sim TO 'ssim.parquet' (FORMAT parquet);
COPY s_obs TO 'sobs.parquet' (FORMAT parquet);
`);
  return { sim: new Uint8Array(readFileSync("ssim.parquet")), obs: new Uint8Array(readFileSync("sobs.parquet")) };
}

const files = (sim: Uint8Array, obs: Uint8Array, meta?: unknown) => [
  { path: "data/MICRO/detectors_sim.parquet", arrayBuffer: async () => ab(sim) },
  { path: "data/MICRO/detectors_obs.parquet", arrayBuffer: async () => ab(obs) },
  ...(meta === undefined ? [] : [{ path: "data/MICRO/analysis_manifest.json", arrayBuffer: async () => enc(meta) }]),
];

const settle = async (c: DetController): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((c.state.phase === "ready" && !c.state.busy) || c.state.phase === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("controller did not settle");
};

const src = (o: Record<string, unknown>): ObservedSource => parseObservedSources([{ ...PATTERN, ...o }])![0];

test("parseObservedSources: full entry, degraded fields, strict structure", () => {
  const [p, s] = parseObservedSources([PATTERN, SURVEY])!;
  assert.deepEqual([p.sourceId, p.file, p.role, p.durationSeconds, p.units, p.unitConfidence, p.eligibility, p.dateKind, p.rows], ["pattern4", "pattern_rds_4.csv", "counts", 900, "veh/h", "declared", "comparable", "typical", 8]);
  assert.deepEqual([s.durationSeconds, s.units, s.unitConfidence, s.timestampConvention, s.eligibility], [null, "unknown", "unknown", "unknown", "profile-only"]);
  // missing optional fields never turn into a comparable assumption
  const [m] = parseObservedSources([{ source_id: "m" }])!;
  assert.deepEqual([m.units, m.unitConfidence, m.durationSeconds, m.gridSeconds, m.eligibility, m.timestampConvention, m.role], ["unknown", "unknown", null, null, null, "unknown", "counts"]);
  assert.equal(parseObservedSources(undefined), undefined);
  assert.throws(() => parseObservedSources({}), /array/);
  assert.throws(() => parseObservedSources([{}]), /source_id/);
  assert.throws(() => parseObservedSources([PATTERN, PATTERN]), /duplicated/);
  assert.throws(() => parseObservedSources([{ ...PATTERN, referenceDay: "01/01/2020" }]), /referenceDay/);
  assert.deepEqual(parseReports(REPORTS)?.map((r) => [r.name, r.bytes]), [["observed_report.json", 1234], ["rds_inventory.json", 99]]);
  assert.throws(() => parseReports([{ path: "x" }]), /name and path/);
});

test("manifest.json: observed_sources and reports at top level and per run; reports are never tables", () => {
  const m = { schema_version: 1, observed_sources: [PATTERN], reports: REPORTS, runs: [{ run: "MICRO", observed_sources: [PATTERN, SURVEY], reports: [REPORTS[0]] }], files: [{ path: "MICRO/detectors_sim.parquet" }, { path: "observed_report.json" }] };
  const { items, observed } = itemsFromManifest("https://h/p/manifest.json", m, async () => new Uint8Array());
  assert.equal(items.find((i) => i.path === "observed_report.json") !== undefined, true);
  const idx = buildIndex("p", items, new Set(), observed);
  assert.equal(idx.runs.length, 1, "a report is not a detector table and starts no run");
  assert.equal(idx.runs[0].observedSources?.length, 2, "per-run list wins over the top-level one");
  assert.equal(idx.runs[0].reports?.length, 1);
  assert.throws(() => itemsFromManifest("https://h/p/manifest.json", { schema_version: 1, observed_sources: "x" }, async () => new Uint8Array()), /observed_sources/);
});

test("resolveSources: eligibility = declared AND known interval AND known units; journey_time ignored", () => {
  const list = resolveSources(parseObservedSources([PATTERN, SURVEY, JT, { ...PATTERN, source_id: "u", units: "veh", unitConfidence: "unknown" }, { ...PATTERN, source_id: "nodur", durationSeconds: null, gridSeconds: null }, { ...PATTERN, source_id: "odd", durationSeconds: 90, gridSeconds: 90 }, { ...PATTERN, source_id: "inf", units: "veh", unitConfidence: "inferred" }])!);
  assert.deepEqual(list.map((s) => [s.sourceId, s.effective]), [["pattern4", "comparable"], ["survey", "profile-only"], ["u", "profile-only"], ["nodur", "profile-only"], ["odd", "profile-only"], ["inf", "comparable"]]);
  assert.match(list[2].reason ?? "", /neither declared nor inferred/);
  assert.match(list[3].reason ?? "", /interval length is unknown/);
  assert.match(list[4].reason ?? "", /whole number of minutes/);
  assert.equal(list[0].durationMin, 15);
  assert.equal(list[0].tsLabel, "end");
  assert.equal(list[1].tsLabel, "end", "an unknown timestamp convention reads as interval-end (documented default)");
});

test("reference day rules: own day, else the run's observed.referenceDay, else typical = time of day only, else the legacy 2025-01-01", () => {
  const r = (o: Record<string, unknown>, obs?: { referenceDay: string }) => resolveSources([src({ referenceDay: null, ...o })], obs)[0].refDay;
  assert.equal(resolveSources([src({})])[0].refDay, "2020-01-01");
  assert.equal(r({ dateKind: "actual" }, { referenceDay: "2021-05-05" }), "2021-05-05");
  assert.equal(r({ dateKind: "typical" }), null);
  assert.equal(r({ dateKind: "actual" }), "2025-01-01");
});

test("choices: 'both' only for >= 2 homogeneous comparable sources; profile-only listed but never comparable", () => {
  const one = resolveSources([src({}), src({ source_id: "survey", eligibility: "profile-only", durationSeconds: null, gridSeconds: null, units: "unknown" })]);
  assert.deepEqual(sourceChoices(one).map((c) => c.value), ["pattern4", "survey"]);
  assert.equal(defaultSourceChoice(one), "pattern4");
  const two = resolveSources([src({ source_id: "a" }), src({ source_id: "b" })]);
  assert.equal(sourcesHomogeneous(two), true);
  assert.deepEqual(sourceChoices(two).map((c) => c.value), ["both", "a", "b"]);
  assert.equal(defaultSourceChoice(two), "both");
  assert.deepEqual(selectedSources(two, "both").map((s) => s.sourceId), ["a", "b"]);
  const mixed = resolveSources([src({ source_id: "a" }), src({ source_id: "h", gridSeconds: 3600, durationSeconds: 3600 })]);
  assert.deepEqual(sourceChoices(mixed).map((c) => c.value), ["a", "h"], "15-min and hourly sources are not homogeneous: no 'both'");
  assert.deepEqual(selectedSources(mixed, "both"), [], "a stale 'both' selects nothing");
  const onlyProfile = resolveSources([src({ source_id: "s", eligibility: "profile-only" })]);
  assert.equal(defaultSourceChoice(onlyProfile), "s");
});

test("Jumeira-like controller: pattern comparable (15/30/60/whole), survey profile-only (day profile only, validation disabled with the reason)", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await fixture(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed: OBSERVED_C3, observed_sources: [PATTERN, SURVEY], reports: REPORTS }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.sources?.length, 2);
    assert.deepEqual(c.reports.map((r) => r.name), ["observed_report.json", "rds_inventory.json"]);
    assert.deepEqual(c.obsSourceChoices()?.map((x) => x.value), ["pattern4", "survey"]);
    assert.equal(c.state.obsSource, "pattern4");
    assert.equal(c.hasObs, true);
    assert.equal(c.validationReason, null);
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    assert.equal(c.state.bucket, 60);
    // pattern: hourly sim = mean of 12 five-minute rates; obs = mean of the 4 quarter-hours; the survey points are NOT compared
    const h = Object.fromEntries(c.rows.map((r) => [r.detector_id, [r.sim_flow_h, r.obs_flow_h]]));
    assert.deepEqual(h.E1, [600, 540]);
    assert.deepEqual(h.E2, [1200, 1050]);
    assert.equal(c.rows.length, 3); // E1, E2, J383_A
    assert.equal(c.dayProfiles.mean.observed.length, 4, "the pattern profile follows the source grid");
    // select the sparse survey
    c.setObsSource("survey");
    await settle(c);
    assert.equal(c.hasObs, false, "validation / comparison disabled");
    assert.equal(c.hasObsData, true, "the observed table still feeds the day profile");
    assert.match(c.validationReason ?? "", /survey: declared profile-only/);
    assert.deepEqual(c.state.bucketOptions, [5, 10, 15, 20, 30, 60, WHOLE_PERIOD], "no observed interval to respect: the simulated grid decides");
    assert.equal(c.rows.length, 0, "no row of a profile-only source is ever validated");
    assert.deepEqual(c.aggs.map((a) => a.id), ["E1", "E2", "J383_A"], "simulation-only table");
    assert.ok(c.aggs.every((a) => a.obs === 0 && a.status === "pass"));
    const prof = c.dayProfiles.sum.observed.map((p) => [p.minute, p.value]).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(prof, [[420, 300], [450, 700]], "the survey points (units as given) are available in the day profile");
    assert.equal(c.counts.nObs, 0);
    // back to the pattern: buckets restored
    c.setObsSource("pattern4");
    await settle(c);
    assert.equal(c.hasObs, true);
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    assert.equal(c.rows.length, 3);
    c.setObsSource("nonexistent");
    assert.equal(c.state.obsSource, "pattern4", "an unknown source id is ignored");
    await c.dispose();
  } finally {
    close();
  }
});

test("no observed_sources (legacy package, even with the new parquet columns): C3 behaviour, source_file selection", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await fixture(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed: OBSERVED_C3 }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.sources, null);
    assert.equal(c.obsSourceChoices(), null);
    assert.equal(c.state.obsSource, "both");
    assert.deepEqual(c.state.bucketOptions, [15, 30, 60, WHOLE_PERIOD]);
    // legacy: source_file 'pattern_rds_4.csv' / 'traffic_survey_rds.csv' rows are all read on the C3 grid (15 min, 2020-01-01)
    c.setObsSource("validation");
    await settle(c);
    assert.equal(c.state.obsSource, "validation");
    assert.equal(c.rows.length, 0, "legacy selection is by source_file validation|calibration only");
    c.setObsSource("pattern4");
    assert.equal(c.state.obsSource, "validation", "a v2 source id is not a legacy source");
    await c.dispose();
  } finally {
    close();
  }
});

test("units normalisation: 'veh' with declared/inferred units is converted with the interval; unknown units -> profile only", async () => {
  const { db, close } = await openNodeDb();
  try {
    // counts of 100 veh per 15 minutes on E1 (= 400 veh/h) in source 'cnt'; the same with unknown confidence in 'cntu'
    const extra = `INSERT INTO s_obs SELECT 'E1', TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), 100.0, 'counts.csv', 900, 'cnt', 'veh', 'declared', NULL, NULL, NULL, 'comparable' FROM range(0, 4) t(i);
      INSERT INTO s_obs SELECT 'E1', TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), 100.0, 'countsu.csv', 900, 'cntu', 'veh', 'unknown', NULL, NULL, NULL, 'comparable' FROM range(0, 4) t(i);`;
    const { sim, obs } = await fixture(db, extra);
    const base = { ...PATTERN, referenceDay: "2020-01-01" };
    const cnt = { ...base, source_id: "cnt", file: "counts.csv", units: "veh", unitConfidence: "declared" };
    const cntu = { ...base, source_id: "cntu", file: "countsu.csv", units: "veh", unitConfidence: "unknown" };
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed_sources: [PATTERN, cnt, cntu] }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual(c.obsSourceChoices()?.map((x) => x.value), ["pattern4", "cnt", "cntu"], "mixed units/confidence: not homogeneous, no 'both'");
    c.setObsSource("cnt");
    await settle(c);
    const e1 = c.rows.find((r) => r.detector_id === "E1")!;
    assert.deepEqual([e1.sim_flow_h, e1.obs_flow_h], [600, 400], "100 veh / 15 min = 400 veh/h");
    assert.equal(c.rows.length, 1, "only E1 has the counts source");
    c.setObsSource("cntu");
    await settle(c);
    assert.equal(c.hasObs, false);
    assert.match(c.validationReason ?? "", /neither declared nor inferred/);
    assert.equal(c.rows.length, 0);
    await c.dispose();
  } finally {
    close();
  }
});

test("homogeneous sources: 'both' pools them without double counting; per-source selection changes the data", async () => {
  const { db, close } = await openNodeDb();
  try {
    // a second 15-minute source 'cal' that repeats E1's stamps with another value: the first source wins on overlap, cal adds E3
    const extra = `INSERT INTO s_obs SELECT 'E1', TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)), 1.0, 'cal.csv', 900, 'cal', 'veh/h', 'declared', NULL, NULL, NULL, 'comparable' FROM range(0, 4) t(i);`;
    const { sim, obs } = await fixture(db, extra);
    const cal = { ...PATTERN, source_id: "cal", file: "cal.csv" };
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed_sources: [PATTERN, cal, SURVEY] }), "data");
    await settle(c);
    assert.deepEqual(c.obsSourceChoices()?.map((x) => x.value), ["both", "pattern4", "cal", "survey"]);
    assert.equal(c.state.obsSource, "both");
    const e1 = c.rows.find((r) => r.detector_id === "E1")!;
    assert.deepEqual([e1.sim_flow_h, e1.obs_flow_h], [600, 540], "pattern4 preferred; cal's overlapping stamps are not added");
    c.setObsSource("cal");
    await settle(c);
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].obs_flow_h, 1);
    await c.dispose();
  } finally {
    close();
  }
});

test("unknown interval and unknown units declared by a source with no eligibility: profile-only by the consumer's own rules", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await fixture(db);
    const noDur = { ...PATTERN, durationSeconds: null, gridSeconds: null, eligibility: undefined };
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed_sources: [noDur, SURVEY] }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.state.obsSource, "pattern4", "no comparable source: the first source is selected");
    assert.equal(c.hasObs, false);
    assert.match(c.validationReason ?? "", /interval length is unknown/);
    assert.equal(c.rows.length, 0);
    // the profile still shows the rows that carry their own duration_s (15 min), on the pattern's reference day
    assert.equal(c.dayProfiles.mean.observed.length, 4);
    await c.dispose();
  } finally {
    close();
  }
});

test("C8 controller: three oids sharing one eid pool as the mean (138.33 over 60 minutes), counted once; the detector detail says how many share the id", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await fixture(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed_sources: [PATTERN] }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    const j = c.rows.filter((r) => r.detector_id === "J383_A");
    assert.equal(j.length, 1, "one row for the eid, not one per oid");
    assert.ok(Math.abs(j[0].sim_flow_h - (149 + 136 + 130) / 3) < 1e-9);
    assert.equal(String(j[0].oid), "10", "the representative render id is the smallest oid");
    assert.equal(c.aggs.length, 3, "each eid once: E1, E2, J383_A");
    assert.equal(c.sharedOidCount("J383_A"), 3);
    assert.equal(c.sharedOidCount("E1"), 1);
    // simulation-only aggregation (no validation): same pooling
    await c.dispose();
    const c2 = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c2.loadFiles(files(sim, obs, { observed_sources: [SURVEY] }), "data");
    await settle(c2);
    assert.equal(c2.hasObs, false);
    const agg = c2.aggs.find((a) => a.id === "J383_A")!;
    assert.ok(Math.abs(agg.sim - (149 + 136 + 130) / 3) < 1e-9, `sim-only value ${agg.sim}`);
    assert.equal(c2.aggs.length, 3);
    await c2.dispose();
  } finally {
    close();
  }
});

test("C8 controller: two oids with the same eid covering the SAME half hour do not pass a full-hour coverage check", async () => {
  const { db, close } = await openNodeDb();
  try {
    await db.exec(`
CREATE TABLE h_sim AS
SELECT 294179 AS did, 'MICRO' AS run, oid, 'H' AS eid, ent, 0 AS sid, 25200 + (ent - 1) * 300 AS interval_start_s, 300 AS duration_s, 500.0 AS flow, 500.0 * 300 / 3600.0 AS volume
FROM (VALUES (1), (2)) o(oid), range(1, 7) t(ent);
INSERT INTO h_sim SELECT 294179, 'MICRO', 3, 'K', ent, 0, 25200 + (ent - 1) * 300, 300, 500.0, 500.0 * 300 / 3600.0 FROM range(1, 13) t(ent);
CREATE TABLE h_obs AS
SELECT d AS detector_id, TIMESTAMP '2020-01-01 07:00:00' + to_minutes(15 * (i + 1)) AS ts, 500.0 AS flow, 'p.csv' AS source_file, 900 AS duration_s, 'p' AS source_id, 'veh/h' AS units,
       'declared' AS unit_confidence, CAST(NULL AS DOUBLE) AS flow_min, CAST(NULL AS DOUBLE) AS flow_max, CAST(NULL AS BIGINT) AS oid, 'comparable' AS eligibility
FROM (VALUES ('H'), ('K')) x(d), range(0, 4) t(i);
COPY h_sim TO 'hsim.parquet' (FORMAT parquet);
COPY h_obs TO 'hobs.parquet' (FORMAT parquet);`);
    const sim = new Uint8Array(readFileSync("hsim.parquet"));
    const obs = new Uint8Array(readFileSync("hobs.parquet"));
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(files(sim, obs, { observed_sources: [{ ...PATTERN, source_id: "p" }] }), "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual([...new Set(c.rows.map((r) => r.detector_id))], ["K"], "H has 30 minutes of data: 2 oids x 30 min is not 60 min");
    c.setBucket(30);
    await settle(c);
    assert.ok(c.rows.some((r) => r.detector_id === "H" && r.bucket_start_min === 420), "a 30-minute bucket is fully covered, once");
    await c.dispose();
  } finally {
    close();
  }
});
