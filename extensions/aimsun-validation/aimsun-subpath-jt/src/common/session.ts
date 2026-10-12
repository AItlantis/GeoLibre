/**
 * A private DuckDB catalog for one plugin session. The DuckDB instance is a singleton shared by every Aimsun
 * plugin bundle (see _shared/README.md), and views bind their tables by name, so two plugins that
 * loaded different packages would clobber each other's `subpath_obs_jt` / `v_sp_obs`. Each session
 * therefore opens its own connection, ATTACHes an in-memory database named `<base>_<unique>` and USEs it
 * (the unique suffix keeps a re-activation, or a second instance, from ever sharing a catalog with a
 * previous one). Parquet files are registered db-wide under UNIQUE per-load names (see registerTable) and
 * dropped in a finally block right after use. dispose() drops every table/view of the catalog, detaches it
 * and closes the connection; it queues behind the shared DuckDB lock so it never races a load in flight.
 */
import type { DuckDbHandle } from "../../../_shared/src/duckdb";
import { normalizeValue } from "../../../_shared/src/duckdb";
import { withDuckDbLock } from "../../../_shared/src/lock";
import { uniqueSuffix } from "../../../_shared/src/package";

export interface Session extends DuckDbHandle {
  catalog: string;
  dispose(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function openSession(h: DuckDbHandle, base: string): Promise<Session> {
  if (!IDENT.test(base)) throw new Error(`invalid catalog name '${base}'`);
  const catalog = `${base}_${uniqueSuffix()}`;
  const conn = await h.db.connect();
  try {
    await conn.query(`ATTACH DATABASE ':memory:' AS ${catalog}`);
    await conn.query(`USE ${catalog}`);
  } catch (e) {
    await conn.close().catch(() => {});
    throw e;
  }
  let disposed = false;
  return {
    ...h,
    conn,
    catalog,
    async query<T>(sql: string): Promise<T[]> {
      const table = await conn.query(sql);
      return table.toArray().map((row) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row.toJSON())) o[k] = normalizeValue(v);
        return o as T;
      });
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await withDuckDbLock(async () => {
        try {
          // Drop what this catalog owns (views first: they depend on the tables), then detach it.
          const views = await conn.query(`SELECT view_name AS n FROM duckdb_views() WHERE database_name = '${catalog}' AND NOT internal`);
          for (const r of views.toArray()) await conn.query(`DROP VIEW IF EXISTS ${catalog}.main."${String(r.n).replace(/"/g, '""')}"`);
          const tables = await conn.query(`SELECT table_name AS n FROM duckdb_tables() WHERE database_name = '${catalog}'`);
          for (const r of tables.toArray()) await conn.query(`DROP TABLE IF EXISTS ${catalog}.main."${String(r.n).replace(/"/g, '""')}"`);
          await conn.query("USE memory");
          await conn.query(`DETACH DATABASE IF EXISTS ${catalog}`);
        } catch {
          /* best effort: the connection is closed below either way */
        }
        try {
          await conn.close();
        } catch {
          /* ignore */
        }
      });
    },
  };
}

/** Escape a string for a single-quoted SQL literal. */
export const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;
