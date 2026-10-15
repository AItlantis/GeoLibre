// node smoke/run.mjs (needs `node build.mjs` first; Chrome installed)
import { fileURLToPath } from "node:url";
import { runCases } from "./run-cases.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
if (!process.env.AIMSUN_DATA_DIR) {
  console.error("Set AIMSUN_DATA_DIR to the data root (<root>/AMPK_3/subpath_obs_jt.parquet).");
  process.exit(2);
}
const real = process.env.AIMSUN_DATA_DIR;
const obs = `${real}/AMPK_3/subpath_obs_jt.parquet`;

await runCases({
  casesFile: "cases-all.js",
  names: ["real-degraded", "real-with-geometry", "no-map-renderer", "bad-url", "files-mode", "real-only", "fixture-modes", "malformed-sim"],
  config: {
    roots: [here("../tests/fixtures")],
    packages: {
      AMPK_3: { files: [{ table: "subpath_obs_jt", file: obs }], run: "AMPK_3" },
      AMPK_3_GEO: { files: [{ table: "subpath_obs_jt", file: obs }, { table: "subpaths", file: here("../tests/fixtures/subpaths.synthetic.geojson"), as: "subpaths.geojson" }], run: "AMPK_3" },
      FIXTURE: { dir: here("../tests/fixtures/pkg") },
      BADSIM: { dir: here("../tests/fixtures/pkg_badsim") },
    },
  },
});
