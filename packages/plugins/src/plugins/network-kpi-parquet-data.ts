import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { DuckDBDataProtocol } from "@duckdb/duckdb-wasm";
import type { NetworkKpiPackageSource } from "./network-kpi-data";
import { laneKey, type KpiRow, type NetworkKpiResults } from "./network-kpi-data";
import { catalogDid, pickDefaultDid, type CatalogEntry } from "./parquet-catalog";

export type { CatalogEntry } from "./parquet-catalog";
export { pickDefaultDid } from "./parquet-catalog";
type Row = Record<string, unknown>;
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function createDatabase(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle({ mvp: { mainModule: duckdbWasmMvp, mainWorker: mvpWorker }, eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker } });
  const worker = new Worker(bundle.mainWorker!, { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({});
  return db;
}
export function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = createDatabase().catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}
export async function registerParquetCatalogEntry(
  db: duckdb.AsyncDuckDB,
  source: NetworkKpiPackageSource,
  entry: CatalogEntry,
  prefix = "__results",
): Promise<string> {
  const path = entry.path!;
  const handle = `${prefix}_${Math.random().toString(36).slice(2)}`;
  if (source.baseUrl) await db.registerFileURL(handle, new URL(path, source.baseUrl).toString(), DuckDBDataProtocol.HTTP, true);
  else await db.registerFileBuffer(handle, new Uint8Array(await source.read(path)));
  return handle;
}
function rows(result: { toArray(): Array<{ toJSON?: () => Row } & Row> }): Row[] {
  return result.toArray().map((r) => r.toJSON ? r.toJSON() : r);
}


export class ParquetResultsDatabase {
  private constructor(private readonly db: duckdb.AsyncDuckDB, private readonly source: NetworkKpiPackageSource, private readonly catalog: CatalogEntry[]) {}
  private registered = new Map<string, string>();
  private closed = false;

  static async open(source: NetworkKpiPackageSource, catalogRelativePath: string): Promise<ParquetResultsDatabase> {
    const catalog = JSON.parse(new TextDecoder().decode(await source.read(catalogRelativePath))) as { files?: CatalogEntry[] } | CatalogEntry[];
    const files = Array.isArray(catalog) ? catalog : catalog.files;
    return new ParquetResultsDatabase(await getDatabase(), source, Array.isArray(files) ? files : []);
  }
  private entries(did: number | null): CatalogEntry[] {
    // The partition is used only to locate the relevant file. The query below
    // still filters on the writer-provided `did` column explicitly.
    return this.catalog.filter((e) => catalogDid(e) === did && (e.table === "MISECT" || e.table === "MILANE") && typeof e.path === "string");
  }
  private async register(entry: CatalogEntry): Promise<string> {
    const path = entry.path!; const old = this.registered.get(path); if (old) return old;
    const handle = await registerParquetCatalogEntry(this.db, this.source, entry, `__network_kpi_${this.registered.size}`);
    this.registered.set(path, handle); return handle;
  }
  async read(options: { did?: number | null; sid?: number; interval?: number } = {}): Promise<NetworkKpiResults> {
    if (this.closed) throw new Error("The results database is closed.");
    const all = this.catalog;
    const dids = [...new Set(all.map(catalogDid).filter(Number.isFinite))].sort((a,b)=>a-b);
    const did = options.did ?? pickDefaultDid(all);
    const entries = this.entries(did);
    const byTable = new Map<string, string[]>();
    for (const e of entries) { const table = e.table ?? "MISECT"; byTable.set(table, [...(byTable.get(table) ?? []), await this.register(e)]); }
    const db = this.db; const con = await db.connect();
    try {
      const subquery = (table: string) => {
        const files = byTable.get(table) ?? [];
        return files.length ? `SELECT * FROM read_parquet([${files.map(q).join(",")}])` : "";
      };
      const misect = subquery("MISECT");
      const milane = subquery("MILANE");
      if (!misect) return { sections: new Map(), lanes: new Map(), intervals: [], sids: [], did, sid: options.sid ?? 0, interval: options.interval ?? 0, dids };
      const didSql = did === null ? "NULL" : String(did);
      const meta = rows(await con.query(`SELECT DISTINCT did, sid, ent FROM (${misect}) x WHERE did = ${didSql}`));
      const sids = [...new Set(meta.map(r=>Number(r.sid)).filter(Number.isFinite))].sort((a,b)=>a-b);
      const intervals = [...new Set(meta.map(r=>Number(r.ent)).filter(Number.isFinite))].sort((a,b)=>a-b);
      const sid = options.sid ?? (sids.includes(0) ? 0 : (sids[0] ?? 0));
      const interval = options.interval !== undefined && intervals.includes(options.interval) ? options.interval : (intervals.includes(0) ? 0 : (intervals[0] ?? 0));
      const wantsAggregate = options.interval === undefined || options.interval === 0;
      // Prefer a real ent=0 aggregate row when the exporter produced one; only
      // synthesize via AVG() across the non-zero intervals when it's genuinely
      // absent, matching the legacy SQLite reader's synthesizeSections/Lanes
      // fallback (network-kpi-data.ts) so a package with a real precomputed
      // aggregate is never silently overridden by a client-side recompute.
      const hasEntZero = intervals.includes(0);
      const synthesize = wantsAggregate && !hasEntZero;
      const resultInterval = synthesize ? 0 : interval;
      const baseWhere = `did = ${didSql} AND sid = ${sid}`;
      const sectionRows = rows(await con.query(
        synthesize
          ? `SELECT oid, AVG(flow) flow, AVG(speed) speed, AVG(density) density, AVG(dtime) dtime FROM (${misect}) x WHERE ${baseWhere} AND ent <> 0 GROUP BY oid`
          : `SELECT oid, flow, speed, density, dtime FROM (${misect}) x WHERE ${baseWhere} AND ent = ${resultInterval}`
      ));
      const laneRows = rows(await con.query(
        synthesize
          ? `SELECT oid, lane, AVG(flow) flow, AVG(speed) speed, AVG(density) density, AVG(dtime) dtime FROM (${milane}) x WHERE ${baseWhere} AND ent <> 0 GROUP BY oid,lane`
          : `SELECT oid, lane, flow, speed, density, dtime FROM (${milane}) x WHERE ${baseWhere} AND ent = ${resultInterval}`
      ));
      const value = (r: Row, k: string) => { const n=Number(r[k]); return Number.isFinite(n) && n >= 0 ? n : null; };
      const sections = new Map<number,KpiRow>(); for (const r of sectionRows) sections.set(Number(r.oid), {flow:value(r,"flow"),speed:value(r,"speed"),density:value(r,"density"),delay:value(r,"dtime")});
      const lanes = new Map<string,KpiRow>(); for (const r of laneRows) lanes.set(laneKey(Number(r.oid), Number(r.lane)-1), {flow:value(r,"flow"),speed:value(r,"speed"),density:value(r,"density"),delay:value(r,"dtime")});
      return { sections, lanes, intervals, sids, did, sid, interval: resultInterval, dids };
    } finally { await con.close(); }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed=true; for (const handle of this.registered.values()) { try { await this.db.dropFiles([handle]); } catch {} } this.registered.clear(); }
}
