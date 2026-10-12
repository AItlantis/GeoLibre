/**
 * An OdDb over native DuckDB (@duckdb/node-api, installed in ../_shared). Stands in for duckdb-wasm in
 * unit tests: the SQL is identical. A Src with kind "url" carries a LOCAL PATH here, returned as the reference.
 *
 * Like wasmOdDb, each OdDb works on its own connection inside its own attached in-memory catalog
 * (attach/detach) and can share ONE DuckDB instance with other OdDbs (pass `instance`), which is what the
 * isolation tests need. `files` mirrors the db-wide registered-file namespace (name -> path).
 */
import { createRequire } from "node:module";
import type { OdDb } from "../../_od/controller.ts";
import { withDuckDbLock } from "../../_shared/src/lock.ts";

const require = createRequire(new URL("../../_shared/package.json", import.meta.url));
const { DuckDBInstance } = require("@duckdb/node-api") as { DuckDBInstance: { create: (path: string) => Promise<NodeInstance> } };

export interface NodeInstance {
  connect: () => Promise<any>;
}

const stmts = (sql: string): string[] =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

export const newInstance = (): Promise<NodeInstance> => DuckDBInstance.create(":memory:");

export interface NodeDbOptions {
  /** Share an instance (and file registry) with other OdDbs. */
  instance?: NodeInstance;
  files?: Map<string, string>;
  /** Without attach/detach (legacy single-database double). */
  noCatalog?: boolean;
}

export async function openNodeDb(opts: NodeDbOptions = {}): Promise<{ db: OdDb; sqlLog: string[]; files: Map<string, string>; instance: NodeInstance }> {
  const instance = opts.instance ?? (await newInstance());
  const files = opts.files ?? new Map<string, string>();
  let conn = await instance.connect();
  const sqlLog: string[] = [];
  const db: OdDb = {
    async query<T>(sql: string): Promise<T[]> {
      sqlLog.push(sql);
      return (await conn.runAndReadAll(sql)).getRowObjectsJson() as T[];
    },
    async exec(sql: string) {
      sqlLog.push(sql);
      for (const s of stmts(sql)) await conn.run(s);
    },
    async registerSource(name, src) {
      if (!src.url) throw new Error("test source needs a path in .url");
      files.set(name, src.url);
      return src.url.replace(/\\/g, "/");
    },
    async dropFile(name) {
      files.delete(name);
    },
    lock: (fn) => withDuckDbLock(fn),
  };
  if (!opts.noCatalog) {
    let cat = "";
    db.attach = async (c) => {
      cat = c;
      conn = await instance.connect();
      await conn.run(`ATTACH ':memory:' AS ${c}`);
      await conn.run(`USE ${c}`);
    };
    db.detach = async (c) => {
      await conn.run("USE memory");
      await conn.run(`DETACH ${cat || c}`);
      conn.closeSync();
    };
  }
  return { db, sqlLog, files, instance };
}
