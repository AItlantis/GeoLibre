// P1: two OD controllers (= two OD plugins) on ONE shared DuckDB must not see or drop each other's state.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OdController } from "../../_od/controller.ts";
import { buildIndex, type RawItem } from "../../_od/source.ts";
import { totalsSql } from "../../_shared/src/sql/od-adapter.sql.ts";
import { DET_LOCK_KEY, DUCKDB_LOCK_KEY, withDuckDbLock } from "../../_shared/src/lock.ts";
import { newInstance, openNodeDb } from "./node-db.ts";

const ROOT = process.env.AIMSUN_DATA_DIR;
const have = !!ROOT && ["AMPK_3", "PMPK_3"].every((r) => ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"].every((f) => existsSync(join(ROOT, r, f))));
const skip = !have && "set AIMSUN_DATA_DIR to the data root (<root>/<RUN>/od_before.parquet ...)";

const localIndex = (runs: string[]) => {
  const items: RawItem[] = [];
  for (const r of runs) {
    for (const f of ["od_before.parquet", "od_after.parquet", "centroids.geojson", "groupings.parquet"]) {
      items.push({ path: `${r}/${f}`, run: r, src: { name: `${r}/${f}`, kind: "url", url: join(ROOT!, r, f).replace(/\\/g, "/") } });
    }
  }
  return buildIndex("test", items);
};

/** relations owned by one catalog of the shared instance */
async function owned(inst: Awaited<ReturnType<typeof newInstance>>, cat: string): Promise<string[]> {
  const c = await inst.connect();
  const r = (await c.runAndReadAll(
    `SELECT view_name n FROM duckdb_views() WHERE database_name = '${cat}' AND NOT internal UNION ALL SELECT table_name FROM duckdb_tables() WHERE database_name = '${cat}'`,
  )).getRowObjectsJson() as Array<{ n: string }>;
  c.closeSync();
  return r.map((x) => x.n).sort();
}

test("two controllers on one DuckDB: different runs, no overwrite; dispose of one leaves the other intact", { skip, timeout: 600_000 }, async () => {
  const instance = await newInstance();
  const files = new Map<string, string>();
  const a = await openNodeDb({ instance, files });
  const b = await openNodeDb({ instance, files });
  const ca = new OdController(a.db);
  const cb = new OdController(b.db);
  assert.notEqual(ca.ns, cb.ns);
  // load concurrently: A = AMPK_3, B = PMPK_3
  await Promise.all([ca.loadIndex(localIndex(["AMPK_3"])), cb.loadIndex(localIndex(["PMPK_3"]))]);
  assert.equal(ca.state.phase, "ready");
  assert.equal(cb.state.phase, "ready");
  await Promise.all([ca.ensureCells(), cb.ensureCells()]);
  const ta = (await ca.q<Record<string, any>>(totalsSql()))[0];
  const tb = (await cb.q<Record<string, any>>(totalsSql()))[0];
  assert.ok(Math.abs(Number(ta.before) - 411_942.63) < 1, `A before ${ta.before}`);
  assert.ok(Math.abs(Number(tb.before) - 368_322.31) < 1, `B before ${tb.before}`);
  // registered files are namespaced per controller
  assert.ok([...files.keys()].every((k) => k.startsWith(ca.ns) || k.startsWith(cb.ns)));
  assert.ok(files.size > 0);
  // each catalog owns its relations incl. od_cell
  const own = await owned(instance, ca.ns);
  assert.ok(own.includes("od_cell") && own.includes("v_od_before_norm"), own.join());
  // dispose A: A's catalog and files are gone, B's still answers
  await ca.dispose();
  assert.deepEqual(await owned(instance, ca.ns), []);
  assert.ok([...files.keys()].every((k) => k.startsWith(cb.ns)));
  const tb2 = (await cb.q<Record<string, any>>(totalsSql()))[0];
  assert.ok(Math.abs(Number(tb2.before) - Number(tb.before)) < 1e-3);
  assert.ok((await owned(instance, cb.ns)).includes("od_cell"));
  await cb.dispose();
  assert.deepEqual(await owned(instance, cb.ns), []);
  assert.equal(files.size, 0);
});

test("dispose is idempotent and waits for a build in flight (nothing leaks)", { skip, timeout: 600_000 }, async () => {
  const instance = await newInstance();
  const files = new Map<string, string>();
  const a = await openNodeDb({ instance, files });
  const c = new OdController(a.db);
  await c.loadIndex(localIndex(["AMPK_3"]));
  const building = c.ensureCells();
  const disposing = c.dispose();
  await building.catch(() => {});
  await disposing;
  await c.dispose();
  assert.deepEqual(await owned(instance, c.ns), []);
  assert.equal(files.size, 0);
});

test("without attach/detach the controller still drops its relations on dispose", async () => {
  const a = await openNodeDb({ noCatalog: true });
  const c = new OdController(a.db);
  const q = (sql: string) => a.db.query<Record<string, any>>(sql);
  await a.db.exec("CREATE TABLE od_cell AS SELECT 1 AS o; CREATE VIEW od_before_raw AS SELECT 1 AS x");
  (c as any).attached = true; // pretend a load happened on a catalog-less db
  await c.dispose();
  assert.equal((await q("SELECT count(*) n FROM duckdb_tables() WHERE table_name = 'od_cell'"))[0].n, "0");
  assert.equal((await q("SELECT count(*) n FROM duckdb_views() WHERE view_name = 'od_before_raw'"))[0].n, "0");
});

test("withDuckDbLock: FIFO, exclusive, survives a rejecting task, and aliases the legacy det lock", async () => {
  const log: string[] = [];
  const slow = (id: string, ms: number, fail = false) =>
    withDuckDbLock(async () => {
      log.push(`${id}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${id}-`);
      if (fail) throw new Error(id);
    });
  const results = await Promise.allSettled([slow("a", 30), slow("b", 5, true), slow("c", 1)]);
  assert.deepEqual(log, ["a+", "a-", "b+", "b-", "c+", "c-"]);
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].status, "fulfilled");
  // a legacy detector-style lock (read det.lock, write det.lock) excludes shared-lock tasks and vice versa
  const g = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;
  const legacy = <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = g[DET_LOCK_KEY] ?? Promise.resolve();
    const next = prev.then(fn);
    g[DET_LOCK_KEY] = next.catch(() => undefined);
    return next;
  };
  const order: string[] = [];
  const t = (id: string, ms: number) => async () => {
    order.push(`${id}+`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${id}-`);
  };
  await Promise.all([withDuckDbLock(t("s1", 25)), legacy(t("d1", 5)), withDuckDbLock(t("s2", 5)), legacy(t("d2", 1))]);
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(0, 2), order[i + 1].slice(0, 2), `interleaved: ${order.join(" ")}`);
  assert.ok(g[DUCKDB_LOCK_KEY]);
});
