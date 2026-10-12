/**
 * A DbLike over native DuckDB (@duckdb/node-api, installed in ../_shared). It stands in for
 * duckdb-wasm in unit tests: the SQL is the same. registerBuffer writes the bytes to a temp
 * file and the process chdir()s there, because registerTable reads `pkg_<table>.parquet`
 * by relative name.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbLike } from "../src/common/controller.ts";

const require = createRequire(new URL("../../_shared/package.json", import.meta.url));
// loose typing: the package is installed under ../_shared, not resolvable by tsc from here
const { DuckDBInstance } = require("@duckdb/node-api") as { DuckDBInstance: { create: (path: string) => Promise<{ connect: () => Promise<any> }> } };

const stmts = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

export async function openNodeDb(): Promise<{ db: DbLike; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "aimsun-det-"));
  const cwd = process.cwd();
  process.chdir(dir);
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const db: DbLike = {
    async query<T>(sql: string): Promise<T[]> {
      return (await conn.runAndReadAll(sql)).getRowObjectsJson() as unknown as T[];
    },
    async exec(sql: string) {
      for (const s of stmts(sql)) await conn.run(s);
    },
    async registerBuffer(name: string, data: Uint8Array) {
      writeFileSync(join(dir, name), data);
    },
    async dropFile(name: string) {
      unlinkSync(join(dir, name));
    },
  };
  return {
    db,
    close: () => {
      conn.closeSync();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
