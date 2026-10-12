/**
 * DuckDB-WASM bootstrap that works when this code runs inside a plugin entry that GeoLibre
 * loads as a blob: ES module (fetch -> Blob -> import(blobUrl)).
 *
 * Constraints (see README.md for the full write-up):
 *  - A blob module has no usable import.meta.url, so nothing may be resolved relative to the
 *    module: no `new URL("./x.wasm", import.meta.url)`, no relative/bare dynamic import.
 *    Everything JS is bundled into the single entry file.
 *  - The worker script (~770 KB, classic script) is INLINED as a string and started from a
 *    blob: URL. The desktop CSP allows `worker-src blob: 'self'`.
 *  - The wasm binary (duckdb-eh.wasm, ~36 MB) cannot be inlined: the host rejects plugin
 *    entries over 50 MB (MAX_PLUGIN_ASSET_BYTES) and base64 would be ~48 MB per plugin x 7.
 *    It is therefore fetched at run time from a same-origin URL
 *    (default: <app>/plugins/_shared/duckdb/duckdb-eh.wasm) and, if that fails, from a pinned
 *    jsDelivr URL. Both are covered by connect-src ('self' / https:). `'wasm-unsafe-eval'` is
 *    already in script-src.
 *  - eh bundle only: the pthread (coi) build needs cross-origin isolation, which the app
 *    does not provide.
 *  - The instance is shared across all Aimsun plugin bundles via a Symbol.for global.
 */
import * as duckdb from "@duckdb/duckdb-wasm";

export const DUCKDB_WASM_VERSION = "1.33.1-dev57.0";

export interface DuckDbInitOptions {
  /** URL of duckdb-eh.wasm. Default: same-origin plugins/_shared/duckdb/duckdb-eh.wasm. */
  wasmUrl?: string;
  /** Extra fallbacks tried in order after wasmUrl. Default: pinned jsDelivr. */
  wasmFallbackUrls?: string[];
  /** Source text of duckdb-browser-eh.worker.js (inlined by the bundler, see browser.ts). */
  workerSource?: string;
  /** Or a worker script URL (same-origin or blob:). Wins over workerSource. */
  workerUrl?: string;
  logLevel?: "silent" | "info";
}

export interface DuckDbHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  /** Run SQL, return plain JS rows (BigInt -> number when safe, else string). */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Run statements without returning rows (supports `a; b; c;` scripts). */
  exec(sql: string): Promise<void>;
  /** Register an in-memory file under `name` for read_parquet/read_json_auto. */
  registerBuffer(name: string, data: Uint8Array): Promise<void>;
  /** Register a remote file (requires CORS + range requests). */
  registerUrl(name: string, url: string): Promise<void>;
  dropFile(name: string): Promise<void>;
  terminate(): Promise<void>;
}

const GLOBAL_KEY = Symbol.for("aimsun.validation.duckdb");

type GlobalSlot = { promise?: Promise<DuckDbHandle> };

/** Defaults resolved lazily so importing this module has no side effects in Node. */
export function defaultWasmUrls(): string[] {
  const urls: string[] = [];
  if (typeof document !== "undefined") {
    urls.push(new URL("plugins/_shared/duckdb/duckdb-eh.wasm", document.baseURI).href);
  }
  urls.push(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}/dist/duckdb-eh.wasm`);
  return urls;
}

/** BigInt-safe cell normaliser. */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  return v;
}

function makeWorker(opts: DuckDbInitOptions): { worker: Worker; revoke: () => void } {
  if (opts.workerUrl) return { worker: new Worker(opts.workerUrl), revoke: () => {} };
  if (!opts.workerSource) {
    throw new Error("DuckDB worker not configured: pass workerSource/workerUrl (import from browser.ts to get it inlined).");
  }
  const url = URL.createObjectURL(new Blob([opts.workerSource], { type: "text/javascript" }));
  return { worker: new Worker(url), revoke: () => URL.revokeObjectURL(url) };
}

async function instantiate(opts: DuckDbInitOptions): Promise<DuckDbHandle> {
  const candidates = [...(opts.wasmUrl ? [opts.wasmUrl] : defaultWasmUrls()), ...(opts.wasmFallbackUrls ?? [])];
  const errors: string[] = [];
  for (const wasmUrl of candidates) {
    const { worker, revoke } = makeWorker(opts);
    const logger = opts.logLevel === "info" ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    try {
      await db.instantiate(wasmUrl, null);
      const conn = await db.connect();
      revoke();
      return wrap(db, conn, worker);
    } catch (e) {
      errors.push(`${wasmUrl}: ${e instanceof Error ? e.message : String(e)}`);
      try {
        await db.terminate();
      } catch {
        /* ignore */
      }
      worker.terminate();
      revoke();
    }
  }
  throw new Error(`DuckDB-WASM could not be initialised. Tried:\n${errors.join("\n")}`);
}

function wrap(db: duckdb.AsyncDuckDB, conn: duckdb.AsyncDuckDBConnection, worker: Worker): DuckDbHandle {
  return {
    db,
    conn,
    async query<T>(sql: string): Promise<T[]> {
      const table = await conn.query(sql);
      return table.toArray().map((row) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row.toJSON())) o[k] = normalizeValue(v);
        return o as T;
      });
    },
    async exec(sql: string) {
      // AsyncDuckDBConnection.query handles multi-statement scripts (last result returned).
      await conn.query(sql);
    },
    async registerBuffer(name, data) {
      await db.registerFileBuffer(name, data);
    },
    async registerUrl(name, url) {
      await db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
    },
    async dropFile(name) {
      await db.dropFile(name);
    },
    async terminate() {
      const slot = (globalThis as Record<symbol, GlobalSlot | undefined>)[GLOBAL_KEY];
      if (slot) slot.promise = undefined;
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}

/** Get (or lazily create) the shared DuckDB instance. Concurrent callers share one promise. */
export function getDuckDb(opts: DuckDbInitOptions = {}): Promise<DuckDbHandle> {
  const g = globalThis as Record<symbol, GlobalSlot | undefined>;
  const slot = (g[GLOBAL_KEY] ??= {});
  if (!slot.promise) {
    slot.promise = instantiate(opts).catch((e) => {
      slot.promise = undefined; // allow retry
      throw e;
    });
  }
  return slot.promise;
}

/**
 * Fetch `url` and register it as `name` (buffer mode: no CORS-range requirement, works with
 * tauri/asset URLs). Returns the byte length.
 */
export async function registerFileByUrl(
  h: DuckDbHandle,
  name: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await h.registerBuffer(name, bytes);
  return bytes.byteLength;
}
