// node smoke/run.mjs   (needs `node build.mjs` first; Chrome installed)
// Cases: the REAL AMPK_3 package (no simulated JT -> empty state) and the SYNTHETIC fixture package (end to end).
import { fileURLToPath } from "node:url";
import { runCases } from "../../aimsun-subpath-jt/smoke/run-cases.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
if (!process.env.AIMSUN_DATA_DIR) {
  console.error("Set AIMSUN_DATA_DIR to the data root (<root>/AMPK_3/subpath_obs_jt.parquet).");
  process.exit(2);
}
const REAL = process.env.AIMSUN_DATA_DIR;

await runCases({
  casesFile: "cases-validation.js",
  names: ["real-no-sim", "fixture-end-to-end", "files-mode", "bad-sim-columns", "no-pairs"],
  config: {
    roots: [here("."), here("../tests/fixtures")], // cases-validation.js, expected.json
    packages: {
      AMPK_3: { files: [{ table: "subpath_obs_jt", file: `${REAL}/AMPK_3/subpath_obs_jt.parquet` }], run: "AMPK_3" },
      FIXTURE: { dir: here("../tests/fixtures/pkg") },
      BADSIM: { dir: here("../tests/fixtures/pkg_badsim") },
    },
  },
});
