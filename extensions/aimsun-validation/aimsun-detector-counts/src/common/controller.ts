/**
 * Data controller shared by both detector plugins: package loading, one run's tables in DuckDB,
 * and the window query over the shared views. UI-free so it can run under node:test.
 *
 * DuckDB is one instance for ALL Aimsun plugins and the shared views (v_sim_norm, v_obs_norm,
 * v_det_validation) have fixed names with baked-in parameters. Two panels with different
 * bucket / observed-source settings would clobber each other, so every query re-creates the
 * views and runs inside a process-wide lock (a Symbol.for global shared by all plugin bundles).
 * Raw tables are private per plugin (`prefix`).
 */
import type { DuckDbHandle } from "../../../_shared/src/duckdb.ts";
import { withDuckDbLock } from "../../../_shared/src/lock.ts";
import { registerTable } from "../../../_shared/src/package.ts";
import { aggregateDetectors, type DetAgg, type ValRow } from "./aggregate.ts";
import { parseDetectorGeo, type GeoIndex } from "./geo.ts";
import {
  indexFromFiles,
  indexFromManifestUrl,
  type FileLikeItem,
  type PackageIndex,
  type RunEntry,
} from "./package-source.ts";
import { initialState, reduce, type Action, type PanelState } from "./state.ts";
import {
  PROBE_OBS_SQL,
  PROBE_SIM_SQL,
  DET_VIEWS,
  unmatchedSimSql,
  bucketOptions,
  detViewScript,
  rawTableNames,
  windowQuery,
  type ObsSource,
} from "./sql.ts";

export type DbLike = Pick<DuckDbHandle, "query" | "exec" | "registerBuffer" | "dropFile">;

/** Serialise DuckDB view use across every plugin bundle in the page (shared mutex, aliases the old det lock). */
export const withLock = withDuckDbLock;

/** A simulated detector with flow but no external id: it cannot be matched to observed data. */
export interface UnmatchedDet {
  oid: string;
  flow: number;
}

export interface ControllerDeps {
  getDb: () => Promise<DbLike>;
  /** Private raw-table prefix, e.g. "dc_" / "dv_". */
  prefix: string;
  fetchImpl?: typeof fetch;
}

export interface Counts {
  nSim: number;
  nObs: number;
}

export class DetController {
  state: PanelState = initialState();
  rows: ValRow[] = [];
  aggs: DetAgg[] = [];
  geo: GeoIndex | null = null;
  geoNote: string | null = null;
  counts: Counts = { nSim: 0, nObs: 0 };
  /** Simulated detectors with flow and no eid, for the loaded run (excluded from validation). */
  unmatched: UnmatchedDet[] = [];
  index: PackageIndex | null = null;
  packageUrl: string | null = null;
  private req = 0;
  private tablesLoaded = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ControllerDeps) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  dispatch(a: Action): void {
    this.state = reduce(this.state, a);
    this.notify();
  }

  /** Whether the current run has detector geometry loaded. */
  get hasGeo(): boolean {
    return this.geo !== null && this.geo.count > 0;
  }

  async loadUrl(input: string, preferredRun?: string): Promise<void> {
    this.dispatch({ type: "package-loading" });
    try {
      const idx = await indexFromManifestUrl(input, this.deps.fetchImpl);
      this.packageUrl = input;
      await this.openIndex(idx, preferredRun);
    } catch (e) {
      this.fail(e);
    }
  }

  async loadFiles(files: readonly FileLikeItem[], label = "folder"): Promise<void> {
    this.dispatch({ type: "package-loading" });
    try {
      this.packageUrl = null;
      await this.openIndex(indexFromFiles(label, files));
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }

  private async openIndex(idx: PackageIndex, preferredRun?: string): Promise<void> {
    if (!idx.runs.length) {
      const extra = idx.incomplete.length ? ` Incomplete runs (need detectors_sim.parquet and detectors_obs.parquet): ${idx.incomplete.join(", ")}.` : "";
      throw new Error(`No run with detectors_sim.parquet and detectors_obs.parquet found.${extra}`);
    }
    this.index = idx;
    const names = idx.runs.map((r) => r.run);
    const run = preferredRun && names.includes(preferredRun) ? preferredRun : names[0];
    this.dispatch({ type: "package-loaded", label: idx.label, runs: names, run });
    await this.loadRun(run);
  }

  async selectRun(run: string): Promise<void> {
    if (!this.index) return;
    this.dispatch({ type: "run-selected", run });
    await this.loadRun(run);
  }

  private entry(run: string): RunEntry {
    const e = this.index?.runs.find((r) => r.run === run);
    if (!e) throw new Error(`run '${run}' is not in the package`);
    return e;
  }

  private async loadRun(run: string): Promise<void> {
    const my = ++this.req;
    try {
      const db = await this.deps.getDb();
      const e = this.entry(run);
      const t = rawTableNames(this.deps.prefix);
      const [sim, obs] = await Promise.all([e.sim.read(), e.obs.read()]);
      if (my !== this.req) return;
      await withLock(async () => {
        if (this.disposed) return;
        this.tablesLoaded = true; // set first so a failed load is still cleaned up by dispose
        try {
          await registerTable(db as DuckDbHandle, t.sim, e.sim.path, sim, "parquet");
          await registerTable(db as DuckDbHandle, t.obs, e.obs.path, obs, "parquet");
        } catch (err) {
          // registerTable drops its virtual file only on success
          for (const n of [t.sim, t.obs]) await db.dropFile(`pkg_${n}.parquet`).catch(() => undefined);
          throw err;
        }
      });
      if (this.disposed || my !== this.req) return;
      this.unmatched = await withLock(async () =>
        (await db.query<{ oid: string; flow: number }>(unmatchedSimSql(this.deps.prefix))).map((r) => ({ oid: String(r.oid), flow: Number(r.flow) })),
      );
      this.geo = null;
      this.geoNote = null;
      if (e.geo) {
        try {
          const g = parseDetectorGeo(JSON.parse(new TextDecoder().decode(await e.geo.read())));
          this.geo = g.count > 0 ? g : null;
          if (!this.geo) this.geoNote = "geometry file has no usable points";
        } catch (err) {
          this.geoNote = `geometry unreadable: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // probe the simulated grid with the default bucket to derive window + bucket options
      const probe = await withLock(async () => {
        await db.exec(detViewScript({ prefix: this.deps.prefix, obsSource: this.state.obsSource, bucketMinutes: 60 }));
        return (await db.query<{ start_min: number | null; end_min: number | null; dur_min: number | null }>(PROBE_SIM_SQL))[0];
      });
      if (my !== this.req) return;
      const start = Number(probe?.start_min ?? 0);
      const end = Number(probe?.end_min ?? 1440);
      const dur = Number(probe?.dur_min ?? 60);
      const opts = bucketOptions(dur, start, end);
      this.dispatch({
        type: "probe-ready",
        fromMin: start,
        toMin: Math.min(1440, Math.max(end, start + 1)),
        bucket: opts.includes(60) ? 60 : opts[0],
        bucketOptions: opts,
      });
      await this.refresh();
    } catch (err) {
      if (my === this.req) this.fail(err);
    }
  }

  /** Re-run the window query for the current state. Latest call wins. */
  async refresh(): Promise<void> {
    const my = ++this.req;
    try {
      const db = await this.deps.getDb();
      const s = this.state;
      const out = await withLock(async () => {
        await db.exec(detViewScript({ prefix: this.deps.prefix, obsSource: s.obsSource, bucketMinutes: s.bucket }));
        const rows = await db.query<ValRow>(windowQuery(s.fromMin, s.toMin));
        const ns = (await db.query<{ n_sim: number }>(PROBE_SIM_SQL))[0];
        const no = (await db.query<{ n_obs: number }>(PROBE_OBS_SQL))[0];
        return { rows, nSim: Number(ns?.n_sim ?? 0), nObs: Number(no?.n_obs ?? 0) };
      });
      if (my !== this.req) return;
      this.rows = out.rows.map((r) => ({
        ...r,
        bucket_start_min: Number(r.bucket_start_min),
        sim_flow_h: Number(r.sim_flow_h),
        obs_flow_h: Number(r.obs_flow_h),
        geh: Number(r.geh),
      }));
      this.aggs = aggregateDetectors(this.rows);
      this.counts = { nSim: out.nSim, nObs: out.nObs };
      if (this.state.selectedId && !this.aggs.some((a) => a.id === this.state.selectedId)) {
        this.state = { ...this.state, selectedId: null };
      }
      this.dispatch({ type: "busy", busy: false });
    } catch (err) {
      if (my === this.req) this.fail(err);
    }
  }

  setObsSource(value: ObsSource): void {
    this.dispatch({ type: "set-obs-source", value });
    void this.refresh();
  }

  setWindow(fromMin: number, toMin: number): void {
    this.dispatch({ type: "set-window", fromMin, toMin });
    void this.refresh();
  }

  setBucket(bucket: number): void {
    this.dispatch({ type: "set-bucket", bucket });
    void this.refresh();
  }

  select(id: string | null): void {
    this.dispatch({ type: "select-detector", id });
  }

  /**
   * Drop this plugin's raw tables and the det views (they bind those tables; every consumer
   * re-creates them before each query), and detach all listeners. Idempotent.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.req++;
    this.listeners.clear();
    if (!this.tablesLoaded) return;
    this.tablesLoaded = false;
    try {
      const db = await this.deps.getDb();
      const t = rawTableNames(this.deps.prefix);
      await withLock(async () => {
        await db.exec(DET_VIEWS.map((v) => `DROP VIEW IF EXISTS ${v};`).join(" "));
        await db.exec(`DROP TABLE IF EXISTS ${t.sim}; DROP TABLE IF EXISTS ${t.obs};`);
        for (const n of [t.sim, t.obs]) await db.dropFile(`pkg_${n}.parquet`).catch(() => undefined);
      });
    } catch {
      /* DuckDB may not have been started */
    }
  }
}
