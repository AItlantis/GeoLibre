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
import type { ComparisonRun } from "./comparison.ts";
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
  dayProfileObsQuery,
  dayProfileSimQuery,
  type ProfileScope,
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
  /** Private raw-table prefix, e.g. "mcm_" / "mcm_". */
  prefix: string;
  fetchImpl?: typeof fetch;
}

export interface Counts {
  nSim: number;
  nObs: number;
}

export class DetController {
  private readonly deps: ControllerDeps;
  state: PanelState = initialState();
  rows: ValRow[] = [];
  aggs: DetAgg[] = [];
  geo: GeoIndex | null = null;
  geoNote: string | null = null;
  counts: Counts = { nSim: 0, nObs: 0 };
  /** Simulated detectors with flow and no eid, for the loaded run (excluded from validation). */
  unmatched: UnmatchedDet[] = [];
  hasObs = false;
  dayProfiles: Record<ProfileScope, { observed: Array<{ minute: number; value: number }>; simulated: Array<{ value: number; startMin: number; endMin: number }> }> = { mean: { observed: [], simulated: [] }, sum: { observed: [], simulated: [] }, detector: { observed: [], simulated: [] } };
  index: PackageIndex | null = null;
  packageUrl: string | null = null;
  private req = 0;
  private dayProfileReq = 0;
  private dayProfileBaseKey: string | null = null;
  private dayProfileSelectedId: string | null = null;
  private tablesLoaded = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private comparisonKey: string | null = null;
  private comparisonCached = false;
  private comparisonRunsCache: ComparisonRun[] = [];
  private comparisonLoad: Promise<ComparisonRun[]> | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  dispatch(a: Action): void {
    const prev = this.state;
    this.state = reduce(this.state, a);
    if (a.type === "set-criteria" && this.state.criteria !== prev.criteria) this.aggs = aggregateDetectors(this.rows, this.state.criteria);
    this.notify();
  }

  /** Whether the current run has detector geometry loaded. */
  get hasGeo(): boolean {
    return this.geo !== null && this.geo.count > 0;
  }

  /** Resolves true only when the package finished loading (state is "ready"); false on any failure (see `state.error`). */
  async loadUrl(input: string, preferredRun?: string): Promise<boolean> {
    this.dispatch({ type: "package-loading" });
    try {
      const idx = await indexFromManifestUrl(input, this.deps.fetchImpl);
      this.packageUrl = input;
      await this.openIndex(idx, preferredRun);
    } catch (e) {
      this.fail(e);
    }
    return this.state.phase === "ready";
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
      const extra = idx.incomplete.length ? ` Packages without usable simulation data: ${idx.incomplete.join(", ")}.` : "";
      throw new Error(`No available detector view. Counts needs detectors_sim.parquet; Validation needs detectors_sim.parquet and detectors_obs.parquet.${extra}`);
    }
    this.comparisonKey = null;
    this.comparisonCached = false;
    this.comparisonRunsCache = [];
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

  /** Load each package run only when Comparison is first opened; retain compact numeric snapshots. */
  async loadComparisonRuns(): Promise<ComparisonRun[]> {
    if (!this.index) return [];
    const key = [this.packageUrl ?? this.index.label, this.state.obsSource, this.state.bucket].join("|");
    if (this.comparisonKey === key && this.comparisonCached) return this.comparisonRunsCache;
    if (this.comparisonLoad) return this.comparisonLoad;
    this.comparisonLoad = (async () => {
      const originalState = this.state;
      const original = originalState.run;
      const snapshots: ComparisonRun[] = [];
      try {
        for (const entry of this.index!.runs) {
          await this.selectRun(entry.run);
          if (this.state.phase === "error") throw new Error(this.state.error ?? `could not load ${entry.run}`);
          if (!this.hasObs || this.state.phase !== "ready") continue;
          snapshots.push({ run: entry.run,
            rows: this.rows.map((r) => ({ obs_flow_h: r.obs_flow_h, sim_flow_h: r.sim_flow_h, geh: r.geh })),
            detectors: this.aggs.map((a) => ({ id: a.id, geh: a.geh, oid: a.oid })),
            geo: this.geo,
            startMin: this.state.fromMin, endMin: this.state.toMin,
          });
        }
      } finally {
        if (original) {
          await this.selectRun(original);
          if (this.state.bucketOptions.includes(originalState.bucket)) this.state = { ...this.state, bucket: originalState.bucket };
          const [fromMin, toMin] = [originalState.fromMin, originalState.toMin];
          this.state = { ...this.state, fromMin, toMin, colorMode: originalState.colorMode, selectedId: null };
          await this.refresh();
          if (originalState.selectedId && this.aggs.some((a) => a.id === originalState.selectedId)) this.select(originalState.selectedId);
          this.notify();
        }
      }
      this.comparisonKey = key;
      this.comparisonRunsCache = snapshots;
      this.comparisonCached = true;
      return snapshots;
    })().finally(() => { this.comparisonLoad = null; });
    return this.comparisonLoad;
  }

  async selectComparisonDetector(run: string, id: string): Promise<void> {
    if (this.state.run !== run) await this.selectRun(run);
    if (this.aggs.some((a) => a.id === id)) this.select(id);
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
      const [sim, obs] = await Promise.all([e.sim.read(), e.obs?.read()]);
      this.hasObs = Boolean(e.obs);
      this.dayProfileBaseKey = null;
      this.dayProfileSelectedId = null;
      if (my !== this.req) return;
      await withLock(async () => {
        if (this.disposed) return;
        this.tablesLoaded = true; // set first so a failed load is still cleaned up by dispose
        try {
          await registerTable(db as DuckDbHandle, t.sim, e.sim.path, sim, "parquet");
          if (e.obs && obs) await registerTable(db as DuckDbHandle, t.obs, e.obs.path, obs, "parquet");
          else await db.exec(`CREATE OR REPLACE TABLE ${t.obs} (detector_id VARCHAR, ts TIMESTAMP, flow DOUBLE, source_file VARCHAR);`);
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
      this.aggs = this.hasObs ? aggregateDetectors(this.rows, this.state.criteria) : await withLock(async () => {
        const rows = await db.query<{ detector_id: string; oid: string | number | null; sim_flow_h: number }>(
          `SELECT CAST(eid AS VARCHAR) detector_id, any_value(oid) oid, avg(flow) sim_flow_h FROM v_sim_norm WHERE eid IS NOT NULL AND trim(CAST(eid AS VARCHAR)) <> '' GROUP BY eid ORDER BY eid`,
        );
        return rows.map((r) => ({ id: String(r.detector_id), oid: r.oid == null ? null : String(r.oid), buckets: 1, sim: Number(r.sim_flow_h), obs: 0, diff: 0, relErr: null, geh: 0, status: "pass" as const }));
      });
      this.counts = { nSim: out.nSim, nObs: out.nObs };
      await this.loadDayProfiles(this.state.selectedId);
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
    void this.loadDayProfiles(id);
  }

  private async loadDayProfiles(selectedId: string | null): Promise<void> {
    const profileReq = ++this.dayProfileReq;
    const profileState = this.state;
    const profileHasObs = this.hasObs;
    const profileKey = [profileState.sourceLabel ?? "", this.packageUrl ?? "", profileState.run ?? "", profileState.obsSource, String(profileHasObs)].join("|");
    const refreshBase = profileKey !== this.dayProfileBaseKey;
    const refreshSelected = refreshBase || selectedId !== this.dayProfileSelectedId;
    if (!refreshBase && !refreshSelected) return;
    try {
      const db = await this.deps.getDb();
      const profiles = await withLock(async () => {
        await db.exec(detViewScript({ prefix: this.deps.prefix, obsSource: profileState.obsSource, bucketMinutes: profileState.bucket }));
        const out = { ...this.dayProfiles };
        if (refreshBase) {
          for (const scope of ["mean", "sum"] as const) {
            const obs = profileHasObs ? await db.query<{ profile_minute: number; profile_value: number }>(dayProfileObsQuery(scope)) : [];
            const sim = await db.query<{ interval_start_s: number; duration_s: number; profile_value: number }>(dayProfileSimQuery(scope, undefined, profileHasObs));
            out[scope] = { observed: obs.map((r) => ({ minute: Number(r.profile_minute), value: Number(r.profile_value) })), simulated: sim.map((r) => ({ value: Number(r.profile_value), startMin: Number(r.interval_start_s) / 60, endMin: (Number(r.interval_start_s) + Number(r.duration_s)) / 60 })) };
          }
        }
        if (refreshSelected && selectedId) {
          const obs = profileHasObs ? await db.query<{ profile_minute: number; profile_value: number }>(dayProfileObsQuery("detector", selectedId)) : [];
          const sim = await db.query<{ interval_start_s: number; duration_s: number; profile_value: number }>(dayProfileSimQuery("detector", selectedId));
          out.detector = { observed: obs.map((r) => ({ minute: Number(r.profile_minute), value: Number(r.profile_value) })), simulated: sim.map((r) => ({ value: Number(r.profile_value), startMin: Number(r.interval_start_s) / 60, endMin: (Number(r.interval_start_s) + Number(r.duration_s)) / 60 })) };
        } else if (refreshSelected) out.detector = { observed: [], simulated: [] };
        return out;
      });
      if (profileReq !== this.dayProfileReq || this.disposed) return;
      this.dayProfiles = profiles;
      this.dayProfileBaseKey = profileKey;
      this.dayProfileSelectedId = selectedId;
      this.notify();
    } catch { /* supplementary profile; table remains usable if its query fails */ }
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


