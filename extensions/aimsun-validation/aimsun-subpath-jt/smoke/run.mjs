// node smoke/run.mjs   (needs `node build.mjs` first; Chrome installed)
import { fileURLToPath } from "node:url";
import { runCases } from "./run-cases.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
if (!process.env.AIMSUN_DATA_DIR) {
  console.error("Set AIMSUN_DATA_DIR to the data root (<root>/AMPK_3/subpath_obs_jt.parquet).");
  process.exit(2);
}
const REAL = process.env.AIMSUN_DATA_DIR;
const obs = `${REAL}/AMPK_3/subpath_obs_jt.parquet`;
const geo = here("../tests/fixtures/subpaths.synthetic.geojson");

await runCases({
  casesFile: "cases-jt.js",
  names: ["real-degraded", "real-with-geometry", "no-map-renderer", "bad-url", "files-mode"],
  config: {
    packages: {
      // Real AMPK_3 observed journey times: no geometry exists yet (workstream A3) -> chart-only mode.
      AMPK_3: { files: [{ table: "subpath_obs_jt", file: obs }], run: "AMPK_3" },
      // Real observed data + SYNTHETIC-geometry subpath fixture carrying the 119 real subpath names.
      AMPK_3_GEO: { files: [{ table: "subpath_obs_jt", file: obs }, { table: "subpaths", file: geo, as: "subpaths.geojson" }], run: "AMPK_3+synthetic-geometry" },
    },
  },
});
