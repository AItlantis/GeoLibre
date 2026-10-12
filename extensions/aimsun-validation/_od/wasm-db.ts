/**
 * OdDb on top of the shared DuckDB-WASM handle (from _shared/src/duckdb.ts).
 *
 *  - a picked File is registered with BROWSER_FILEREADER: DuckDB reads byte ranges straight from the File,
 *    the 17-35 MB parquet files are never copied into JS memory;
 *  - every OdDb instance (= one OdController) works on its OWN connection inside its own attached in-memory
 *    catalog (attach/detach), so two OD plugins on the shared DuckDB never see each other's views/tables;
 *    files are registered db-wide under the controller's unique names and dropped by the controller;
 *  - a URL is registered as an HTTP file (range requests: footer + needed column chunks). If the server
 *    cannot serve ranges / HEAD, the file is fetched once and registered as a buffer (fallback, slower).
 */
import type { DuckDbHandle } from "../_shared/src/duckdb.ts";
import { normalizeValue } from "../_shared/src/duckdb.ts";
import { withDuckDbLock } from "../_shared/src/lock.ts";
import type { OdDb } from "./controller.ts";
import { dropOdStateSql } from "../_shared/src/sql/od-adapter.sql.ts";
import type { Src } from "./source.ts";

/** DuckDBDataProtocol.BROWSER_FILEREADER (the enum lives in @duckdb/duckdb-wasm, which only resolves from _shared). */
const BROWSER_FILEREADER = 2;

export function wasmOdDb(h: DuckDbHandle): OdDb {
  let conn: Awaited<ReturnType<DuckDbHandle["db"]["connect"]>> | null = null;
  let catalog: string | null = null;
  const run = async <T>(sql: string): Promise<T[]> => {
    if (!conn) return h.query<T>(sql); // not attached (should not happen for controllers): shared default connection
    const table = await conn.query(sql);
    return table.toArray().map((row) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row.toJSON())) o[k] = normalizeValue(v);
      return o as T;
    });
  };
  const probe = async (name: string, isParquet: boolean): Promise<void> => {
    if (isParquet) await run(`SELECT count(*) AS n FROM read_parquet('${name}')`);
  };
  return {
    lock: (fn) => withDuckDbLock(fn),
    async attach(name: string): Promise<void> {
      if (conn) return;
      const c = await h.db.connect();
      try {
        await c.query(`ATTACH DATABASE ':memory:' AS ${name}`);
        await c.query(`USE ${name}`);
      } catch (e) {
        await c.close().catch(() => {});
        throw e;
      }
      conn = c;
      catalog = name;
    },
    async detach(name: string): Promise<void> {
      const c = conn;
      if (!c) return;
      conn = null;
      try {
        // drop what the catalog owns explicitly (od_cell is ~4.5M rows), then detach it
        await c.query(dropOdStateSql());
        await c.query("USE memory");
        await c.query(`DETACH DATABASE IF EXISTS ${catalog ?? name}`);
      } catch {
        /* best effort: closing the connection below releases the rest */
      }
      catalog = null;
      await c.close().catch(() => {});
    },
    query: (sql) => run(sql),
    exec: async (sql) => {
      if (!conn) return h.exec(sql);
      await conn.query(sql);
    },
    dropFile: (name) => h.dropFile(name),
    async registerSource(name: string, src: Src): Promise<string> {
      const parquet = name.endsWith(".parquet");
      await h.dropFile(name).catch(() => {}); // only ever this controller's own unique name
      if (src.kind === "file" && src.file) {
        try {
          await h.db.registerFileHandle(name, src.file as File, BROWSER_FILEREADER as never, true);
          await probe(name, parquet);
          return name;
        } catch {
          await h.dropFile(name).catch(() => {});
          await h.registerBuffer(name, new Uint8Array(await src.file.arrayBuffer()));
          return name;
        }
      }
      if (!src.url) throw new Error(`no source for ${name}`);
      try {
        await h.registerUrl(name, src.url);
        await probe(name, parquet);
        return name;
      } catch {
        await h.dropFile(name).catch(() => {});
        const res = await fetch(src.url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`Could not fetch ${src.name}: HTTP ${res.status}`);
        await h.registerBuffer(name, new Uint8Array(await res.arrayBuffer()));
        return name;
      }
    },
  };
}
