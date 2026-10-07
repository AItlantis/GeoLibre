import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGeolibrePackage } from "../packages/plugins/src/plugins/geolibre-package-loader";

test("package metadata preserves declared results view modes, alternatives, comparison pairs and time axis", () => {
  const pkg = parseGeolibrePackage({ results: {
    viewModes: {
      results: { table: "MISECT", column: "flow", unit: "veh/h", style: { type: "ramp", id: "flow" }, domains: { sid: { min: 0, max: 4 }, intervalSeconds: 600 }, alternates: [{ table: "MISECT", column: "speed", unit: "km/h", style: { type: "extrusion", max: 90 } }] },
      comparison: { table: "MISECT", column: "flow_delta", unit: "veh/h", style: { type: "ramp" }, domains: { ent: { min: 0, max: 1 } }, scenarioDidPair: [{ scid: 10, did: 100 }, { scid: 20, did: 200 }] },
    },
    timeAxis: { fromTime: 28800, intervalMs: 600000, intervals: 1 },
  } });
  assert.equal(pkg.viewModes.results?.alternates?.[0].style.type, "extrusion");
  assert.deepEqual(pkg.viewModes.comparison?.scenarioDidPair, [{ scid: 10, did: 100 }, { scid: 20, did: 200 }]);
  assert.deepEqual(pkg.timeAxis, { fromTime: 28800, intervalMs: 600000, intervals: 1 });
});

test("package metadata drops malformed view modes and invalid time axes", () => {
  const pkg = parseGeolibrePackage({ results: { viewModes: { results: { table: "MISECT", column: "flow", unit: "veh/h", style: { type: "other" } } }, timeAxis: { fromTime: "later", intervalMs: 0, intervals: -1 } } });
  assert.deepEqual(pkg.viewModes, {});
  assert.equal(pkg.timeAxis, null);
});
