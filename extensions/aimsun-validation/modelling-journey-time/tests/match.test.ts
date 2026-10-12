import test from "node:test";
import assert from "node:assert/strict";
import { buildMatching, matchKey, normDirection, normText, pairKey, parseObsRoute, parseSubpathName, type SubpathRef } from "../src/match.ts";

test("normText: NFKC, whitespace, case", () => {
  assert.equal(normText("  Al   Ain\tRoad "), "al ain road");
  assert.equal(normText("ＡＢ"), "ab"); // full-width -> ascii via NFKC
});

test("normDirection: In->IB, Out->OB, others kept, junk null", () => {
  assert.equal(normDirection("In"), "IB");
  assert.equal(normDirection(" out "), "OB");
  assert.equal(normDirection("IB"), "IB");
  assert.equal(normDirection("ob"), "OB");
  assert.equal(normDirection("EW"), "EW");
  assert.equal(normDirection("we"), "WE");
  assert.equal(normDirection("North"), null);
  assert.equal(normDirection(null), null);
});

test("parseSubpathName: only a _<dir> suffix counts", () => {
  assert.deepEqual(parseSubpathName("Sheikh Rashid Bin Saeed Street_OB"), { base: "Sheikh Rashid Bin Saeed Street", direction: "OB", suffix: "OB" });
  assert.deepEqual(parseSubpathName("Al Ain Road_In"), { base: "Al Ain Road", direction: "IB", suffix: "In" });
  assert.deepEqual(parseSubpathName("Corniche Street_Out"), { base: "Corniche Street", direction: "OB", suffix: "Out" });
  assert.deepEqual(parseSubpathName(" Sheikh Zayed Bin Sultan Street_In"), { base: "Sheikh Zayed Bin Sultan Street", direction: "IB", suffix: "In" });
  assert.deepEqual(parseSubpathName("AD01_b"), { base: "AD01_b", direction: null, suffix: null });
  assert.deepEqual(parseSubpathName("Road IB"), { base: "Road IB", direction: null, suffix: null }); // space form is NOT a subpath convention
  assert.equal(parseSubpathName("_In").direction, null); // empty base is not a route
});

test("parseObsRoute: given direction wins and route stays verbatim; missing direction splits ' IB' / '_Out'", () => {
  assert.deepEqual(parseObsRoute("Al Khaleej Al Arabi Street_Al Ain", "IB"), { base: "Al Khaleej Al Arabi Street_Al Ain", direction: "IB", suffix: null });
  assert.deepEqual(parseObsRoute("Al Ain Road IB", null), { base: "Al Ain Road", direction: "IB", suffix: "IB" });
  assert.deepEqual(parseObsRoute("Al Ain Road_Out", ""), { base: "Al Ain Road", direction: "OB", suffix: "Out" });
  assert.deepEqual(parseObsRoute("Al Ain Road", null), { base: "Al Ain Road", direction: null, suffix: null });
});

test("keys: case/whitespace-insensitive, In/IB equivalent", () => {
  assert.equal(pairKey("Al Ain Road", "In"), pairKey("  al  ain road", "IB"));
  assert.equal(matchKey("X", null), null);
  assert.equal(pairKey("Al Ain Road", "Out"), "al ain road|OB");
});

const sp = (id: number, name: string, group: string | null, exists: boolean | null = null): SubpathRef => ({ id, name, group, exists });

test("buildMatching: hand-checked table, counts, reasons, multi-match, scenario flag", () => {
  const obs = [
    { route: "Al Ain Road", direction: "In" }, // matches 2 subpaths (two groups)
    { route: "Al Ain Road", direction: "Out" }, // matches 1
    { route: "Hazza Bin Zayed The First Street", direction: "IB" }, // only a subpath flagged absent from the scenario -> unmatched obs
    { route: "Shakhbout Bin Sultan Street", direction: "IB" }, // no model counterpart
    { route: "Al Ain Road", direction: "In" }, // duplicate pair is ignored
  ];
  const subs = [
    sp(1, "Al Ain Road_In", "Journey Time routes - HSMe"),
    sp(2, "Al Ain Road_IB", "subnetwork"),
    sp(3, "Al Ain Road_Out", "Journey Time routes - HSMe"),
    sp(4, "Hazza Bin Zayed The First Street_IB", "subnetwork", false),
    sp(5, "AD01_b", "JT_Route"),
    sp(6, "AD Mainland - Sheikh Zayed Bin Sultan Street_In", "Journey Time subroutes - HSMe"),
  ];
  const m = buildMatching(obs, subs);
  assert.deepEqual(m.counts, { obsTotal: 4, obsMatched: 2, obsUnmatched: 2, subpathsTotal: 6, subpathsMatched: 2, subpathsUnmatched: 3, subpathsNotInScenario: 1, subpathsDroppedDuplicate: 1 });
  const ain = m.matchedObs.find((r) => r.direction === "In")!;
  assert.deepEqual(ain.matches.map((x) => x.subpath.id), [1]); // preferred group only
  assert.deepEqual(ain.dropped.map((x) => x.subpath.id), [2]);
  assert.match(ain.dropped[0].via, /Journey Time routes - HSMe/);
  assert.equal(ain.key, "al ain road|IB");
  assert.match(ain.matches[0].via, /suffix "In" -> IB/);
  assert.deepEqual(m.unmatchedObs.map((r) => r.route).sort(), ["Hazza Bin Zayed The First Street", "Shakhbout Bin Sultan Street"]);
  const reasons = Object.fromEntries(m.unmatchedSubpaths.map((u) => [u.subpath.id, u.reason]));
  assert.deepEqual(reasons, { 4: "not-in-scenario", 5: "no-direction-suffix", 6: "no-observed-route" });
});

test("buildMatching: several groups without the preferred one keep all; single-group keys are untouched", () => {
  const m = buildMatching(
    [{ route: "X", direction: "IB" }, { route: "Y", direction: "IB" }],
    [sp(1, "X_IB", "subnetwork"), sp(2, "X_In", "JT_Route"), sp(3, "Y_In", "Journey Time routes - HSMe"), sp(4, "Y_IB", "Journey Time routes - HSMe")],
  );
  assert.deepEqual(m.matchedObs[0].matches.map((x) => x.subpath.id), [1, 2]);
  assert.deepEqual(m.matchedObs[0].dropped, []);
  assert.deepEqual(m.matchedObs[1].matches.map((x) => x.subpath.id), [3, 4]); // same preferred group twice: nothing to drop
  assert.equal(m.counts.subpathsDroppedDuplicate, 0);
});

test("buildMatching: same route in two sources stays two observed rows; empty inputs are safe", () => {
  const m = buildMatching(
    [
      { route: "Al Ain Road", direction: "IB", source: "monthly_15min" },
      { route: "Al Ain Road", direction: "IB", source: "subnetwork_may2025" },
    ],
    [sp(1, "Al Ain Road_In", null)],
  );
  assert.equal(m.counts.obsTotal, 2);
  assert.equal(m.counts.subpathsMatched, 1);
  assert.deepEqual(buildMatching([], []).counts.obsTotal, 0);
});
