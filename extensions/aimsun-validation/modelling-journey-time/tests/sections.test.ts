// C12: per-section delay: values at a time bucket, ramp, worst sections, features, map overlay lifecycle, package registration.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "../../_shared/node_modules/@duckdb/node-api/lib/index.js";
import type { DuckDbHandle } from "../../_shared/src/duckdb.ts";
import type { HostApp, HostMapLike } from "../src/host.ts";
import { canonicalTable, loadFromManifestUrl, manifestCapabilityReason, planFiles } from "../src/pkg.ts";
import { SectionOverlay, SECTIONS_CASING, SECTIONS_LINE, SECTIONS_SRC } from "../src/sectionOverlay.ts";
import { parseSectionGeoJson, SECTION_LINE_WIDTH, sectionFeatures, sectionGeometry, sectionOids, sectionValuesAt, slowestSections, speedGradient, speedScale, SPEED_STOPS, toSecRows } from "../src/sections.ts";
import { openSession } from "../src/session.ts";
import { H, JUMEIRA, SRC, SYNTH, sectionGeo, sectionTt } from "./fixtures/c11c12.ts";

const near = (a: number | null, b: number, eps = 1e-9): void => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} != ${b}`);
const OID = JUMEIRA[0].oid;

test("sectionValuesAt: mean over the buckets overlapping the slider bucket; run filter; seq/id preserved", () => {
  const rows = [...sectionTt(OID, 4, 7 * H, 10 * H, "AM"), ...sectionTt(OID, 4, 7 * H, 10 * H, "PM").map((r) => ({ ...r, dtime_s: 999 }))];
  // slider bucket 09:00-09:15 overlaps the 5-min buckets starting 32400, 32700, 33000 (k = 24, 25, 26)
  const v = sectionValuesAt(rows, String(OID), "AM", 9 * H, 9 * H + 900);
  assert.equal(v.size, 4);
  near(v.get(2)!.dtime_s, 20 + 25); // section 2: 2*10 + mean(24,25,26)
  near(v.get(2)!.ttime_s, 60 + 20 + 25);
  near(v.get(2)!.delay_ratio, 45 / 105);
  near(v.get(3)!.speed_kmh, 35);
  assert.equal(v.get(2)!.section_id, "1001");
  assert.equal(v.get(2)!.n, 3);
  // other subpath / outside the period
  assert.equal(sectionValuesAt(rows, "nope", "AM", 9 * H, 9 * H + 900).size, 0);
  assert.equal(sectionValuesAt(rows, String(OID), "AM", 18 * H, 18 * H + 900).size, 0);
  // run filter: PM rows (delay 999) are not mixed in
  assert.ok([...v.values()].every((x) => (x.dtime_s as number) < 100));
  // a row without a run belongs to every run
  assert.equal(sectionValuesAt(rows.map((r) => ({ ...r, run: null })), String(OID), "AM", 9 * H, 9 * H + 900).get(1)!.n, 6);
});

test("speed scale: fixed breakpoints at 0/25/50/75/100 % of the route max, red (slow) to green (fast), nulls grey", () => {
  const v = sectionValuesAt(sectionTt(OID, 3, 9 * H, 9 * H + 300, "AM"), String(OID), null, 9 * H, 9 * H + 900);
  assert.deepEqual([1, 2, 3].map((i) => v.get(i)!.speed_kmh), [45, 40, 35]);
  const sc = speedScale([45, 40, 35, null]);
  assert.deepEqual([sc.min, sc.max], [35, 45]);
  assert.deepEqual(sc.breaks, [0, 11.25, 22.5, 33.75, 45]);
  assert.equal(sc.colour(0), SPEED_STOPS[0]);
  assert.equal(sc.colour(45), SPEED_STOPS[4]);
  assert.equal(sc.colour(22.5), SPEED_STOPS[2]);
  assert.equal(sc.colour(11.25), SPEED_STOPS[1]);
  assert.equal(sc.colour(33.75), SPEED_STOPS[3]);
  assert.equal(sc.colour(null), "#9ca3af");
  // red -> yellow -> green: the red channel falls, the green channel of the slow end is lower than the fast end
  const rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  assert.ok(rgb(sc.colour(0))[0] > 200 && rgb(sc.colour(0))[1] < 90, "slow is red");
  assert.ok(rgb(sc.colour(22.5))[0] > 200 && rgb(sc.colour(22.5))[1] > 200, "middle is yellow");
  assert.ok(rgb(sc.colour(45))[1] > rgb(sc.colour(45))[0], "fast is green");
  // the scale is anchored at 0, not at the route minimum: a uniformly slow route is not painted green
  assert.equal(speedScale([10, 10]).colour(10), SPEED_STOPS[4]);
  assert.notEqual(speedScale([10, 40]).colour(10), speedScale([10, 10]).colour(10));
  assert.match(speedGradient(), /^linear-gradient\(90deg, #d73027 0%.*#1a9850 100%\)$/);
  // no data at all
  assert.equal(speedScale([null]).max, 0);
});

test("slowest sections: 3 lowest speeds with seq, section id, speed and length; features carry speed value, colour and tooltip", () => {
  const rows = sectionTt(OID, 5, 9 * H, 9 * H + 300, "AM");
  const v = sectionValuesAt(rows, String(OID), "AM", 9 * H, 9 * H + 900);
  const geo = sectionGeo(OID, 5);
  const geometry = sectionGeometry(geo, String(OID));
  const slow = slowestSections(v, geometry, 3);
  assert.deepEqual(slow.map((x) => [x.seq, x.section_id, x.speed_kmh]), [[5, "1004", 25], [4, "1003", 30], [3, "1002", 35]]);
  assert.ok(slow.every((x) => x.length_m === null || Number.isFinite(x.length_m)));
  assert.equal(slowestSections(v, geometry, 1).length, 1);
  const scale = speedScale([...v.values()].map((x) => x.speed_kmh));
  const fc = sectionFeatures({ geometry, values: v, scale, bucketLabel: "09:00", routeName: "Route 01" });
  assert.equal(fc.features.length, 5);
  assert.deepEqual(fc.features.map((f) => f.properties!.seq), [1, 2, 3, 4, 5]);
  const f5 = fc.features[4].properties!;
  assert.equal(f5.value, 25);
  assert.equal(f5.section_id, "1004");
  assert.match(String(f5.tooltip), /Section 1004 \(#5\).*travel time 110\.0 s.*delay 50\.0 s.*speed 25\.0 km\/h/);
  assert.notEqual(fc.features[0].properties!.stroke, f5.stroke);
  assert.equal(f5.stroke, scale.colour(25));
  // constant line width on every section (length is visible on the map)
  assert.ok(fc.features.every((f) => f.properties!["stroke-width"] === SECTION_LINE_WIDTH));
  // a section without simulated values is drawn grey
  const partial = sectionFeatures({ geometry, values: new Map([...v].filter(([k]) => k !== 3)), scale, bucketLabel: "09:00", routeName: "R" });
  assert.equal(partial.features[2].properties!.stroke, "#9ca3af");
  // lengths come from the geometry properties
  const withLen = geometry.map((g) => ({ ...g, properties: { ...g.properties, length_m: 120 + Number(g.properties!.seq) } }));
  assert.equal(slowestSections(v, withLen, 1)[0].length_m, 125);
});

test("geometry helpers: geometry per subpath ordered by seq; parse skips features without line geometry / oid / seq", () => {
  const two = { type: "FeatureCollection" as const, features: [...sectionGeo(1, 2).features, ...sectionGeo(2, 3, 56).features.reverse()] };
  assert.deepEqual(sectionOids(two), new Set(["1", "2"]));
  assert.deepEqual(sectionGeometry(two, "2").map((f) => f.properties!.seq), [1, 2, 3]);
  assert.deepEqual(sectionGeometry(null, "2"), []);
  const { fc, skipped } = parseSectionGeoJson({
    type: "FeatureCollection",
    features: [...sectionGeo(1, 1).features, { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { subpath_oid: 1, seq: 9 } }, { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { seq: 2 } }],
  });
  assert.equal(fc.features.length, 1);
  assert.equal(skipped, 2);
  assert.throws(() => parseSectionGeoJson({ type: "Feature" }), /FeatureCollection/);
  // DuckDB rows: BigInt-ish / strings coerce, rows without a bucket span are dropped
  const r = toSecRows([{ subpath_oid: 5n as unknown as number, seq: 1, section_id: 7, run: null, interval_start_s: "300", duration_s: 300, ttime_s: "12", dtime_s: null, speed_kmh: 30, flow: undefined }, { subpath_oid: 5, seq: 2, interval_start_s: null, duration_s: 300 }]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].subpath_oid, r[0].interval_start_s, r[0].ttime_s, r[0].dtime_s], ["5", 300, 12, null]);
});

// ---- overlay lifecycle with a fake MapLibre map --------------------------------------------------------------------------
function fakeMap() {
  const sources = new Map<string, { data: unknown; setData(d: unknown): void }>();
  const layers: string[] = [];
  const handlers = new Map<string, Array<(e?: unknown) => void>>();
  const canvas = { style: { cursor: "" } } as unknown as HTMLCanvasElement;
  const map = {
    addSource: (id: string, s: { data: unknown }) => sources.set(id, { data: s.data, setData(d: unknown) { this.data = d; } }),
    addLayer: (l: { id: string }) => layers.push(l.id),
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    removeLayer: (id: string) => layers.splice(layers.indexOf(id), 1),
    removeSource: (id: string) => sources.delete(id),
    on: (ev: string, a: unknown, b?: unknown) => { const k = typeof a === "string" ? `${ev}:${a}` : ev; const fn = (typeof a === "string" ? b : a) as (e?: unknown) => void; handlers.set(k, [...(handlers.get(k) ?? []), fn]); },
    off: (ev: string, a: unknown, b?: unknown) => { const k = typeof a === "string" ? `${ev}:${a}` : ev; const fn = (typeof a === "string" ? b : a) as (e?: unknown) => void; handlers.set(k, (handlers.get(k) ?? []).filter((h) => h !== fn)); },
    getCanvas: () => canvas,
  } as unknown as HostMapLike;
  return { map, sources, layers, handlers, canvas };
}

test("SectionOverlay: own source + casing/line layers, redrawn in place, re-added on style reload, fully removed on dispose", () => {
  const fm = fakeMap();
  const app = { addGeoJsonLayer: () => "x", getMap: () => fm.map } as unknown as HostApp;
  const ov = new SectionOverlay(() => app);
  const fc = sectionFeatures({ geometry: sectionGeometry(sectionGeo(OID, 2), String(OID)), values: new Map(), scale: speedScale([]), bucketLabel: "09:00", routeName: "R" });
  assert.equal(ov.set(fc), true);
  assert.deepEqual(fm.layers, [SECTIONS_CASING, SECTIONS_LINE]);
  assert.ok(fm.sources.has(SECTIONS_SRC));
  assert.notEqual(SECTIONS_SRC, "aimsun-jt-overlay");
  assert.equal(fm.handlers.get(`mousemove:${SECTIONS_LINE}`)?.length, 1);
  // a second set updates the source data instead of re-adding layers
  const fc2 = { ...fc, features: fc.features.slice(0, 1) };
  ov.set(fc2);
  assert.deepEqual(fm.layers, [SECTIONS_CASING, SECTIONS_LINE]);
  assert.equal((fm.sources.get(SECTIONS_SRC)!.data as typeof fc).features.length, 1);
  assert.equal(fm.handlers.get(`mousemove:${SECTIONS_LINE}`)?.length, 1, "no duplicate listeners");
  // style reload drops source and layers: styledata handler re-adds them
  fm.sources.clear();
  fm.layers.length = 0;
  for (const h of fm.handlers.get("styledata") ?? []) h();
  assert.deepEqual(fm.layers, [SECTIONS_CASING, SECTIONS_LINE]);
  assert.ok(fm.sources.has(SECTIONS_SRC));
  ov.remove();
  assert.deepEqual(fm.layers, []);
  assert.equal(fm.sources.size, 0);
  assert.equal(fm.handlers.get("styledata")?.length, 0);
  assert.equal(fm.handlers.get(`mousemove:${SECTIONS_LINE}`)?.length, 0);
  // no 2D map -> false, no throw
  assert.equal(new SectionOverlay(() => ({ addGeoJsonLayer: () => "x" }) as unknown as HostApp).set(fc), false);
});

// ---- package registration -----------------------------------------------------------------------------------------------------
test("pkg: section tables are registered (aliases), multi-run section_sim_tt keeps one file per run, absent -> old behaviour", () => {
  assert.equal(canonicalTable("subpath_sections"), "subpath_sections");
  assert.equal(canonicalTable("Section_Sim_TT"), "section_sim_tt");
  const manifest = { schema_version: 1 as const, files: [
    { table: "subpath_sections", path: "subpath_sections.geojson" },
    { table: "section_sim_tt", path: "data/AM/section_sim_tt.parquet" },
    { table: "section_sim_tt", path: "data/PM/section_sim_tt.parquet" },
  ] };
  const plan = planFiles(["p/subpath_sections.geojson", "p/data/AM/section_sim_tt.parquet", "p/data/PM/section_sim_tt.parquet"], manifest);
  assert.deepEqual(plan.map((p) => [p.table, p.run]), [["subpath_sections", undefined], ["section_sim_tt", "AM"], ["section_sim_tt", "PM"]]);
  // old package: only the three legacy tables, no run/section entries
  assert.deepEqual(planFiles(["pkg/subpath_obs_jt.parquet", "pkg/subpaths.geojson"]).map((p) => p.table), ["subpath_obs_jt", "subpaths"]);
  assert.equal(manifestCapabilityReason({ schema_version: 1, files: [], capabilities: { "analysis-journey-section-delay": { available: false, reason: "no simulated section table for static runs" } } }, "analysis-journey-section-delay"), "no simulated section table for static runs");
  assert.equal(manifestCapabilityReason({ schema_version: 1, files: [] }, "analysis-journey-section-delay"), null);
});

const dir = mkdtempSync(join(tmpdir(), "aimsun-c12-"));
process.chdir(dir);
const splitStmts = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
function fakeConn(nc: Awaited<ReturnType<DuckDBInstance["connect"]>>) {
  return {
    async query(sql: string) {
      let last: Array<Record<string, unknown>> = [];
      for (const s of splitStmts(sql)) last = (await nc.runAndReadAll(s)).getRowObjectsJson() as Array<Record<string, unknown>>;
      return { toArray: () => last.map((r) => ({ ...r, toJSON: () => r })) };
    },
    async close() { nc.closeSync(); },
  };
}

test("package load: obs + sim + sections + section_sim_tt + manifest run_period/observed_sources/capability reach the summary; rows feed matchPeriod and the section values", async () => {
  const inst = await DuckDBInstance.create(":memory:");
  const main = await inst.connect();
  const live = new Set<string>();
  const h = {
    db: { connect: async () => fakeConn(await inst.connect()) },
    conn: fakeConn(main),
    query: async (sql: string) => (await fakeConn(main).query(sql)).toArray(),
    exec: async (sql: string) => void (await fakeConn(main).query(sql)),
    registerBuffer: async (name: string, bytes: Uint8Array) => { live.add(name); writeFileSync(join(dir, name), bytes); },
    registerUrl: async () => {},
    dropFile: async (name: string) => { live.delete(name); if (existsSync(join(dir, name))) unlinkSync(join(dir, name)); },
    terminate: async () => {},
  } as unknown as DuckDbHandle;
  const admin = await inst.connect();
  const parquet = async (name: string, select: string): Promise<Uint8Array> => {
    const f = join(dir, name).replace(/\\/g, "/");
    await admin.run(`COPY (${select}) TO '${f}' (FORMAT parquet)`);
    const b = new Uint8Array(readFileSync(join(dir, name)));
    unlinkSync(join(dir, name));
    return b;
  };
  const r = SYNTH[0];
  const obsB = await parquet("o.parquet", `SELECT '${r.route}' AS route, '${r.dir}' AS direction_norm, TIMESTAMP '2000-01-01 09:00:00' AS ts, 130.0 AS seconds, '${SRC}' AS source, '11' AS subpath_oid, 'exact-name' AS match_method, 120.0 AS seconds_min, 140.0 AS seconds_max, NULL::DOUBLE AS window_start_s, NULL::DOUBLE AS window_end_s, 'typical' AS dateKind, 'jt1' AS source_id`);
  const simB = await parquet("s.parquet", `SELECT '${r.route}' AS route, '${r.dir}' AS direction_norm, TIMESTAMP '2000-01-01 08:00:00' + to_seconds(300 * (i + 1)) AS ts_bucket, ${r.base}.0 + i AS seconds, 28800.0 + 300 * i AS interval_start_s, 300.0 AS duration_s FROM range(0, 12) t(i)`);
  const tt = sectionTt(11, 3, 8 * H, 9 * H, "AM");
  const secB = await parquet("t.parquet", `SELECT * FROM (VALUES ${tt.map((x) => `(${x.subpath_oid}::BIGINT, ${x.seq}, '${x.section_id}', ${x.interval_start_s}.0, ${x.duration_s}.0, ${x.ttime_s}.0, ${x.dtime_s}.0, ${x.speed_kmh}.0, ${x.flow}.0, ${x.seq === 2 && x.interval_start_s === 28800 ? "false" : "true"})`).join(",")}) v(subpath_oid, seq, section_id, interval_start_s, duration_s, ttime_s, dtime_s, speed_kmh, flow, valid)`);
  const files: Record<string, Uint8Array | string> = {
    "http://t/P/manifest.json": JSON.stringify({
      schema_version: 1, run: "AM",
      run_period: { start_s: 28800, end_s: 32400, interval_s: 300, day: null, source: "sim_info" },
      observed_sources: [{ source_id: "jt1", file: SRC, role: "journey_time", matchMode: "point", convention: "interval-end", tolerance_s: 0, declared: true }],
      capabilities: { "analysis-journey-section-delay": { available: true, reason: null } },
      files: [
        { table: "subpath_obs_jt", path: "subpath_obs_jt.parquet" }, { table: "subpath_sim_jt", path: "subpath_sim_jt.parquet" },
        { table: "subpath_sections", path: "subpath_sections.geojson" }, { table: "section_sim_tt", path: "section_sim_tt.parquet" },
      ],
    }),
    "http://t/P/subpath_obs_jt.parquet": obsB, "http://t/P/subpath_sim_jt.parquet": simB, "http://t/P/section_sim_tt.parquet": secB,
    "http://t/P/subpath_sections.geojson": JSON.stringify(sectionGeo(11, 3)),
  };
  const f = (async (u: string) => (files[String(u)] === undefined ? new Response("nope", { status: 404 }) : new Response(files[String(u)] as BodyInit))) as unknown as typeof fetch;
  const s = await openSession(h, "aimsun_subpath_jt");
  const pkg = await loadFromManifestUrl(s, "http://t/P/manifest.json", { fetchImpl: f });
  assert.equal(pkg.hasSim, true);
  assert.equal(pkg.hasSectionTt, true);
  assert.equal(pkg.sections!.features.length, 3);
  assert.equal(pkg.periodInfo.defaultPeriod!.start_s, 28800);
  assert.equal(pkg.periodInfo.sources[0].declared, true);
  assert.equal(pkg.sectionReason, null);
  assert.equal(live.size, 0);
  // valid=false rows are not used
  const secRows = toSecRows(await s.query("SELECT subpath_oid, seq, section_id, ttime_s, dtime_s, speed_kmh, flow, interval_start_s, duration_s, NULL AS run FROM section_sim_tt WHERE valid IS NOT FALSE"));
  assert.equal(secRows.length, tt.length - 1);
  const v = sectionValuesAt(secRows, "11", null, 8 * H, 8 * H + 900);
  assert.equal(v.get(2)!.n, 2); // bucket 0 of section 2 was invalid
  // the observed table keeps the identity columns the period engine needs
  const cols = (await s.query<{ column_name: string }>("DESCRIBE subpath_obs_jt")).map((c) => String(c.column_name));
  assert.ok(cols.includes("source_id"));
  await s.dispose();
});

test.after(() => {
  process.chdir(tmpdir());
  rmSync(dir, { recursive: true, force: true });
});
