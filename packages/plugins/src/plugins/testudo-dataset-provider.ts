import {
  getGeolibrePackage,
  parseGeolibrePackage,
  type GeolibrePackage,
  type GeolibreScenario,
} from "./geolibre-package-loader";

type Primitive = string | number | boolean | null;
type Row = Record<string, unknown>;

/** A package source compatible with the existing Testudo package loaders. */
export interface TestudoDatasetSource {
  readonly baseUrl: string | null;
  read(path: string): Promise<ArrayBuffer>;
}

export type TestudoDatasetFormat = "parquet" | "sqlite" | "sqlite-gzip";

export interface TestudoCatalogEntry {
  table?: string;
  partition?: string;
  path?: string;
  did?: number;
  scenario?: string | number;
}

export interface TestudoDatasetDescriptor {
  id: string;
  table: string;
  format: TestudoDatasetFormat;
  paths: string[];
  dids: number[];
  scenarioIds: Array<string | number>;
  rowLimit: number;
  warnings: string[];
}

export interface TestudoScenarioMetadata {
  scid: string | number;
  name?: string;
  replications: Array<{
    did: number;
    didname?: string;
    xid?: number;
    xname?: string;
  }>;
}

export interface TestudoDatasetMetadata {
  schemaVersion?: string;
  format: TestudoDatasetFormat | null;
  resultsPath: string | null;
  catalogPath: string | null;
  scenarios: TestudoScenarioMetadata[];
  datasets: TestudoDatasetDescriptor[];
  dataContracts: Record<string, unknown>;
  warnings: string[];
}

export type TestudoFilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "IN" | "BETWEEN";

export interface TestudoQueryFilter {
  column: string;
  op: TestudoFilterOperator;
  value: Primitive | Primitive[];
}

export interface TestudoDatasetQuery {
  /** Dataset id or physical table name, e.g. `MISECT` or `MIPTPO`. */
  dataset: string;
  did?: number;
  scenarioId?: string | number;
  columns?: string[];
  /** Use SELECT DISTINCT for bounded dimension discovery queries. */
  distinct?: boolean;
  filters?: TestudoQueryFilter[];
  /** Maximum rows crossing the WASM/JavaScript boundary. Defaults to 50,000. */
  limit?: number;
}

export interface TestudoDatasetQueryResult {
  rows: Row[];
  /** Native DuckDB Arrow result for Parquet queries; null for SQLite fallback. */
  arrow?: TestudoArrowResult | null;
  columns: string[];
  rowCount: number;
  truncated: boolean;
  source: "parquet" | "sqlite";
  dataset: string;
  did: number | null;
  scenarioId: string | number | null;
  warnings: string[];
}

export interface TestudoArrowResult {
  toArray(): Array<Row & { toJSON?: () => Row }>;
}

export interface TestudoDuckDbConnection {
  query(sql: string): Promise<TestudoArrowResult>;
  close(): Promise<void> | void;
}

/**
 * Small DuckDB seam used by the provider. It deliberately hides AsyncDuckDB
 * and keeps file registration/drop ownership inside the provider session.
 */
export interface TestudoDuckDbRuntime {
  connect(): Promise<TestudoDuckDbConnection>;
  registerParquet(
    source: TestudoDatasetSource,
    entry: TestudoCatalogEntry,
    prefix: string,
  ): Promise<string>;
  dropFiles(handles: string[]): Promise<void>;
}

export interface TestudoSqliteDatabase {
  exec(sql: string): Array<{ columns?: string[]; values?: unknown[][] }>;
  close(): void;
}

export interface TestudoSqliteRuntime {
  open(bytes: Uint8Array): Promise<TestudoSqliteDatabase> | TestudoSqliteDatabase;
}

export interface OpenTestudoDatasetProviderOptions {
  source: TestudoDatasetSource;
  /** Legacy manifest with an attached `geolibre/package.v1` envelope, or the envelope itself. */
  manifest: unknown;
  duckdb?: TestudoDuckDbRuntime;
  sqlite?: TestudoSqliteRuntime;
  limits?: Partial<TestudoProviderLimits>;
}

export interface TestudoProviderLimits {
  defaultRows: number;
  maxRows: number;
  maxColumns: number;
  maxFilesPerQuery: number;
  maxFilters: number;
}

export interface TestudoDatasetProvider {
  readonly metadata: TestudoDatasetMetadata;
  describe(): TestudoDatasetMetadata;
  query(request: TestudoDatasetQuery): Promise<TestudoDatasetQueryResult>;
  /** Cached SIM_INFO access for playback timelines. */
  readSimulationInfo(selection?: { scenarioId?: string | number; did?: number }): Promise<TestudoDatasetQueryResult>;
  close(): Promise<void>;
}

const DEFAULT_LIMITS: TestudoProviderLimits = {
  defaultRows: 50_000,
  maxRows: 250_000,
  maxColumns: 64,
  maxFilesPerQuery: 64,
  maxFilters: 32,
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const id = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid dataset identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};
const asRows = (result: TestudoArrowResult): Row[] =>
  result.toArray().map((row) => typeof row.toJSON === "function" ? row.toJSON() : { ...row });

function finiteInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function entryDid(entry: TestudoCatalogEntry): number | null {
  const explicit = finiteInt(entry.did);
  if (explicit !== null) return explicit;
  const match = String(entry.partition ?? "").match(/(?:^|\/)did=([^/]+)/i);
  return match ? finiteInt(match[1]) : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function contractWarnings(dataContracts: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const add = (message: unknown): void => {
    if (typeof message === "string" && message.trim() && !warnings.includes(message)) warnings.push(message);
  };
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (path.endsWith("warnings")) value.forEach(add);
      return;
    }
    const object = asRecord(value);
    if (path && ["unavailable", "partial", "unknown", "unconfirmed-data", "ambiguous"].includes(String(object.status))) {
      add(`${path} contract status is ${String(object.status)}`);
    }
    if (Array.isArray(object.warnings)) object.warnings.forEach(add);
    if (typeof object.fallback_reason === "string") add(`${path}: ${object.fallback_reason}`);
    for (const [key, child] of Object.entries(object)) walk(child, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(dataContracts, "dataContracts", 0);
  return warnings;
}

function normalizeScenarios(pkg: GeolibrePackage): TestudoScenarioMetadata[] {
  return pkg.scenarios.map((scenario) => ({
    scid: scenario.scid,
    ...(scenario.name ? { name: scenario.name } : {}),
    replications: scenario.replications.map((replication) => ({
      did: replication.did,
      ...(replication.didname ? { didname: replication.didname } : {}),
      ...(replication.xid !== undefined && Number.isFinite(replication.xid) ? { xid: replication.xid } : {}),
      ...(replication.xname ? { xname: replication.xname } : {}),
    })),
  }));
}

function rawEnvironment(raw: unknown): Record<string, unknown> {
  return asRecord(asRecord(raw).environment);
}

function packageEnvelope(raw: unknown): GeolibrePackage {
  return getGeolibrePackage(raw) ?? parseGeolibrePackage(raw);
}

function resultPath(raw: unknown, pkg: GeolibrePackage): string | null {
  const root = asRecord(raw);
  const results = asRecord(root.results);
  const environment = rawEnvironment(raw);
  for (const value of [pkg.resultsPath, results.path, environment.sqlite_relative, environment.sqlite_path]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function catalogPath(raw: unknown, pkg: GeolibrePackage): string | null {
  const environment = rawEnvironment(raw);
  for (const value of [pkg.resultsCatalogRelative, environment.results_catalog_relative]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function resultFormat(raw: unknown, pkg: GeolibrePackage): TestudoDatasetFormat | null {
  const root = asRecord(raw);
  const results = asRecord(root.results);
  const environment = rawEnvironment(raw);
  const value = pkg.resultsFormat ?? results.format ?? environment.results_format;
  if (value === "parquet" || value === "sqlite" || value === "sqlite-gzip") return value;
  return null;
}

function parseCatalog(raw: unknown): TestudoCatalogEntry[] {
  const value = asRecord(raw);
  const files = Array.isArray(raw) ? raw : value.files;
  if (!Array.isArray(files)) return [];
  return files.map((entry) => {
    const item = asRecord(entry);
    return {
      ...(typeof item.table === "string" ? { table: item.table } : {}),
      ...(typeof item.partition === "string" ? { partition: item.partition } : {}),
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(finiteInt(item.did) !== null ? { did: finiteInt(item.did)! } : {}),
      ...(typeof item.scenario === "string" || typeof item.scenario === "number" ? { scenario: item.scenario } : {}),
    };
  }).filter((entry) => typeof entry.path === "string" && entry.path.length > 0);
}

function descriptorForCatalog(entries: TestudoCatalogEntry[], limits: TestudoProviderLimits): TestudoDatasetDescriptor[] {
  const groups = new Map<string, TestudoCatalogEntry[]>();
  for (const entry of entries) {
    const table = entry.table?.trim() || "results";
    const group = groups.get(table) ?? [];
    group.push(entry);
    groups.set(table, group);
  }
  return [...groups.entries()].map(([table, group]) => {
    const dids = unique(group.map(entryDid).filter((value): value is number => value !== null)).sort((a, b) => a - b);
    const scenarioIds = unique(group.map((entry) => entry.scenario).filter((value): value is string | number => value !== undefined));
    return {
      id: table,
      table,
      format: "parquet",
      paths: unique(group.map((entry) => entry.path!).filter(Boolean)),
      dids,
      scenarioIds,
      rowLimit: limits.maxRows,
      warnings: dids.length === 0 ? ["catalog entries do not declare a replication did"] : [],
    };
  });
}

function sqlLiteral(value: Primitive): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Query values must be finite numbers.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return q(value);
}

function buildFilter(filter: TestudoQueryFilter): string {
  const column = id(filter.column);
  if (filter.op === "IN") {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 256) {
      throw new Error("IN filters require between 1 and 256 values.");
    }
    return `${column} IN (${filter.value.map((value) => sqlLiteral(value)).join(", ")})`;
  }
  if (filter.op === "BETWEEN") {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new Error("BETWEEN filters require two values.");
    return `${column} BETWEEN ${sqlLiteral(filter.value[0])} AND ${sqlLiteral(filter.value[1])}`;
  }
  if (Array.isArray(filter.value)) throw new Error(`${filter.op} filters accept one value.`);
  if (filter.value === null && (filter.op === "=" || filter.op === "!=")) return `${column} IS${filter.op === "!=" ? " NOT" : ""} NULL`;
  return `${column} ${filter.op} ${sqlLiteral(filter.value)}`;
}

function queryLimit(requested: number | undefined, limits: TestudoProviderLimits): number {
  const value = requested ?? limits.defaultRows;
  if (!Number.isFinite(value) || Math.trunc(value) < 1) throw new Error("Query limit must be a positive integer.");
  return Math.min(Math.trunc(value), limits.maxRows);
}

function columnsFromRows(rows: Row[]): string[] {
  return rows.length ? Object.keys(rows[0]) : [];
}

function sqliteRows(result: { columns?: string[]; values?: unknown[][] }): Row[] {
  const columns = result.columns ?? [];
  return (result.values ?? []).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

async function inflateIfNeeded(buffer: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress the packaged SQLite gzip artifact.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function defaultDuckDbRuntime(): Promise<TestudoDuckDbRuntime> {
  const parquet = await import("./network-kpi-parquet-data");
  const db = await parquet.getDatabase();
  return {
    connect: async () => {
      const connection = await db.connect();
      return {
        query: (sql: string) => connection.query(sql) as unknown as Promise<TestudoArrowResult>,
        close: () => connection.close(),
      };
    },
    registerParquet: (source, entry, prefix) => parquet.registerParquetCatalogEntry(db, source, entry, prefix),
    dropFiles: async (handles) => { if (handles.length) await db.dropFiles(handles); },
  };
}

async function defaultSqliteRuntime(): Promise<TestudoSqliteRuntime> {
  const sql = await import("./network-kpi-data");
  const SQL = await sql.loadNetworkKpiSqlJs();
  return { open: (bytes) => new SQL.Database(bytes) as unknown as TestudoSqliteDatabase };
}

class TestudoDatasetProviderImpl implements TestudoDatasetProvider {
  readonly metadata: TestudoDatasetMetadata;
  private readonly source: TestudoDatasetSource;
  private readonly entries: TestudoCatalogEntry[];
  private readonly limits: TestudoProviderLimits;
  private readonly duckdb?: TestudoDuckDbRuntime;
  private duckdbRuntime: TestudoDuckDbRuntime | null = null;
  private duckdbRuntimeOpening: Promise<TestudoDuckDbRuntime> | null = null;
  private readonly sqlite?: TestudoSqliteRuntime;
  private readonly registered = new Map<string, string>();
  private readonly parquetOpening = new Map<string, Promise<string>>();
  private sqliteDb: TestudoSqliteDatabase | null = null;
  private sqliteOpening: Promise<TestudoSqliteDatabase> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly simulationInfoCache = new Map<string, Promise<TestudoDatasetQueryResult>>();

  constructor(
    source: TestudoDatasetSource,
    metadata: TestudoDatasetMetadata,
    entries: TestudoCatalogEntry[],
    options: Pick<OpenTestudoDatasetProviderOptions, "duckdb" | "sqlite" | "limits">,
  ) {
    this.source = source;
    this.metadata = metadata;
    this.entries = entries;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.duckdb = options.duckdb;
    this.sqlite = options.sqlite;
  }

  describe(): TestudoDatasetMetadata { return this.metadata; }

  readSimulationInfo(selection: { scenarioId?: string | number; did?: number } = {}): Promise<TestudoDatasetQueryResult> {
    const key = `${String(selection.scenarioId ?? "")}:${String(selection.did ?? "")}`;
    const cached = this.simulationInfoCache.get(key);
    if (cached) return cached;
    const pending = this.query({ dataset: "SIM_INFO", ...selection, columns: ["did", "scid", "from_time", "duration", "simstatintervals", "totalstatintervals"], limit: 8 });
    this.simulationInfoCache.set(key, pending);
    return pending;
  }

  async query(request: TestudoDatasetQuery): Promise<TestudoDatasetQueryResult> {
    if (this.closed) throw new Error("The Testudo dataset provider is closed.");
    const requestedTable = request.dataset.trim().toLowerCase();
    if (!requestedTable) throw new Error("A dataset is required.");
    const descriptor = this.metadata.datasets.find((item) => item.id.toLowerCase() === requestedTable || item.table.toLowerCase() === requestedTable);
    const table = descriptor?.table ?? request.dataset.trim();
    id(table);
    const limit = queryLimit(request.limit, this.limits);
    const columns = request.columns?.length ? request.columns.map((column) => id(column)) : ["*"];
    if (request.columns && request.columns.length > this.limits.maxColumns) throw new Error(`Query requests are limited to ${this.limits.maxColumns} columns.`);
    const filters = [...(request.filters ?? [])];
    if (filters.length > this.limits.maxFilters) throw new Error(`Query requests are limited to ${this.limits.maxFilters} filters.`);
    const scenario = request.scenarioId === undefined ? null : this.metadata.scenarios.find((item) => String(item.scid) === String(request.scenarioId));
    if (request.scenarioId !== undefined && !scenario) throw new Error(`Scenario ${String(request.scenarioId)} is not declared by the package.`);
    const scenarioDids = scenario?.replications.map((replication) => replication.did) ?? [];
    if (request.did !== undefined && (!Number.isFinite(request.did) || Math.trunc(request.did) !== request.did)) throw new Error("did must be an integer.");
    if (request.did !== undefined && scenarioDids.length && !scenarioDids.includes(request.did)) throw new Error(`did ${request.did} is not mapped to scenario ${String(request.scenarioId)}.`);
    const dids = request.did !== undefined ? [request.did] : scenarioDids;
    const resolvedDid = request.did ?? (scenarioDids.length === 1 ? scenarioDids[0] : null);
    const globalDataset = table.toUpperCase() === "META_SUB_INFO";
    if (dids.length && !globalDataset) filters.push({ column: "did", op: "IN", value: dids });
    const where = filters.map(buildFilter);
    const selectedEntries = this.entries.filter((entry) => (entry.table ?? "results").toLowerCase() === table.toLowerCase() && (globalDataset || dids.length === 0 || dids.includes(entryDid(entry) ?? Number.NaN)));
    const warnings = [...this.metadata.warnings, ...(descriptor?.warnings ?? [])];
    if (request.scenarioId !== undefined && dids.length === 0) warnings.push(`Scenario ${String(request.scenarioId)} has no declared replications.`);
    if (selectedEntries.length && selectedEntries.length <= this.limits.maxFilesPerQuery) {
      try {
        return await this.queryParquet(table, selectedEntries, columns, where, limit, request, resolvedDid, warnings);
      } catch (error) {
        if (!this.metadata.resultsPath) throw error;
        warnings.push(`Dataset ${table} Parquet query failed; using the SQLite/sql.js compatibility fallback: ${error instanceof Error ? error.message : String(error)}`);
        return this.querySqlite(table, columns, where, limit, request, resolvedDid, warnings);
      }
    }
    if (selectedEntries.length > this.limits.maxFilesPerQuery) throw new Error(`The query would register ${selectedEntries.length} files; the limit is ${this.limits.maxFilesPerQuery}.`);
    if (!this.metadata.resultsPath) throw new Error(`Dataset ${table} has no Parquet sidecar and no SQLite fallback.`);
    warnings.push(`Dataset ${table} is using the SQLite/sql.js compatibility fallback because no matching Parquet sidecar is declared.`);
    return this.querySqlite(table, columns, where, limit, request, resolvedDid, warnings);
  }

  private async getDuckDbRuntime(): Promise<TestudoDuckDbRuntime> {
    if (this.duckdbRuntime) return this.duckdbRuntime;
    this.duckdbRuntimeOpening ??= Promise.resolve(this.duckdb ?? defaultDuckDbRuntime());
    try {
      this.duckdbRuntime = await this.duckdbRuntimeOpening;
      return this.duckdbRuntime;
    } finally {
      this.duckdbRuntimeOpening = null;
    }
  }

  private async queryParquet(
    table: string,
    entries: TestudoCatalogEntry[],
    columns: string[],
    where: string[],
    limit: number,
    request: TestudoDatasetQuery,
    resolvedDid: number | null,
    warnings: string[],
  ): Promise<TestudoDatasetQueryResult> {
    const runtime = await this.getDuckDbRuntime();
    const handles: string[] = [];
    for (const entry of entries) {
      const path = entry.path!;
      let handle = this.registered.get(path);
      if (!handle) {
        let opening = this.parquetOpening.get(path);
        if (!opening) {
          opening = runtime.registerParquet(this.source, entry, `__testudo_${this.registered.size}`);
          this.parquetOpening.set(path, opening);
        }
        handle = await opening;
        this.parquetOpening.delete(path);
        if (this.closed) {
          await runtime.dropFiles([handle]);
          throw new Error("The Testudo dataset provider is closed.");
        }
        this.registered.set(path, handle);
      }
      handles.push(handle);
    }
    const connection = await runtime.connect();
    try {
      const sourceSql = `read_parquet([${handles.map(q).join(", ")}])`;
      const sql = `SELECT ${request.distinct ? "DISTINCT " : ""}${columns.join(", ")} FROM ${sourceSql} AS dataset${where.length ? ` WHERE ${where.join(" AND ")}` : ""} LIMIT ${limit + 1}`;
      const arrowResult = await connection.query(sql);
      const rows = asRows(arrowResult);
      return {
        rows: rows.slice(0, limit),
        arrow: arrowResult,
        columns: columns[0] === "*" ? columnsFromRows(rows) : request.columns ?? [],
        rowCount: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        source: "parquet",
        dataset: table,
        did: resolvedDid,
        scenarioId: request.scenarioId ?? null,
        warnings: unique(warnings),
      };
    } finally {
      await connection.close();
    }
  }

  private async querySqlite(
    table: string,
    columns: string[],
    where: string[],
    limit: number,
    request: TestudoDatasetQuery,
    resolvedDid: number | null,
    warnings: string[],
  ): Promise<TestudoDatasetQueryResult> {
    if (!this.sqliteDb) {
      const runtime = this.sqlite ?? await defaultSqliteRuntime();
      this.sqliteOpening ??= Promise.resolve().then(async () => runtime.open(await inflateIfNeeded(await this.source.read(this.metadata.resultsPath!))));
      try {
        const database = await this.sqliteOpening;
        if (this.closed) {
          database.close();
          throw new Error("The Testudo dataset provider is closed.");
        }
        this.sqliteDb = database;
      } finally {
        this.sqliteOpening = null;
      }
    }
    const sql = `SELECT ${request.distinct ? "DISTINCT " : ""}${columns.join(", ")} FROM ${id(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} LIMIT ${limit + 1}`;
    const result = this.sqliteDb.exec(sql)[0] ?? { columns: [], values: [] };
    const rows = sqliteRows(result);
    return {
      rows: rows.slice(0, limit),
      arrow: null,
      columns: result.columns ?? columnsFromRows(rows),
      rowCount: Math.min(rows.length, limit),
      truncated: rows.length > limit,
      source: "sqlite",
      dataset: table,
      did: resolvedDid,
      scenarioId: request.scenarioId ?? null,
      warnings: unique(warnings),
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      if (this.sqliteDb) {
        this.sqliteDb.close();
        this.sqliteDb = null;
      }
      if (this.sqliteOpening) {
        try {
          const database = await this.sqliteOpening;
          if (!this.sqliteDb) database.close();
        } catch {
          // The originating query reports an opening failure to its caller.
        }
        this.sqliteOpening = null;
      }
      if (this.parquetOpening.size) {
        const pending = [...this.parquetOpening.values()];
        this.parquetOpening.clear();
        // The query continuation owns the resolved handle and drops it after
        // observing `closed`; waiting here prevents close() from returning
        // while registration is still in flight without double-dropping it.
        await Promise.allSettled(pending);
      }
      if (this.registered.size && this.duckdbRuntime) {
        await this.duckdbRuntime.dropFiles([...this.registered.values()]);
        this.registered.clear();
      }
    })();
    return this.closePromise;
  }
}

/** Open a manifest-driven provider without eagerly loading result data. */
export async function openTestudoDatasetProvider(
  options: OpenTestudoDatasetProviderOptions,
): Promise<TestudoDatasetProvider> {
  const pkg = packageEnvelope(options.manifest);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const format = resultFormat(options.manifest, pkg);
  const declaredResultsPath = resultPath(options.manifest, pkg);
  const catalogPath = catalogPathFor(options.manifest, pkg) ?? (format === "parquet" ? declaredResultsPath : null);
  const resultsPath = format === "parquet" && catalogPath === declaredResultsPath ? null : declaredResultsPath;
  const warnings = contractWarnings(pkg.dataContracts);
  let entries: TestudoCatalogEntry[] = [];
  if (catalogPath) {
    try {
      entries = parseCatalog(JSON.parse(new TextDecoder().decode(await options.source.read(catalogPath))));
      if (!entries.length) warnings.push("The declared results catalog contains no usable Parquet files.");
    } catch {
      warnings.push("The declared results catalog could not be read; SQLite fallback will be used where available.");
    }
  }
  if (!catalogPath && format === "parquet") warnings.push("The package declares Parquet results but no results catalog path.");
  if (!format && resultsPath) warnings.push("The package does not declare a results format; provider will prefer catalog sidecars and then SQLite.");
  if (!resultsPath && !entries.length) warnings.push("The package declares neither Parquet datasets nor a SQLite results artifact.");
  const metadata: TestudoDatasetMetadata = {
    schemaVersion: pkg.schemaVersion,
    format: entries.length ? "parquet" : format,
    resultsPath,
    catalogPath,
    scenarios: normalizeScenarios(pkg),
    datasets: descriptorForCatalog(entries, limits),
    dataContracts: pkg.dataContracts,
    warnings: unique(warnings),
  };
  if (!metadata.datasets.length && resultsPath) {
    metadata.datasets = ["SIM_INFO", "MISECT", "MILANE", "MITURN", "MINODE", "MIPTPO", "MISECTIEM"].map((table) => ({
      id: table,
      table,
      format: format === "sqlite-gzip" ? "sqlite-gzip" : "sqlite",
      paths: [resultsPath],
      dids: unique(pkg.scenarios.flatMap((scenario) => scenario.replications.map((replication) => replication.did))),
      scenarioIds: pkg.scenarios.map((scenario) => scenario.scid),
      rowLimit: limits.maxRows,
      warnings: ["No Parquet sidecar is declared for this dataset; SQLite fallback is explicit."],
    }));
  }
  return new TestudoDatasetProviderImpl(options.source, metadata, entries, options);
}

function catalogPathFor(raw: unknown, pkg: GeolibrePackage): string | null {
  return catalogPath(raw, pkg);
}
