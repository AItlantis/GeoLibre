// Regenerates tests/fixtures/subpaths.synthetic.geojson from the subpath catalogue probe
// (119 subpaths: id, ext = group label, name, sections). Names/ids/groups are REAL; the geometry is
// SYNTHETIC (short straight lines on a grid near Abu Dhabi) because workstream A3 geometry does not
// exist yet. Each feature carries synthetic_geometry: true. Property names follow
// aconsole/build_package.py (id, name, group_label, section_count, exists_in_run_scenario).
//   node tests/fixtures/make-subpaths-fixture.mjs <path to probe/subpaths.json>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const src = process.argv[2];
if (!src) throw new Error("usage: node make-subpaths-fixture.mjs <subpaths.json>");
const sp = JSON.parse(readFileSync(src, "utf8"));
const features = sp.map((s, i) => {
  const lon = 54.3 + (i % 12) * 0.012;
  const lat = 24.4 + Math.floor(i / 12) * 0.012;
  return {
    type: "Feature",
    id: s.id,
    geometry: { type: "LineString", coordinates: [[lon, lat], [lon + 0.008, lat + 0.003]] },
    properties: { id: s.id, name: s.name, group_label: s.ext, section_count: s.sections.length, exists_in_run_scenario: true, synthetic_geometry: true },
  };
});
const out = join(dirname(fileURLToPath(import.meta.url)), "subpaths.synthetic.geojson");
writeFileSync(out, JSON.stringify({ type: "FeatureCollection", name: "subpaths", features }) + "\n");
console.log(`${features.length} features -> ${out}`);
