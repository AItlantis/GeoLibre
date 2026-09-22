import assert from "node:assert/strict";
import test from "node:test";
import { loadEmissionsH3Geometry } from "./emissions-h3-geometry";
import type { NetworkKpiPackageSource } from "./network-kpi-data";

test("Emissions H3 loads section geometry without touching unrelated network layers", async () => {
  const requested: string[] = [];
  const source: NetworkKpiPackageSource = {
    baseUrl: null,
    read: async (path) => {
      requested.push(path);
      return new TextEncoder().encode(JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { section_id: 7 }, geometry: null }],
      })).buffer;
    },
  };

  const geometry = await loadEmissionsH3Geometry(source, "geometry/sections.geojson");

  assert.deepEqual(requested, ["geometry/sections.geojson"]);
  assert.equal(geometry.sections.features.length, 1);
});
