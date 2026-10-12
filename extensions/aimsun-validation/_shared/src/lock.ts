/**
 * ONE mutex for heavy operations on the shared DuckDB-WASM instance, common to every Aimsun plugin
 * bundle in the page (each bundle has its own copy of this module, so the state lives on globalThis).
 *
 * Key: Symbol.for("aimsun.validation.duckdb.lock") -> tail promise of the queue.
 * The older detector key Symbol.for("aimsun.validation.det.lock") is an ALIAS: every acquisition here
 * waits for the tails of BOTH keys and publishes its own tail under BOTH, so a bundle that still runs
 * the old detector `withLock` (read det.lock, write det.lock) and a bundle using this one exclude each
 * other. Not re-entrant: never call withDuckDbLock from inside a withDuckDbLock callback.
 */
export const DUCKDB_LOCK_KEY = Symbol.for("aimsun.validation.duckdb.lock");
export const DET_LOCK_KEY = Symbol.for("aimsun.validation.det.lock");

type Slots = Record<symbol, Promise<unknown> | undefined>;

/** Run `fn` exclusively (FIFO) with respect to every other withDuckDbLock / legacy detector lock user. */
export function withDuckDbLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as unknown as Slots;
  const now = Promise.resolve();
  const next = Promise.all([g[DUCKDB_LOCK_KEY] ?? now, g[DET_LOCK_KEY] ?? now]).then(() => fn());
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  g[DUCKDB_LOCK_KEY] = tail;
  g[DET_LOCK_KEY] = tail;
  return next;
}
