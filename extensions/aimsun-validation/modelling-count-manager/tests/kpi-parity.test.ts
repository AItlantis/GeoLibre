// The KPIs shown by the validation panel are computed in TS (computeKpis over the window rows);
// they must equal the shared SQL view v_det_summary on the real runs, and the worst-N / status
// logic must be consistent with the view's per-row status.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeKpis, worstN } from "../src/common/aggregate.ts";
import { DetController } from "../src/common/controller.ts";
import { divergingColor, sequentialColor, sizeExpression, statusColor } from "../src/common/map-layer.ts";
import { openNodeDb } from "./node-db.ts";

const ROOT = process.env.AIMSUN_DATA_DIR ?? "";

for (const run of ["AMPK_3", "AMPK_3b", "PMPK_3"]) {
  const have = !!ROOT && existsSync(join(ROOT, run, "detectors_sim.parquet"));
  test(`KPIs and statuses match v_det_summary / v_det_validation for ${run}`, { skip: !have && `no data for ${run}` }, async () => {
    const { db, close } = await openNodeDb();
    try {
      const files = ["detectors_sim.parquet", "detectors_obs.parquet"].map((f) => ({
        path: `data/${run}/${f}`,
        arrayBuffer: async () => new Uint8Array(readFileSync(join(ROOT, run, f))).buffer as ArrayBuffer,
      }));
      const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
      await c.loadFiles(files, "data");
      for (let i = 0; i < 400 && !(c.state.phase === "ready" && !c.state.busy); i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(c.state.phase, "ready", c.state.error ?? "");
      if (run === "AMPK_3") assert.equal(c.unmatched.length, 51);
      const k = computeKpis(c.rows);
      const sum = (await db.query<Record<string, unknown>>("SELECT * FROM v_det_summary"))[0];
      assert.equal(k.n, Number(sum.n));
      for (const [js, sql] of [[k.rmse, "rmse"], [k.mae, "mae"], [k.bias, "bias"], [k.r2, "r2"], [k.slope, "slope"], [k.intercept, "intercept"], [k.pctGehLt5, "pct_geh_lt5"]] as const) {
        assert.ok(Math.abs(js! - Number(sum[sql])) < 1e-6 * Math.max(1, Math.abs(js!)), `${run} ${sql}: ${js} vs ${sum[sql]}`);
      }
      assert.equal(k.nPass, Number(sum.n_pass));
      assert.equal(k.nWarn, Number(sum.n_warn));
      assert.equal(k.nFail, Number(sum.n_fail));
      // per-row GEH from the view equals the TS GEH and ranks the same detector first
      const viewWorst = (await db.query<{ detector_id: string }>("SELECT detector_id FROM v_det_validation ORDER BY geh DESC LIMIT 1"))[0];
      assert.equal(worstN(c.aggs, 1)[0].id, viewWorst.detector_id);
      await c.dispose();
    } finally {
      close();
    }
  });
}

test("map style expressions are well-formed MapLibre expressions", () => {
  const status = statusColor() as unknown[];
  assert.equal(status[0], "case");
  assert.ok(JSON.stringify(status).includes("#2e7d32"));
  assert.ok(JSON.stringify(status).includes("#f9a825"));
  assert.ok(JSON.stringify(status).includes("#c62828"));
  const size = sizeExpression("sim", 1600) as unknown[];
  assert.equal(size[0], "interpolate");
  assert.equal(size[size.length - 2], 40); // sqrt(1600)
  assert.equal(size[size.length - 1], 16);
  assert.equal((sizeExpression("sim", 0) as unknown[])[0], "interpolate"); // no division by zero domain
  const div = divergingColor("diff", 300) as unknown[];
  assert.deepEqual([div[3], div[5], div[7]], [-300, 0, 300]);
  assert.equal((sequentialColor("sim", 1000) as unknown[])[0], "interpolate");
});
