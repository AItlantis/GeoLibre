// OdController end to end on native DuckDB with the REAL AMPK_3 / PMPK_3 files (skipped when the data folder is absent).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OdController } from "../src/_od/controller.ts";
import { buildIndex, type RawItem } from "../src/_od/source.ts";
import { itemsFromManifest } from "../src/_od/source.ts";
import { selectionStatsSql, topPairsSql, tripLengthSql, totalsSql, groupMatrixSql } from "../../_shared/src/sql/od-adapter.sql.ts";
import { openNodeDb } from "./node-db.ts";

const ROOT = process.env.AIMSUN_DATA_DIR; // no default: set it to the data root, the real-data tests skip when unset
const have = !!ROOT && ["AMPK_3", "PMPK_3"].every((r) => ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"].every((f) => existsSync(join(ROOT, r, f))));
const near = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const localIndex = (runs: string[]) => {
  const items: RawItem[] = [];
  for (const r of runs) {
    for (const f of ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"]) {
      const p = join(ROOT!, r, f).replace(/\\/g, "/");
      items.push({ path: `${r}/${f}`, run: r, src: { name: `${r}/${f}`, kind: "url", url: p } });
    }
  }
  return buildIndex("test", items);
};

test("controller: no usable run -> error state with the missing file names", async () => {
  const { db } = await openNodeDb();
  const c = new OdController(db);
  await assert.rejects(c.loadIndex(buildIndex("x", [{ path: "A/od_before.parquet", src: { name: "n", kind: "url", url: "u" } }])), /No OD matrix found/);
  assert.notEqual(c.state.phase, "ready");
});

test("controller loads the synthetic assignment-only package as one OD Trips matrix", async () => {
  const fixture = new URL("../smoke/assignment-only/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", fixture), "utf8"));
  const { items } = await itemsFromManifest("http://fixture/manifest.json", manifest, async () => false);
  for (const item of items) item.src.url = new URL(item.path, fixture).pathname.replace(/^\//, "").replace(/\//g, "\\");
  const idx = buildIndex("assignment fixture", items, new Set(), manifest.analysis);
  const { db } = await openNodeDb();
  const c = new OdController(db);
  await c.loadIndex(idx);
  assert.equal(c.ready, true);
  assert.deepEqual(c.state.availableSides, ["before"]);
  assert.equal(c.state.analysis, "assignment");
  await c.ensureCells();
  const rows = await c.q<{ before: number; after: number }>("SELECT sum(before) AS before, sum(after) AS after FROM od_cell");
  assert.equal(Number(rows[0].before), 19);
  assert.equal(Number(rows[0].after), 0);
  await c.dispose();
});

test("controller on real data: runs, default grouping, od_cell totals, timings", { skip: !have && `AIMSUN_DATA_DIR unset or no data in it`, timeout: 300_000 }, async () => {
  const { db, sqlLog } = await openNodeDb();
  let tick = 0;
  const c = new OdController(db, () => (tick += 10));
  await c.loadIndex(localIndex(["PMPK_3", "AMPK_3"]));
  assert.equal(c.state.phase, "ready");
  assert.deepEqual(c.state.runs, ["AMPK_3", "PMPK_3"]);
  assert.equal(c.state.run, "AMPK_3");
  assert.deepEqual(c.state.groupings.map((g) => g.name).sort(), ["Centroids (Abu Dhabi Island)", "Centroids (GCC)"]);
  assert.equal(c.state.grouping, "Centroids (Abu Dhabi Island)");
  assert.deepEqual(c.state.groups.map((g) => g.name), ["AD Region (Outside)", "AD Mainland", "AD Other Islands", "AD Island", "North Emirates", "GCC (East)", "GCC (West)"]);
  assert.equal(c.state.centroids.length, 4528);
  assert.ok(c.state.timings.register > 0);
  // no matrix row was ever pulled: every query the controller issued is an aggregate / DESCRIBE / small lookup
  assert.ok(!sqlLog.some((s) => /SELECT \* FROM od_(before|after)_raw\s*$/i.test(s)));
  await c.ensureCells();
  await c.ensureCells(); // idempotent, one build
  assert.equal(sqlLog.filter((s) => s.includes("CREATE OR REPLACE TABLE od_cell")).length, 1);
  const t = (await c.q(totalsSql()))[0] as Record<string, any>;
  near(Number(t.before), 411_942.63, 1);
  near(Number(t.after), 334_560.38, 1);
  // switching the grouping keeps cells, changes the group matrix labels
  await c.selectGrouping("Centroids (GCC)");
  assert.equal(c.state.groups.length, 5);
  assert.equal(c.state.cellsReady, true);
  const gm = await c.q(groupMatrixSql());
  assert.ok(gm.length > 5 && gm.length <= 36);
  assert.ok(gm.some((r: any) => r.og === "Abu Dhabi Emirate"));
  // switching run drops the cells and reloads
  await c.selectRun("PMPK_3");
  assert.equal(c.state.run, "PMPK_3");
  assert.equal(c.state.cellsReady, false);
  assert.equal(c.state.grouping, "Centroids (GCC)"); // kept across runs
  await c.ensureCells();
  const t2 = (await c.q(totalsSql()))[0] as Record<string, any>;
  near(Number(t2.before), 368_322.31, 1);
  near(Number(t2.after), 322_400.48, 1);
});

test("trips queries on real data: top pairs, selection stats and histogram agree", { skip: !have && `AIMSUN_DATA_DIR unset or no data in it`, timeout: 300_000 }, async () => {
  const { db } = await openNodeDb();
  const c = new OdController(db);
  await c.loadIndex(localIndex(["AMPK_3"]));
  const top = await c.q<Record<string, any>>(topPairsSql({ side: "before", limit: 10, minTrips: 1 }));
  assert.equal(top.length, 10);
  const grp = c.state.groups[1].name; // a real group
  const sub = await c.q<Record<string, any>>(topPairsSql({ side: "after", origin: { kind: "group", value: grp }, destination: { kind: "group", value: grp }, limit: 50 }));
  assert.ok(sub.every((r) => r.origin_group === grp && r.destination_group === grp));
  const st = (await c.q<Record<string, any>>(selectionStatsSql({ side: "after", origin: { kind: "group", value: grp }, destination: { kind: "group", value: grp } })))[0];
  const h = await c.q<Record<string, any>>(tripLengthSql({ side: "after", origin: { kind: "group", value: grp }, destination: { kind: "group", value: grp }, binKm: 1 }));
  near(h.reduce((s, x) => s + Number(x.trips), 0), Number(st.trips), 1e-6 * Number(st.trips));
  assert.ok(Number(sub[0].trips) <= Number(st.trips));
});

test("loadUrl resolves false (never true) when the manifest 404s, is malformed or has no runs", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const res of [() => new Response("nf", { status: 404 }), () => new Response("{not json", { status: 200 }), () => new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })]) {
      globalThis.fetch = (async () => res()) as unknown as typeof fetch;
      const c = new OdController({} as never);
      assert.equal(await c.loadUrl("http://localhost/data/manifest.json"), false);
      assert.equal(c.state.phase, "error");
      assert.ok(c.state.message);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
