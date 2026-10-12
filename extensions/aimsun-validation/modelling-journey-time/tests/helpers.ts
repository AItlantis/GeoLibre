// Dev-only: native DuckDB comes from ../_shared/node_modules (a relative path keeps tsc and tsx resolution identical).
import { DuckDBInstance, type DuckDBConnection } from "../../_shared/node_modules/@duckdb/node-api/lib/index.js";
export type { DuckDBConnection };

export async function memConn(): Promise<DuckDBConnection> {
  return (await DuckDBInstance.create(":memory:")).connect();
}

/** Run a multi-statement script (same SQL as duckdb-wasm; native DuckDB runs one statement at a time). */
export async function runScript(conn: DuckDBConnection, sql: string): Promise<void> {
  const stmts = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) await conn.run(s);
}

export async function rows(conn: DuckDBConnection, sql: string): Promise<Array<Record<string, unknown>>> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, unknown>>;
}
