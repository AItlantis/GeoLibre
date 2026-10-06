/** Lazy, generation-scoped reader for the host-proxied results.sqlite.zst artifact. */
export interface TestudoResultsSqlDatabase {
  exec(sql: string): Array<{ columns?: string[]; values?: unknown[][] }>;
  close(): void;
}

export interface TestudoResultsSqlFactory {
  Database: new (bytes?: Uint8Array) => TestudoResultsSqlDatabase;
}

export type TestudoLoadSqlJs = () => Promise<TestudoResultsSqlFactory>;

export const MAX_RESULTS_SQLITE_BYTES = 1024 * 1024 * 1024;
const COMPRESSED_CHUNK_BYTES = 256 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Results database loading was aborted.", "AbortError");
}

/** Decompress zstd incrementally, checking cancellation and the output bound per chunk. */
export async function decompressResultsZstd(
  input: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
  maxOutputBytes = MAX_RESULTS_SQLITE_BYTES,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const { Decompress } = await import("fzstd");
  throwIfAborted(signal);
  const compressed = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  const decoder = new Decompress((chunk) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maxOutputBytes) throw new Error(`Decompressed results database exceeds the ${maxOutputBytes}-byte size limit.`);
    chunks.push(chunk);
  });
  for (let offset = 0; offset < compressed.byteLength; offset += COMPRESSED_CHUNK_BYTES) {
    throwIfAborted(signal);
    const end = Math.min(compressed.byteLength, offset + COMPRESSED_CHUNK_BYTES);
    decoder.push(compressed.subarray(offset, end), end === compressed.byteLength);
    // Yield so reload/unload aborts can be observed between compressed chunks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!compressed.byteLength) decoder.push(new Uint8Array(), true);
  throwIfAborted(signal);
  const output = new Uint8Array(outputBytes);
  let cursor = 0;
  for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.byteLength; }
  chunks.length = 0;
  return output;
}

export interface TestudoResultsSchema {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}

/** Discover physical tables/columns without assuming optional capability tables exist. */
export function discoverResultsSchema(db: TestudoResultsSqlDatabase): TestudoResultsSchema {
  const tableRows = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? [];
  const tables = new Set(tableRows.flatMap((row) => typeof row[0] === "string" ? [row[0]] : []));
  const columns = new Map<string, Set<string>>();
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
    const fields = db.exec(`PRAGMA table_info('${table.replaceAll("'", "''")}')`)[0]?.values ?? [];
    columns.set(table.toUpperCase(), new Set(fields.flatMap((row) => typeof row[1] === "string" ? [row[1].toLowerCase()] : [])));
  }
  return { tables: new Set([...tables].map((table) => table.toUpperCase())), columns };
}

interface CacheEntry {
  promise: Promise<TestudoResultsSqlDatabase>;
  database?: TestudoResultsSqlDatabase;
  references: number;
}

const databases = new Map<string, CacheEntry>();

export interface TestudoResultsDbLease {
  database: TestudoResultsSqlDatabase;
  release(): void;
}

/** Shared only by sessions with the same TView generation; final release closes sql.js. */
export async function acquireTestudoResultsDb(options: {
  tviewId: string;
  generation: number;
  artifactPath: string;
  fetchArtifact: (path: string) => Promise<ArrayBuffer>;
  loadSqlJs: TestudoLoadSqlJs;
  signal?: AbortSignal;
}): Promise<TestudoResultsDbLease> {
  throwIfAborted(options.signal);
  const key = `${options.tviewId}:${options.generation}`;
  let entry = databases.get(key);
  if (!entry) {
    const created: CacheEntry = { promise: Promise.resolve(null as unknown as TestudoResultsSqlDatabase), references: 0 };
    created.promise = (async () => {
      const artifact = await options.fetchArtifact(options.artifactPath);
      throwIfAborted(options.signal);
      const bytes = await decompressResultsZstd(artifact, options.signal);
      throwIfAborted(options.signal);
      const sql = await options.loadSqlJs();
      throwIfAborted(options.signal);
      const database = new sql.Database(bytes);
      created.database = database;
      return database;
    })().catch((error) => {
      if (databases.get(key) === created) databases.delete(key);
      throw error;
    });
    entry = created;
    databases.set(key, entry);
  }
  entry.references += 1;
  let database: TestudoResultsSqlDatabase;
  try { database = await entry.promise; }
  catch (error) { entry.references = Math.max(0, entry.references - 1); throw error; }
  if (options.signal?.aborted) {
    entry.references = Math.max(0, entry.references - 1);
    if (!entry.references && databases.get(key) === entry) {
      databases.delete(key);
      entry.database?.close();
    }
    throwIfAborted(options.signal);
  }
  let released = false;
  return {
    database,
    release() {
      if (released) return;
      released = true;
      entry!.references = Math.max(0, entry!.references - 1);
      if (!entry!.references && databases.get(key) === entry) {
        databases.delete(key);
        entry!.database?.close();
      }
    },
  };
}
