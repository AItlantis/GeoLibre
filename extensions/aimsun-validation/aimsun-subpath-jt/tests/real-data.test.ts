// Real AMPK_3 observed journey times (subpath_obs_jt.parquet) through the shared SQL, then name matching against the
// 119 real subpath names (geometry in the fixture is synthetic: names/ids/groups come from the catalogue probe).
// Skipped when the data is absent. Set $AIMSUN_DATA_DIR to the data root (no default).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql.ts";
import { buildMatching } from "../src/common/match.ts";
import { parseSubpathGeoJson, subpathRefs } from "../src/common/pkg.ts";
import { profileOf, toObsRows, type ObsRow } from "../src/common/profile.ts";
import { memConn, rows, runScript, type DuckDBConnection } from "./helpers.ts";

const dir = process.env.AIMSUN_DATA_DIR;
const file = dir ? `${dir}/AMPK_3/subpath_obs_jt.parquet` : "";
const skip = dir && existsSync(file) ? false : "AIMSUN_DATA_DIR unset or real data not found";
let conn: DuckDBConnection;
let obs: ObsRow[];

before(async () => {
  if (skip) return;
  conn = await memConn();
  await conn.run(`CREATE TABLE subpath_obs_jt AS SELECT * FROM read_parquet('${file}')`);
  await runScript(conn, buildSubpathSql({ bucketMinutes: 15 }));
  obs = toObsRows(await rows(conn, "SELECT * FROM v_sp_obs"));
});

const refs = () => subpathRefs(parseSubpathGeoJson(JSON.parse(readFileSync(new URL("./fixtures/subpaths.synthetic.geojson", import.meta.url), "utf8"))).fc);
const pairsOf = (source: string) => {
  const seen = new Set<string>();
  return obs.filter((r) => r.source === source && !seen.has(`${r.route}|${r.direction_norm}`) && seen.add(`${r.route}|${r.direction_norm}`)).map((r) => ({ route: r.route, direction: r.direction_norm, source }));
};

test("real: 15-min profile covers the day for 30 monthly and 25 subnetwork route/direction pairs", { skip }, () => {
  assert.equal(pairsOf("monthly_15min").length, 30);
  assert.equal(pairsOf("subnetwork_may2025").length, 25);
  const p = profileOf(obs, "Al Ain Road", "IB", "monthly_15min");
  assert.equal(p.mean.length, 96);
  // 2976 rows per route = 31 days x 96 quarter-hours: the file spans 3 Feb - 30 Apr but holds only 31 days.
  assert.equal(p.nDaysMax, 31);
  assert.ok(p.mean.every((x) => x.y !== null && x.y > 0));
});

test("real: name matching against the 119 real subpath names (monthly source)", { skip }, () => {
  const m = buildMatching(pairsOf("monthly_15min"), refs());
  assert.deepEqual(m.counts, { obsTotal: 30, obsMatched: 24, obsUnmatched: 6, subpathsTotal: 119, subpathsMatched: 24, subpathsUnmatched: 87, subpathsNotInScenario: 0, subpathsDroppedDuplicate: 8 });
  assert.deepEqual(
    m.unmatchedObs.map((r) => `${r.route}|${r.direction}`).sort(),
    [
      "Al Khaleej Al Arabi Street_Al Ain|IB",
      "Al Khaleej Al Arabi Street_Al Ain|OB",
      "Shakhbout Bin Sultan Street|IB",
      "Shakhbout Bin Sultan Street|OB",
      "Sheikh Khalifa Bin Zayed Al Nahyan Street|IB",
      "Sheikh Khalifa Bin Zayed Al Nahyan Street|OB",
    ],
  );
  const ain = m.matchedObs.find((r) => r.route === "Al Ain Road" && r.direction === "IB")!;
  // 8 observed keys exist in both the 'Journey Time routes - HSMe' and 'subnetwork' groups: only HSMe is kept.
  assert.equal(m.matchedObs.filter((r) => r.dropped.length).length, 8);
  assert.deepEqual(ain.matches.map((x) => [x.subpath.name, x.subpath.group]), [["Al Ain Road_In", "Journey Time routes - HSMe"]]);
  assert.deepEqual(ain.dropped.map((x) => [x.subpath.name, x.subpath.group]), [["Al Ain Road_IB", "subnetwork"]]);
  assert.ok(m.matchedObs.every((r) => r.matches.length === 1));
  // The 74 route-code subpaths (JT_Route AD01_b ...) have no direction suffix: reported, never forced.
  assert.equal(m.unmatchedSubpaths.filter((u) => u.reason === "no-direction-suffix").length, 74);
});

test("real: name matching (subnetwork source)", { skip }, () => {
  const m = buildMatching(pairsOf("subnetwork_may2025"), refs());
  assert.deepEqual(m.counts, { obsTotal: 25, obsMatched: 23, obsUnmatched: 2, subpathsTotal: 119, subpathsMatched: 23, subpathsUnmatched: 88, subpathsNotInScenario: 0, subpathsDroppedDuplicate: 8 });
  assert.deepEqual(m.unmatchedObs.map((r) => r.route), ["Sheikh Khalifa Bin Zayed Al Nahyan Street", "Sheikh Khalifa Bin Zayed Al Nahyan Street"]);
  // EW/WE are kept as-is: 'Corniche Street' WE/EW match the _WE/_EW subpaths only.
  const we = m.matchedObs.find((r) => r.route === "Corniche Street" && r.direction === "WE")!;
  assert.deepEqual(we.matches.map((x) => x.subpath.name), ["Corniche Street_WE"]);
});
