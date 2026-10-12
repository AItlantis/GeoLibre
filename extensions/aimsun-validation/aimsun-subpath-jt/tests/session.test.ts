// P2: subpath loading must not collide on global DuckDB file names, and dispose must free the plugin's catalog.
// The shared DuckDB-WASM handle is faked with native DuckDB (one instance, one connection per session), which is what
// the sessions see in the browser: a db-wide file namespace + per-connection catalogs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DuckDbHandle } from "../../_shared/src/duckdb.ts";
import { loadFromManifestUrl } from "../src/common/pkg.ts";
import { openSession } from "../src/common/session.ts";
import { DuckDBInstance } from "../../_shared/node_modules/@duckdb/node-api/lib/index.js";
import { rows as hrows, type DuckDBConnection } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "aimsun-session-"));
process.chdir(dir); // registerTable reads the registered name relative to the cwd in this fake

const splitStmts = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

function fakeConn(nc: DuckDBConnection) {
  return {
    async query(sql: string) {
      let last: Array<Record<string, unknown>> = [];
      for (const s of splitStmts(sql)) last = (await nc.runAndReadAll(s)).getRowObjectsJson() as Array<Record<string, unknown>>;
      return { toArray: () => last.map((r) => ({ ...r, toJSON: () => r })) };
    },
    async close() {
      nc.closeSync();
    },
  };
}

async function setup() {
  const inst = await DuckDBInstance.create(":memory:");
  const registered: string[] = [];
  const dropped: string[] = [];
  const live = new Set<string>();
  const main = await inst.connect();
  const h = {
    db: { connect: async () => fakeConn(await inst.connect()) },
    conn: fakeConn(main),
    query: async (sql: string) => (await fakeConn(main).query(sql)).toArray(),
    exec: async (sql: string) => void (await fakeConn(main).query(sql)),
    registerBuffer: async (name: string, bytes: Uint8Array) => {
      assert.ok(!live.has(name), `file name ${name} is already registered by another load (global namespace collision)`);
      live.add(name);
      registered.push(name);
      writeFileSync(join(dir, name), bytes);
    },
    registerUrl: async () => {},
    dropFile: async (name: string) => {
      live.delete(name);
      dropped.push(name);
      if (existsSync(join(dir, name))) unlinkSync(join(dir, name));
    },
    terminate: async () => {},
  } as unknown as DuckDbHandle;
  const admin = await inst.connect();
  return { inst, h, registered, dropped, live, admin };
}

async function parquetBytes(admin: DuckDBConnection, seconds: number, name: string): Promise<Uint8Array> {
  const f = join(dir, name).replace(/\\/g, "/");
  await admin.run(`COPY (SELECT 'R' AS route, 'IB' AS direction_norm, TIMESTAMP '2025-02-03 07:00:00' + to_minutes(15 * i) AS ts, ${seconds}::DOUBLE AS seconds, 'monthly_15min' AS source FROM range(0, 4) t(i)) TO '${f}' (FORMAT parquet)`);
  const b = new Uint8Array(readFileSync(join(dir, name)));
  unlinkSync(join(dir, name));
  return b;
}

const manifestFetch = (files: Record<string, Uint8Array | string>): typeof fetch =>
  (async (u: string) => {
    const v = files[String(u)];
    if (v === undefined) return new Response("nope", { status: 404 });
    return new Response(typeof v === "string" ? v : (v as BodyInit));
  }) as unknown as typeof fetch;

const pkgOf = (base: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => ({
  [`${base}/manifest.json`]: JSON.stringify({ schema_version: 1, run: base, files: [{ table: "subpath_obs_jt", path: "subpath_obs_jt.parquet", ...extra }] }),
  [`${base}/subpath_obs_jt.parquet`]: bytes,
});

const catalogs = async (admin: DuckDBConnection): Promise<string[]> => (await hrows(admin, "SELECT database_name n FROM duckdb_databases() ORDER BY 1")).map((r) => String(r.n));

test("two sessions load different packages concurrently: unique file names, no cross-talk, nothing left registered", async () => {
  const { h, registered, live, admin } = await setup();
  const bA = await parquetBytes(admin, 60, "a.parquet");
  const bB = await parquetBytes(admin, 90, "b.parquet");
  const f = manifestFetch({ ...pkgOf("http://t/A", bA), ...pkgOf("http://t/B", bB) });
  const sA = await openSession(h, "aimsun_subpath_jt");
  const sB = await openSession(h, "aimsun_subpath_validation");
  assert.notEqual(sA.catalog, sB.catalog);
  await Promise.all([loadFromManifestUrl(sA, "http://t/A/manifest.json", { fetchImpl: f }), loadFromManifestUrl(sB, "http://t/B/manifest.json", { fetchImpl: f })]);
  assert.equal(registered.length, 2);
  assert.notEqual(registered[0], registered[1]);
  assert.ok(registered.every((n) => !/^pkg_subpath_obs_jt\.parquet$/.test(n)), "no canonical global name");
  assert.equal(live.size, 0, "every registered file was dropped");
  assert.equal(Number((await sA.query<{ s: number }>("SELECT avg(seconds) AS s FROM subpath_obs_jt"))[0].s), 60);
  assert.equal(Number((await sB.query<{ s: number }>("SELECT avg(seconds) AS s FROM subpath_obs_jt"))[0].s), 90);
});

test("a failing load (corrupt parquet, bad sha256) still drops its registered file", async () => {
  const { h, live, registered, admin } = await setup();
  const s = await openSession(h, "aimsun_subpath_jt");
  const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(loadFromManifestUrl(s, "http://t/X/manifest.json", { fetchImpl: manifestFetch(pkgOf("http://t/X", bad)) }));
  assert.equal(registered.length, 1);
  assert.equal(live.size, 0);
  // sha256 mismatch is detected before anything is registered
  const good = await parquetBytes(admin, 60, "g.parquet");
  await assert.rejects(
    loadFromManifestUrl(s, "http://t/Y/manifest.json", { fetchImpl: manifestFetch(pkgOf("http://t/Y", good, { sha256: "0".repeat(64) })) }),
    /sha256 mismatch/,
  );
  assert.equal(registered.length, 1);
  // a correct hash passes
  const ok = createHash("sha256").update(good).digest("hex");
  const sum = await loadFromManifestUrl(s, "http://t/Z/manifest.json", { fetchImpl: manifestFetch(pkgOf("http://t/Z", good, { sha256: ok })) });
  assert.equal(sum.hasObs, true);
  assert.equal(live.size, 0);
});

test("a manifest path that escapes the package (encoded ..) is rejected before any file is fetched", async () => {
  const { h } = await setup();
  const s = await openSession(h, "aimsun_subpath_jt");
  const fetched: string[] = [];
  const f = (async (u: string) => {
    fetched.push(String(u));
    return new Response(JSON.stringify({ schema_version: 1, files: [{ table: "subpath_obs_jt", path: "%2e%2e/secret.parquet" }] }));
  }) as unknown as typeof fetch;
  await assert.rejects(loadFromManifestUrl(s, "http://t/P/manifest.json", { fetchImpl: f }), /path/);
  assert.deepEqual(fetched, ["http://t/P/manifest.json"]);
});

test("dispose drops the session's tables and views, detaches its catalog and closes it; another session is untouched", async () => {
  const { h, admin } = await setup();
  const b = await parquetBytes(admin, 60, "d.parquet");
  const f = manifestFetch({ ...pkgOf("http://t/A", b), ...pkgOf("http://t/B", b) });
  const sA = await openSession(h, "aimsun_subpath_jt");
  const sB = await openSession(h, "aimsun_subpath_jt"); // same plugin re-activated: its own, different catalog
  assert.notEqual(sA.catalog, sB.catalog);
  await loadFromManifestUrl(sA, "http://t/A/manifest.json", { fetchImpl: f });
  await loadFromManifestUrl(sB, "http://t/B/manifest.json", { fetchImpl: f });
  await sA.exec("CREATE OR REPLACE VIEW v_sp_obs AS SELECT * FROM subpath_obs_jt");
  assert.ok((await catalogs(admin)).includes(sA.catalog));
  await sA.dispose();
  await sA.dispose(); // idempotent
  const left = await catalogs(admin);
  assert.ok(!left.includes(sA.catalog), `catalog ${sA.catalog} still attached: ${left.join()}`);
  assert.ok(left.includes(sB.catalog));
  assert.equal(Number((await sB.query<{ n: number }>("SELECT count(*) AS n FROM subpath_obs_jt"))[0].n), 4);
  await sB.dispose();
  assert.ok(!(await catalogs(admin)).includes(sB.catalog));
});

test.after(() => {
  process.chdir(tmpdir());
  rmSync(dir, { recursive: true, force: true });
});
