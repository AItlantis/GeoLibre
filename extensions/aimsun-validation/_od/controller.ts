/**
 * State + DuckDB orchestration shared by the three OD plugins.
 *
 * Memory model: the parquet files are registered with DuckDB as file handles / URLs (see wasm-db.ts) and wrapped
 * in views, so DuckDB streams them; JS only ever receives aggregated result sets (<= a few thousand rows).
 * `od_cell` (the integer-keyed union of both matrices, ~4.5M rows) lives inside DuckDB and is built on demand.
 */
import { uniqueSuffix } from "../_shared/src/package.ts";
import {
  buildOdAdapterSql, buildOdCellSql, centroidsFromGeoJsonSql, dropOdStateSql, groupSizesSql, listGroupingsSql, odCentroidsSql, parquetViewSql, pickDefaultGrouping,
  type GroupingInfo,
} from "../_shared/src/sql/od-adapter.sql.ts";
import { indexFromFiles, indexFromManifestUrl, type OdPackageIndex, type RunFiles, type Src } from "./source.ts";
import type { HashStatus, VerifyFn } from "./verify.ts";

export interface OdDb {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Make `src` readable by DuckDB under `name`; returns the string to put in read_parquet()/read_json_auto(). */
  registerSource(name: string, src: Src): Promise<string>;
  dropFile(name: string): Promise<void>;
  /**
   * Open a PRIVATE in-memory catalog `catalog` on a connection of its own and make it the default for every
   * later query/exec of this OdDb. Optional: without it (unit-test doubles with one private database) the
   * controller falls back to dropping its relations explicitly.
   */
  attach?(catalog: string): Promise<void>;
  /** Drop everything in the catalog, detach it and close its connection. */
  detach?(catalog: string): Promise<void>;
  /** Serialise heavy operations with every other user of the shared DuckDB (withDuckDbLock in the wasm build). */
  lock?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface OdControllerOptions {
  now?: () => number;
  /** Verify the manifest sha256 of a source before it is registered (see verify.ts). Absent: declared hashes are reported as unverified. */
  verify?: VerifyFn;
}

export interface CentroidInfo {
  id: string;
  name: string;
  grp: string;
  lon: number | null;
  lat: number | null;
}

export type Phase = "idle" | "loading" | "ready" | "error";

export interface OdState {
  phase: Phase;
  /** Human readable progress / error text (English; the panel translates the fixed ones). */
  message: string;
  runs: string[];
  run: string | null;
  incomplete: OdPackageIndex["incomplete"];
  groupings: GroupingInfo[];
  grouping: string | null;
  groups: Array<{ name: string; n: number }>;
  centroids: CentroidInfo[];
  cellsReady: boolean;
  /** Integrity status of the files of the loaded run (sha256 declared in the manifest -> verified, else "hash not verified"). */
  hashes: HashStatus[];
  /** Milliseconds per step of the last run load (register, centroids, groupings, cells). */
  timings: Record<string, number>;
}

const initial = (): OdState => ({
  phase: "idle", message: "", runs: [], run: null, incomplete: [], groupings: [], grouping: null, groups: [], centroids: [], cellsReady: false, hashes: [], timings: {},
});

/** Registered-file stems; the controller prefixes its unique namespace (DuckDB file names are global to the shared instance). */
const FILES = { before: "od_before.parquet", after: "od_after.parquet", groupings: "groupings.parquet", centroids: "centroids.geojson" };

const withLock = <T>(db: OdDb, fn: () => Promise<T>): Promise<T> => (db.lock ? db.lock(fn) : fn());

export class OdController {
  state: OdState = initial();
  packageUrl: string | null = null;
  private index: OdPackageIndex | null = null;
  private listeners = new Set<() => void>();
  private registered: string[] = [];
  private gen = 0;
  private cellsPromise: Promise<void> | null = null;
  /** Unique per controller instance: names the private catalog and every registered file. */
  readonly ns = `aimsun_od_${uniqueSuffix()}`;
  private attached = false;
  private disposed = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly verify?: VerifyFn;

  constructor(readonly db: OdDb, opts: OdControllerOptions | (() => number) = {}) {
    const o = typeof opts === "function" ? { now: opts } : opts;
    this.now = o.now ?? (() => performance.now());
    this.verify = o.verify;
  }

  /** Track a unit of DuckDB work so dispose() can wait for it before dropping the catalog. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = (): void => void this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  private fileName(stem: string): string {
    return `${this.ns}_${stem}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<OdState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  get ready(): boolean {
    return this.state.phase === "ready";
  }

  async loadUrl(url: string, run?: string): Promise<void> {
    this.set({ ...initial(), phase: "loading", message: "Reading manifest…" });
    try {
      const idx = await indexFromManifestUrl(url);
      this.packageUrl = url;
      await this.loadIndex(idx, run);
    } catch (e) {
      this.fail(e);
    }
  }

  async loadFiles(list: ArrayLike<File>): Promise<void> {
    this.set({ ...initial(), phase: "loading", message: "Reading folder…" });
    try {
      this.packageUrl = null;
      await this.loadIndex(indexFromFiles("package", list));
    } catch (e) {
      this.fail(e);
    }
  }

  async loadIndex(idx: OdPackageIndex, preferRun?: string): Promise<void> {
    this.index = idx;
    if (!idx.runs.length) {
      const why = idx.incomplete.map((i) => `${i.run}: missing ${i.missing.join(", ")}`).join("; ");
      throw new Error(`No run with od_before.parquet, od_after.parquet and centroids.geojson found${why ? ` (${why})` : ""}`);
    }
    const runs = idx.runs.map((r) => r.run);
    const run = preferRun && runs.includes(preferRun) ? preferRun : runs[0];
    this.set({ runs, incomplete: idx.incomplete });
    await this.selectRun(run);
  }

  private fail(e: unknown): void {
    this.set({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  }

  async selectRun(run: string): Promise<void> {
    const files = this.index?.runs.find((r) => r.run === run);
    if (!files) return;
    const gen = ++this.gen;
    this.cellsPromise = null;
    this.set({ phase: "loading", message: `Loading ${run}…`, run, cellsReady: false, hashes: [], timings: {} });
    try {
      await this.track(withLock(this.db, () => this.prepare(files, gen)));
    } catch (e) {
      if (gen === this.gen) this.fail(e);
    }
  }

  private async prepare(files: RunFiles, gen: number): Promise<void> {
    if (this.disposed || gen !== this.gen) return; // superseded while waiting for the lock
    const db = this.db;
    if (!this.attached) {
      await db.attach?.(this.ns);
      this.attached = true;
    }
    const timings: Record<string, number> = {};
    let t = this.now();
    const lap = (k: string): void => {
      const n = this.now();
      timings[k] = Math.round(n - t);
      t = n;
    };
    for (const f of this.registered) await db.dropFile(f).catch(() => {});
    this.registered = [];
    // everything of the previous run goes first (od_cell is ~4.5M rows and would otherwise stay until rebuilt)
    await db.exec(dropOdStateSql());
    // manifest sha256: streamed through an incremental digest, never buffered (verify.ts)
    const hashes: HashStatus[] = [];
    for (const src of [files.before, files.after, files.centroids, ...(files.groupings ? [files.groupings] : [])]) {
      hashes.push(this.verify ? await this.verify(src) : { name: src.name, state: src.sha256 ? "unverified" : "undeclared", ms: 0, bytes: 0 });
      if (this.disposed || gen !== this.gen) return;
    }
    this.set({ hashes });
    lap("verify");
    const reg = async (stem: string, src: Src): Promise<string> => {
      const name = this.fileName(stem);
      this.registered.push(name); // before the call: a failed registration is still cleaned up
      return db.registerSource(name, src);
    };
    const before = await reg(FILES.before, files.before);
    const after = await reg(FILES.after, files.after);
    await db.exec(parquetViewSql("od_before_raw", before) + parquetViewSql("od_after_raw", after));
    // fail fast with a readable message when the schema is not the extractor's
    const cols = await db.query<{ column_name: string }>("SELECT column_name FROM (DESCRIBE SELECT * FROM od_before_raw)");
    const names = new Set(cols.map((c) => c.column_name));
    for (const need of ["origin_id", "destination_id", "value"]) if (!names.has(need)) throw new Error(`od_before.parquet: missing column ${need}`);
    lap("register");
    const cen = await reg(FILES.centroids, files.centroids);
    await db.exec(centroidsFromGeoJsonSql(cen));
    await db.dropFile(this.fileName(FILES.centroids)).catch(() => {});
    this.registered = this.registered.filter((x) => x !== this.fileName(FILES.centroids));
    lap("centroids");
    if (files.groupings) {
      const g = await reg(FILES.groupings, files.groupings);
      await db.exec(parquetViewSql("groupings_raw", g));
    } else {
      await db.exec(`CREATE OR REPLACE VIEW groupings_raw AS SELECT CAST(NULL AS BIGINT) AS grouping_id, CAST(NULL AS VARCHAR) AS grouping_name, CAST(NULL AS VARCHAR) AS filter_type,
        CAST(NULL AS BIGINT) AS group_id, CAST(NULL AS VARCHAR) AS group_name, CAST(NULL AS VARCHAR) AS group_external_id, CAST(NULL AS VARCHAR) AS membership_policy,
        CAST(NULL AS BIGINT) AS member_id, CAST(NULL AS VARCHAR) AS member_external_id, CAST(NULL AS VARCHAR) AS member_name WHERE false`);
    }
    const gs = (await db.query<Record<string, unknown>>(listGroupingsSql())).map(
      (r): GroupingInfo => ({ name: String(r.name), nGroups: Number(r.n_groups), nMembers: Number(r.n_members), maxGroup: Number(r.max_group) }),
    );
    lap("groupings");
    if (gen !== this.gen) return;
    const keep = this.state.grouping && gs.some((x) => x.name === this.state.grouping) ? this.state.grouping : pickDefaultGrouping(gs);
    this.set({ groupings: gs, timings });
    await this.applyGrouping(keep, gen);
    if (gen !== this.gen) return;
    this.set({ phase: "ready", message: "" });
  }

  private async applyGrouping(name: string | null, gen: number): Promise<void> {
    await this.db.exec(buildOdAdapterSql({ grouping: name }));
    const groups = name ? (await this.db.query<{ name: string; n: number }>(groupSizesSql(name))).map((g) => ({ name: String(g.name), n: Number(g.n) })) : [];
    const cs = await this.db.query<Record<string, unknown>>(odCentroidsSql());
    if (gen !== this.gen) return;
    this.set({
      grouping: name,
      groups,
      centroids: cs.map((r) => ({ id: String(r.id), name: String(r.name ?? ""), grp: String(r.grp), lon: r.lon === null ? null : Number(r.lon), lat: r.lat === null ? null : Number(r.lat) })),
    });
  }

  async selectGrouping(name: string | null): Promise<void> {
    if (!this.ready) return;
    const gen = this.gen;
    try {
      await this.applyGrouping(name, gen);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Build od_cell (once per run). Resolves when ready; concurrent callers share one build. */
  ensureCells(): Promise<void> {
    if (this.state.cellsReady) return Promise.resolve();
    if (!this.cellsPromise) {
      const gen = this.gen;
      this.cellsPromise = this.track((async () => {
        const t = this.now();
        await withLock(this.db, async () => {
          if (this.disposed || gen !== this.gen) return;
          await this.db.exec(buildOdCellSql());
        });
        if (this.disposed || gen !== this.gen) return;
        this.set({ cellsReady: true, timings: { ...this.state.timings, cells: Math.round(this.now() - t) } });
      })()).catch((e) => {
        this.cellsPromise = null;
        throw e;
      });
    }
    return this.cellsPromise;
  }

  /** Timed query (ms stored under timings["q:<label>"] when a label is given). */
  async q<T = Record<string, unknown>>(sql: string, label?: string): Promise<T[]> {
    const t = this.now();
    const rows = await this.db.query<T>(sql);
    if (label) this.state.timings[`q:${label}`] = Math.round(this.now() - t);
    return rows;
  }

  centroidName(id: string): string | undefined {
    return this.state.centroids.find((c) => c.id === id)?.name;
  }

  /**
   * Release everything this controller owns, and only that: registered files, its attached catalog (tables,
   * views incl. od_cell) or, for an OdDb without catalogs, the fixed-name relations. Waits for work in flight
   * first so nothing is dropped under a running build. Idempotent; never touches another controller's state.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    this.listeners.clear();
    await Promise.allSettled([...this.inflight]);
    await withLock(this.db, async () => {
      for (const f of this.registered) await this.db.dropFile(f).catch(() => {});
      this.registered = [];
      if (this.attached) {
        this.attached = false;
        if (this.db.detach) await this.db.detach(this.ns).catch(() => {});
        else await this.db.exec(dropOdStateSql()).catch(() => {});
      }
    });
    this.cellsPromise = null;
  }
}
