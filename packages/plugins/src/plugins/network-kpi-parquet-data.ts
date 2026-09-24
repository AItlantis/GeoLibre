import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { DuckDBDataProtocol } from "@duckdb/duckdb-wasm";
import type { NetworkKpiPackageSource } from "./network-kpi-data";
import { deriveSimulationTimeline, readSimulationTimeline as readProviderSimulationTimeline, type SimulationTimeline } from "../shared/simulation-timeline";
import { laneKey, type KpiRow, type NetworkKpiResults, type NetworkKpiSectionSample } from "./network-kpi-data";
import { catalogDid, pickDefaultDid, type CatalogEntry } from "./parquet-catalog";
import { openTestudoDatasetProvider, type TestudoDatasetProvider } from "./testudo-dataset-provider";
import { getDuckDbExtensionRepository } from "../shared/duckdb-extension-repository";

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
  // DuckDB-Wasm autoloads Parquet on the first read_parquet query. Keep its
  // signed extension on the Testudo origin so a cold browser needs no CDN.
  const extension = await db.connect();
  try {
    await extension.query(`SET custom_extension_repository = ${q(getDuckDbExtensionRepository())}`);
  } finally {
    await extension.close();
  }
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
  // Keep the Parquet suffix on the virtual filename. DuckDB-WASM uses the
  // registered filename when resolving the read_parquet table-function
  // overload; an extensionless handle can surface as the misleading
  // "function signature mismatch" error in the browser build.
  const handle = `${prefix}_${Math.random().toString(36).slice(2)}.parquet`;
  if (source.baseUrl) {
    const url = new URL(path, source.baseUrl).toString();
    await db.registerFileURL(handle, url, DuckDBDataProtocol.HTTP, true);
  } else {
    await db.registerFileBuffer(handle, new Uint8Array(await source.read(path)));
  }
  return handle;
}
function rows(result: { toArray(): Array<{ toJSON?: () => Row } & Row> }): Row[] {
  return result.toArray().map((r) => r.toJSON ? r.toJSON() : r);
}


export class ParquetResultsDatabase {
  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly source: NetworkKpiPackageSource,
    private readonly catalog: CatalogEntry[],
    private readonly manifest: unknown,
  ) {}
  private registered = new Map<string, string>();
  private fallback: TestudoDatasetProvider | null = null;
  private parquetDisabled = false;
  private closed = false;

  static async open(source: NetworkKpiPackageSource, catalogRelativePath: string, manifest: unknown = null): Promise<ParquetResultsDatabase> {
    const catalog = JSON.parse(new TextDecoder().decode(await source.read(catalogRelativePath))) as { files?: CatalogEntry[] } | CatalogEntry[];
    const files = Array.isArray(catalog) ? catalog : catalog.files;
    return new ParquetResultsDatabase(await getDatabase(), source, Array.isArray(files) ? files : [], manifest);
  }
  private entries(did: number | null): CatalogEntry[] {
    // The partition is used only to locate the relevant file. The query below
    // still filters on the writer-provided `did` column explicitly.
    return this.catalog.filter((e) => catalogDid(e) === did && (e.table === "MISECT" || e.table === "MILANE") && typeof e.path === "string");
  }
  async readSimulationTimeline(did: number | null = null): Promise<SimulationTimeline | null> {
    if (this.closed) throw new Error("The results database is closed.");
    if (this.parquetDisabled) return this.readFallbackTimeline(did);
    const entries = this.catalog.filter((e) => String(e.table ?? "").toUpperCase() === "SIM_INFO" && typeof e.path === "string");
    if (!entries.length) return null;
    try {
      const handles = await Promise.all(entries.map((e) => this.register(e)));
      const con = await this.db.connect();
      try {
        const result = rows(await con.query(`SELECT did, scid, from_time, duration, simstatintervals, totalstatintervals FROM read_parquet(${q(handles[0])})${did == null ? "" : ` WHERE did = ${did}`} LIMIT 1`));
        const row = result[0];
        if (!row) return null;
        const number = (...names: string[]) => { for (const name of names) { const value = Number(row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()]); if (Number.isFinite(value)) return value; } return null; };
        return deriveSimulationTimeline({ initialTimeSeconds: number("from_time", "initial_time"), durationSeconds: number("duration", "simulation_duration"), intervalCount: number("simstatintervals", "totalstatintervals"), source: "SIM_INFO" });
      } finally { await con.close(); }
    } catch (error) {
      this.parquetDisabled = true;
      console.warn("[GeoLibre] network-kpi: Parquet is unavailable; using the SQLite compatibility fallback.", error);
      return this.readFallbackTimeline(did);
    }
  }
  private async register(entry: CatalogEntry): Promise<string> {
    const path = entry.path!; const old = this.registered.get(path); if (old) return old;
    const handle = await registerParquetCatalogEntry(this.db, this.source, entry, `__network_kpi_${this.registered.size}`);
    this.registered.set(path, handle); return handle;
  }
  async read(options: { did?: number | null; sid?: number; interval?: number } = {}): Promise<NetworkKpiResults> {
    if (this.closed) throw new Error("The results database is closed.");
    if (this.parquetDisabled) return this.readFallback(options);
    const all = this.catalog;
    const dids = [...new Set(all.map(catalogDid).filter(Number.isFinite))].sort((a,b)=>a-b);
    const did = options.did ?? pickDefaultDid(all);
    const entries = this.entries(did);
    // Query the files through the handles registered above. Using the original
    // HTTP URLs here bypasses DuckDB-WASM's registered-file protocol and causes
    // `read_parquet` to fail with a misleading "function signature mismatch"
    // in the browser, even though the catalog and Parquet bytes are valid.
    const byTable = new Map<string, string[]>();
    for (const e of entries) {
      const table = e.table ?? "MISECT";
      byTable.set(table, [...(byTable.get(table) ?? []), await this.register(e)]);
    }
    const db = this.db; const con = await db.connect(); const runQuery = async (label: string, sql: string) => { try { return rows(await con.query(sql)); } catch (error) { throw new Error(`Network KPI ${label} query failed: ${error instanceof Error ? error.message : String(error)}`); } };
    try {
      const subquery = (table: string) => {
        const files = byTable.get(table) ?? [];
        return files.length === 1
          ? `read_parquet(${q(files[0])})`
          : `read_parquet([${files.map(q).join(",")}])`;
      };
      const misect = subquery("MISECT");
      const milane = subquery("MILANE");
      if (!misect) return { sections: new Map(), lanes: new Map(), intervals: [], sids: [], did, sid: options.sid ?? 0, interval: options.interval ?? 0, dids };
      const didSql = did === null ? "NULL" : String(did);
      const meta = await runQuery("metadata", `SELECT did, sid, ent FROM ${misect} x WHERE did = ${didSql} LIMIT 2000000`);
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
          ? `SELECT oid, AVG(flow) flow, AVG(speed) speed, AVG(density) density, AVG(dtime) dtime FROM ${misect} x WHERE ${baseWhere} AND ent <> 0 GROUP BY oid`
          : `SELECT oid, flow, speed, density, dtime FROM ${misect} x WHERE ${baseWhere} AND ent = ${resultInterval}`
      ));
      if (!milane) console.warn("[GeoLibre][network-kpi] MILANE partition unavailable; continuing with sections only");
      const laneRows = rows(await con.query(
        synthesize
          ? `SELECT oid, lane, AVG(flow) flow, AVG(speed) speed, AVG(density) density, AVG(dtime) dtime FROM ${milane} x WHERE ${baseWhere} AND ent <> 0 GROUP BY oid,lane`
          : `SELECT oid, lane, flow, speed, density, dtime FROM ${milane} x WHERE ${baseWhere} AND ent = ${resultInterval}`
      ));
      const value = (r: Row, k: string) => { const n=Number(r[k]); return Number.isFinite(n) && n >= 0 ? n : null; };
      const sections = new Map<number,KpiRow>(); for (const r of sectionRows) sections.set(Number(r.oid), {flow:value(r,"flow"),speed:value(r,"speed"),density:value(r,"density"),delay:value(r,"dtime")});
      const lanes = new Map<string,KpiRow>(); for (const r of laneRows) lanes.set(laneKey(Number(r.oid), Number(r.lane)-1), {flow:value(r,"flow"),speed:value(r,"speed"),density:value(r,"density"),delay:value(r,"dtime")});
      return { sections, lanes, intervals, sids, did, sid, interval: resultInterval, dids };
    } catch (error) {
      this.parquetDisabled = true;
      console.warn("[GeoLibre] network-kpi: Parquet query unavailable; using the SQLite compatibility fallback.", error);
      return this.readFallback(options);
    } finally { await con.close(); }
  }

  /** Load the selected section's complete interval series from the active slice. */
  async readSectionTimeSeries(
    oid: number,
    options: { did?: number | null; sid?: number } = {},
  ): Promise<NetworkKpiSectionSample[]> {
    if (this.closed) throw new Error("The results database is closed.");
    if (!Number.isFinite(oid)) return [];
    if (this.parquetDisabled) return this.readFallbackSectionTimeSeries(oid, options);
    const did = options.did ?? pickDefaultDid(this.catalog);
    const entries = this.entries(did).filter((entry) => String(entry.table ?? "").toUpperCase() === "MISECT");
    if (!entries.length) return [];
    try {
      const handles = await Promise.all(entries.map((entry) => this.register(entry)));
      const table = handles.length === 1
        ? `read_parquet(${q(handles[0])})`
        : `read_parquet([${handles.map(q).join(",")}])`;
      const con = await this.db.connect();
      try {
        const didSql = did === null ? "NULL" : String(did);
        const sid = options.sid ?? 0;
        const select = (aggregate: boolean) => `SELECT ent, flow, density, speed FROM ${table} WHERE did = ${didSql} AND sid = ${sid} AND oid = ${oid}${aggregate ? " AND ent = 0" : " AND ent <> 0"} ORDER BY ent`;
        let result = rows(await con.query(select(false)));
        // Some packages contain only the whole-period aggregate. Show that as
        // a single sample rather than making a valid section look unqueryable.
        if (!result.length) result = rows(await con.query(select(true)));
        return toSectionSamples(result);
      } finally {
        await con.close();
      }
    } catch (error) {
      this.parquetDisabled = true;
      console.warn("[GeoLibre] network-kpi: section time-series Parquet query failed; using the SQLite compatibility fallback.", error);
      return this.readFallbackSectionTimeSeries(oid, options);
    }
  }

  private async readFallbackSectionTimeSeries(
    oid: number,
    options: { did?: number | null; sid?: number },
  ): Promise<NetworkKpiSectionSample[]> {
    const provider = await this.getFallback();
    const metadata = provider.describe();
    const descriptor = metadata.datasets.find((item) => item.table.toUpperCase() === "MISECT");
    const did = options.did ?? descriptor?.dids?.[0];
    const filters = [
      { column: "sid" as const, op: "=" as const, value: options.sid ?? 0 },
      { column: "oid" as const, op: "=" as const, value: oid },
    ];
    const query = (aggregate: boolean) => provider.query({
      dataset: "MISECT",
      ...(did == null ? {} : { did }),
      columns: ["ent", "flow", "density", "speed"],
      filters: [...filters, { column: "ent" as const, op: aggregate ? "=" as const : "!=" as const, value: 0 }],
      limit: 100_000,
    });
    let result = await query(false);
    if (!result.rows.length) result = await query(true);
    return toSectionSamples(result.rows);
  }

  private async getFallback(): Promise<TestudoDatasetProvider> {
    if (this.fallback) return this.fallback;
    if (!this.manifest) throw new Error("Network KPI Parquet data is unavailable and no package manifest was supplied for the SQLite fallback.");
    this.fallback = await openTestudoDatasetProvider({ source: this.source, manifest: this.manifest });
    return this.fallback;
  }

  private async readFallbackTimeline(did: number | null): Promise<SimulationTimeline | null> {
    try { return await readProviderSimulationTimeline(await this.getFallback(), did == null ? {} : { did }); }
    catch { return null; }
  }

  private async readFallback(options: { did?: number | null; sid?: number; interval?: number }): Promise<NetworkKpiResults> {
    const provider = await this.getFallback();
    const metadata = provider.describe();
    const descriptor = metadata.datasets.find((item) => item.table.toUpperCase() === "MISECT");
    const declaredDids = [...new Set((descriptor?.dids ?? []).filter(Number.isFinite))].sort((a, b) => a - b);
    const didCandidates = options.did == null ? declaredDids : [options.did, ...declaredDids.filter((value) => value !== options.did)];
    let did = didCandidates[0] ?? null;
    let dimension = { rows: [] as Row[] };
    for (const candidate of didCandidates) {
      const result = await provider.query({ dataset: "MISECT", did: candidate, columns: ["did", "sid", "ent"], distinct: true, limit: 250_000 });
      if (result.rows.length || did == null) { did = candidate; dimension = result; break; }
    }
    const sids = [...new Set(dimension.rows.map((row) => Number(row.sid)).filter(Number.isFinite))].sort((a, b) => a - b);
    const intervals = [...new Set(dimension.rows.map((row) => Number(row.ent)).filter(Number.isFinite))].sort((a, b) => a - b);
    const sid = options.sid ?? (sids.includes(0) ? 0 : (sids[0] ?? 0));
    const requestedInterval = options.interval !== undefined && intervals.includes(options.interval) ? options.interval : (intervals.includes(0) ? 0 : (intervals[0] ?? 0));
    const synthesize = (options.interval === undefined || options.interval === 0) && !intervals.includes(0);
    const interval = synthesize ? 0 : requestedInterval;
    const filters = [{ column: "did" as const, op: "=" as const, value: did }, { column: "sid" as const, op: "=" as const, value: sid }];
    const readRows = async (table: "MISECT" | "MILANE", columns: string[]): Promise<Row[]> => {
      try {
        const result = await provider.query({ dataset: table, did: did ?? undefined, columns, filters: [...filters, { column: "ent", op: "=" as const, value: interval }], limit: 250_000 });
        return result.rows;
      } catch {
        const result = await provider.query({ dataset: table, did: did ?? undefined, columns: columns.filter((column) => column !== "dtime"), filters: [...filters, { column: "ent", op: "=" as const, value: interval }], limit: 250_000 });
        return result.rows;
      }
    };
    const averageRows = (rows: Row[], key: (row: Row) => string): Row[] => {
      const groups = new Map<string, { row: Row; sums: Record<string, number>; counts: Record<string, number> }>();
      for (const row of rows) {
        const group = groups.get(key(row)) ?? { row: { ...row }, sums: {}, counts: {} };
        for (const column of ["flow", "speed", "density", "dtime"]) {
          const number = Number(row[column]);
          if (Number.isFinite(number) && number >= 0) { group.sums[column] = (group.sums[column] ?? 0) + number; group.counts[column] = (group.counts[column] ?? 0) + 1; }
        }
        groups.set(key(row), group);
      }
      return [...groups.values()].map(({ row, sums, counts }) => { for (const column of Object.keys(sums)) row[column] = sums[column] / counts[column]; return row; });
    };
    const readNonAggregate = async (table: "MISECT" | "MILANE", columns: string[]) => {
      try { return (await provider.query({ dataset: table, did: did ?? undefined, columns, filters: [...filters, { column: "ent", op: "!=", value: 0 }], limit: 250_000 })).rows; }
      catch { return (await provider.query({ dataset: table, did: did ?? undefined, columns: columns.filter((column) => column !== "dtime"), filters: [...filters, { column: "ent", op: "!=", value: 0 }], limit: 250_000 })).rows; }
    };
    const sectionRows = synthesize
      ? averageRows(await readNonAggregate("MISECT", ["oid", "flow", "speed", "density", "dtime"]), (row) => String(row.oid))
      : await readRows("MISECT", ["oid", "flow", "speed", "density", "dtime"]);
    let laneRows: Row[] = [];
    try { laneRows = synthesize
      ? averageRows(await readNonAggregate("MILANE", ["oid", "lane", "flow", "speed", "density", "dtime"]), (row) => `${row.oid}:${row.lane}`)
      : await readRows("MILANE", ["oid", "lane", "flow", "speed", "density", "dtime"]); } catch { /* MILANE is optional in reduced packages. */ }
    const value = (row: Row, key: string) => { const number = Number(row[key]); return Number.isFinite(number) && number >= 0 ? number : null; };
    const sections = new Map<number, KpiRow>();
    for (const row of sectionRows) sections.set(Number(row.oid), { flow: value(row, "flow"), speed: value(row, "speed"), density: value(row, "density"), delay: value(row, "dtime") });
    const lanes = new Map<string, KpiRow>();
    for (const row of laneRows) lanes.set(laneKey(Number(row.oid), Number(row.lane) - 1), { flow: value(row, "flow"), speed: value(row, "speed"), density: value(row, "density"), delay: value(row, "dtime") });
    return { sections, lanes, intervals, sids, did, sid, interval, dids: declaredDids };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.registered.values()) { try { await this.db.dropFiles([handle]); } catch {} }
    this.registered.clear();
    if (this.fallback) await this.fallback.close();
  }
}

function toSectionSamples(rows: Row[]): NetworkKpiSectionSample[] {
  const value = (row: Row, key: string): number | null => {
    const number = Number(row[key]);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  return rows
    .map((row) => ({
      interval: Number(row.ent),
      flow: value(row, "flow"),
      density: value(row, "density"),
      speed: value(row, "speed"),
      delay: null,
    }))
    .filter((row) => Number.isFinite(row.interval))
    .sort((a, b) => a.interval - b.interval);
}
