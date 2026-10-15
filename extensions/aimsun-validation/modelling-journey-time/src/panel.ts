/**
 * Observed subpath journey time panel: package picker, route/direction picker, source toggle,
 * time-of-day profile (mean / median / min-max band across days), name-matching report and a map
 * overlay coloured by the selected 15-min bucket. Observed data only (no simulated JT exists).
 */
import type { DuckDbHandle } from "../../_shared/src/duckdb";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql";
import { barSvg, groupedBarSvg, histogramSvg, mountChart, scatterSvg, stackedBarSvg, STATUS_COLORS } from "../../_shared/src/charts";
import { geometryPositions, RunFitter } from "../../_shared/src/fit-extent";
import type { GeoJSONFC, HostApp } from "./host";
import type { Translator } from "./i18n";
import { lineSvg } from "./lineSvg";
import { buildMatching, PREFERRED_GROUP, pairKey, type MatchReason, type MatchResult, type ObsPair } from "./match";
import { MapOverlay } from "./overlay";
import { SectionOverlay } from "./sectionOverlay";
import {
  aggregates, divergingColour, DIVERGING_GRADIENT, EMPTY_PERIOD_INFO, matchPeriod, obsPointsOf, periodAvailability, resolvePeriodConfig, routeRowsFromPairs, toValidationPairs,
  clock, type PeriodResult,
} from "./period";
import {
  sectionFeatures, sectionGeometry, sectionValuesAt, slowestSections, speedGradient, speedScale, toSecRows, type SecRow,
} from "./sections";
import { cursorToBucketMin, JT_BUCKET_MIN, JT_BUCKET_S, journeyHostInfo, journeyPeriod, windowToMinutes } from "./hostView";
import { isFiniteWindow, type HostInfoCallback, type HostTimeWindow } from "../../_shared/src/host-time";
import { loadFromFiles, loadFromManifestUrl, subpathRefs, type PackageSummary } from "./pkg";
import {
  bucketLabel,
  colourScale,
  comparisonMode,
  featuresBounds,
  overlayFeatures,
  profileOf,
  toObsRows,
  valuesAtBucket,
  type ColourBy,
  type ObsRow,
  type Stat,
} from "./profile";
import { openSession, type Session } from "./session";
import { banner, clear, el, fmt, packageBar, type PackageBar } from "./ui";
import { buildSimSql, classifyTsType, missingSimColumns, type TsKind } from "./simtable";
import { DEFAULT_CRITERIA, joinComparison, journeyTimeBands, kpis, pairObsSim, perRoute, validateCriteria, type Criteria, type PairingResult, type SimRow, type Window } from "./validation";
import { packageUiPlan } from "../../_shared/src/host-managed";

export const PLUGIN_ID = "modelling-journey-time";
const BUCKET = JT_BUCKET_MIN;
/** |signed error| (%) at which the diverging map ramp saturates. */
const ERROR_CAP = 50;
const VIEW_JT = "journey-time";
const VIEW_VALIDATION = "validation";
const VIEW_COMPARISON = "comparison";

export interface SavedState {
  run: string | null;
  source: string;
  stat: Stat;
  bucket: number;
  window: Window | null;
  selectedRoute: string;
  viewMode: string;
  manifestUrl: string;
  criteria?: Criteria;
  comparisonA?: string;
  comparisonB?: string;
}

const SOURCE_LABELS: Record<string, [string, string]> = {
  monthly_15min: ["source.monthly", "Monthly, 15-min"],
  subnetwork_may2025: ["source.subnetwork", "Subnetwork, May 2025"],
};

interface SourceInfo {
  source: string;
  /** Time-only typical-day observations (dateKind 'typical'): no real date range to show. */
  typical?: boolean;
  days: number;
  first: string;
  last: string;
}

export interface Deps {
  getApp: () => HostApp | null;
  getDuck: () => Promise<DuckDbHandle>;
  t: Translator;
  initial?: SavedState | null;
}

export class JourneyTimeController {
  private session: Session | null = null;
  private disposed = false;
  private pkg: PackageSummary | null = null;
  private rows: ObsRow[] = [];
  private simRows: SimRow[] = [];
  private sources: SourceInfo[] = [];
  private source = "";
  private routeKey = "";
  private stat: Stat = "mean";
  private bucket = 480;
  private bucketMin = 15;
  private win: Window | null = null;
  private winTouched = false;
  private criteria: Criteria = { ...DEFAULT_CRITERIA, bandEdges: [...DEFAULT_CRITERIA.bandEdges] };
  private comparisonA = "";
  private comparisonB = "";
  private topN = 10;
  private selected = "";
  private viewMode = VIEW_JT;
  private tsKind: TsKind | null = null;
  private colourBy: ColourBy = "seconds";
  private geo: GeoJSONFC | null = null;
  private match: MatchResult | null = null;
  private busy = false;
  private error: string | null = null;
  private status = "";
  private overlayNote = "";
  // C11 / C12
  private periodRun = "";
  private cmpColour: "status" | "error" = "status";
  private secRows: SecRow[] = [];
  // host-managed time (C15): window + cursor pushed by the host, info reported back
  private hostWin: HostTimeWindow | null = null;
  private hostGeneration = 0;
  private hostInfoCb: HostInfoCallback | null = null;
  private lastInfoKey = "";
  private readonly sectionOverlay: SectionOverlay;
  private fitter: RunFitter | null = null;
  private readonly overlay: MapOverlay;
  // DOM
  private root: HTMLElement | null = null;
  private bar: PackageBar | null = null;
  private body: HTMLElement | null = null;
  private lastUrl = "";

  constructor(private readonly d: Deps) {
    this.overlay = new MapOverlay(d.getApp);
    this.sectionOverlay = new SectionOverlay(d.getApp);
    if (d.initial) this.applyState(d.initial);
  }

  static parseState(value: unknown): SavedState | null {
    if (!value || typeof value !== "object") return null;
    const s = value as Partial<SavedState>;
    const stat: Stat = s.stat === "median" ? "median" : "mean";
    const window = s.window && Number.isFinite(s.window.from) && Number.isFinite(s.window.to) && s.window.to > s.window.from
      ? { from: Math.max(0, Math.min(1439, s.window.from)), to: Math.max(1, Math.min(1440, s.window.to)) }
      : null;
    let criteria: Criteria = { ...DEFAULT_CRITERIA, bandEdges: [...DEFAULT_CRITERIA.bandEdges] };
    try { if (s.criteria) criteria = validateCriteria(s.criteria); } catch { /* discard invalid saved criteria and use defaults */ }
    return {
      run: typeof s.run === "string" ? s.run : null,
      source: typeof s.source === "string" ? s.source : "",
      stat,
      bucket: Number.isFinite(s.bucket) ? Math.max(0, Math.min(1425, Math.floor((s.bucket as number) / BUCKET) * BUCKET)) : 480,
      window,
      selectedRoute: typeof s.selectedRoute === "string" ? s.selectedRoute : "",
      viewMode: [VIEW_VALIDATION, VIEW_COMPARISON].includes(s.viewMode ?? "") ? s.viewMode! : VIEW_JT,
      manifestUrl: typeof s.manifestUrl === "string" ? s.manifestUrl : "",
      criteria,
      comparisonA: typeof s.comparisonA === "string" ? s.comparisonA : "",
      comparisonB: typeof s.comparisonB === "string" ? s.comparisonB : "",
    };
  }

  getState(): SavedState {
    return { run: this.pkg?.run ?? null, source: this.source, stat: this.stat, bucket: this.bucket, window: this.win, selectedRoute: this.viewMode === VIEW_VALIDATION || this.viewMode === VIEW_COMPARISON ? this.selected : this.routeKey, viewMode: this.viewMode, manifestUrl: this.lastUrl, criteria: this.criteria, comparisonA: this.comparisonA, comparisonB: this.comparisonB };
  }

  applyState(state: SavedState | null): void {
    if (!state) return;
    this.source = state.source;
    this.stat = state.stat;
    this.bucket = state.bucket;
    this.win = state.window;
    this.winTouched = !!state.window;
    this.routeKey = state.selectedRoute;
    this.selected = state.selectedRoute;
    this.viewMode = state.viewMode;
    this.lastUrl = state.manifestUrl;
    this.criteria = state.criteria ? validateCriteria(state.criteria) : this.criteria;
    this.comparisonA = state.comparisonA ?? "";
    this.comparisonB = state.comparisonB ?? "";
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  mount(container: HTMLElement): () => void {
    this.root = el("div", { class: "avp-root", "data-avp-plugin": PLUGIN_ID });
    container.append(this.root);
    this.build();
    return () => this.unmount();
  }

  private unmount(): void {
    this.root?.remove();
    this.root = this.bar = this.body = null;
  }

  /** True while the Testudo host owns package/run selection (set by the plugin, cleared on deactivate). */
  hostManaged = false;

  setHostManaged(on: boolean): void {
    if (this.hostManaged === on) return;
    this.hostManaged = on;
    this.build();
  }

  /** Rebuild the whole panel (first mount, language change). */
  build(): void {
    if (!this.root) return;
    const { t } = this.d;
    clear(this.root);
    this.bar = packageBar({
      t,
      hint: t("pkg.hint", "Pick the package folder (or its files), or paste a manifest URL. Also: ?aimsunPackage=<manifest url>."),
      onUrl: (u) => void this.loadUrl(u),
      onFiles: (f) => void this.loadFiles(f),
    });
    if (this.lastUrl) this.bar.setUrl(this.lastUrl);
    this.body = el("div", { class: "avp-body", "data-avp-state": this.stateName() });
    const ui = packageUiPlan(this.hostManaged);
    if (ui.showPackagePicker) this.root.append(this.bar.root);
    else if (!this.error && this.status) this.root.append(el("p", { class: "avp-hint", "data-avp": "status", role: "status", text: this.status }));
    this.root.append(this.body);
    this.bar.setStatus(this.status, this.error ? "error" : this.busy ? "busy" : "info");
    this.renderBody();
    this.emitHostInfo();
  }

  private removeOverlays(): void {
    this.overlay.remove();
    this.sectionOverlay.remove();
  }

  private stateName(): string {
    return this.error ? "error" : this.busy ? "loading" : this.pkg ? "ready" : "empty";
  }

  dispose(): void {
    this.removeOverlays();
    this.fitter?.dispose();
    this.fitter = null;
    this.disposed = true;
    void this.session?.dispose(); // drops this panel's tables/views, detaches its catalog, closes its connection
    this.session = null;
  }

  // ---- host-managed time (C15) -------------------------------------------------------------------
  /** Period the plugin can show for the active run (null for typical-day observed-only packages). */
  private currentPeriod(): ReturnType<typeof journeyPeriod> {
    if (!this.pkg) return null;
    return journeyPeriod(this.pkg.periodInfo ?? EMPTY_PERIOD_INFO, this.activeRun() ?? this.pkg.run ?? null, this.simRows);
  }

  /** Start (seconds) of the bucket the map shows: the host cursor's bucket (absolute, may exceed 24 h), else the slider bucket. */
  private cursorFromS(): number {
    return this.hostWin ? Math.floor(this.hostWin.cursor_s / JT_BUCKET_S) * JT_BUCKET_S : this.bucket * 60;
  }

  /** The host pushes window + cursor; the chart marker, route colours and section layer follow the cursor. */
  setTimeWindow(win: HostTimeWindow): void {
    if (this.disposed || !win || !isFiniteWindow(win)) return;
    const gen = (win as { generation?: unknown }).generation;
    if (typeof gen === "number" && Number.isFinite(gen)) this.hostGeneration = gen;
    this.hostWin = { from_s: win.from_s, to_s: win.to_s, cursor_s: win.cursor_s };
    const bucket = cursorToBucketMin(win.cursor_s);
    this.bucket = bucket;
    const m = windowToMinutes(win);
    const changedWindow = !!m && !this.isTypical() && (this.win?.from !== m.from || this.win?.to !== m.to);
    if (m && !this.isTypical()) { this.win = m; this.winTouched = true; }
    if (!this.pkg) return;
    if (changedWindow && this.viewMode !== VIEW_JT) { this.renderBody(); return; }
    if (this.viewMode !== VIEW_JT) return;
    const label = this.body?.querySelector<HTMLElement>('[data-avp="bucket-label"]');
    if (label) label.textContent = bucketLabel(this.bucket);
    const slider = this.body?.querySelector<HTMLInputElement>('[data-avp="bucket"]');
    if (slider) slider.value = String(this.bucket / BUCKET);
    this.updateChart();
    this.updateMap();
  }

  /** Callback through which the plugin reports its period / bucket / tab / busy state to the host (null detaches). */
  onHostInfo(cb: HostInfoCallback | null): void {
    this.hostInfoCb = cb;
    this.lastInfoKey = "";
    this.emitHostInfo();
  }

  private emitHostInfo(): void {
    const cb = this.hostInfoCb;
    if (!cb || this.disposed) return;
    const info = journeyHostInfo({ plugin: PLUGIN_ID, run: this.activeRun() ?? this.pkg?.run ?? null, generation: this.hostGeneration, period: this.currentPeriod(), mode: this.viewMode, busy: this.busy });
    const key = JSON.stringify(info);
    if (key === this.lastInfoKey) return;
    this.lastInfoKey = key;
    try { cb(info); } catch { /* a faulty host callback must not break the panel */ }
  }

  /** Host-driven run switch: selects one of the simulated runs already in the package. False when unknown or not host-managed. */
  async setRun(run: string): Promise<boolean> {
    if (!this.hostManaged || !this.pkg) return false;
    if (!this.runNames().includes(run)) return run === this.pkg.run;
    if (this.activeRun() !== run) {
      this.periodRun = run;
      this.build();
      this.updateMap();
    }
    return true;
  }

  // ---- loading ---------------------------------------------------------------------------------
  /** Resolves true only when the package finished loading; false on any failure (see `loadError`). */
  async loadUrl(url: string): Promise<boolean> {
    this.lastUrl = url;
    this.bar?.setUrl(url);
    return this.load((s) => loadFromManifestUrl(s, url));
  }

  get loadError(): string | null {
    return this.error;
  }

  async loadFiles(files: File[]): Promise<void> {
    await this.load((s) => loadFromFiles(s, files));
  }

  private async load(fn: (s: Session) => Promise<PackageSummary>): Promise<boolean> {
    const { t } = this.d;
    this.busy = true;
    this.error = null;
    this.status = t("status.loading", "Loading package...");
    this.build();
    try {
      this.removeOverlays();
      const h = await this.d.getDuck();
      if (this.disposed) return false;
      const opened = this.session ?? (await openSession(h, "modelling_journey_time"));
      if (this.disposed) {
        await opened.dispose(); // deactivated while the session was opening: nothing may outlive the plugin
        return false;
      }
      this.session = opened;
      const s = opened;
      const pkg = await fn(s);
      if (!pkg.hasObs) throw new Error(t("err.noObs", "This package is missing the required observed journey-time table subpath_obs_jt."));
      await s.exec(buildSubpathSql({ bucketMinutes: BUCKET, columns: pkg.obsColumns }));
      this.rows = toObsRows(await s.query("SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
      this.sources = (
        await s.query<{ source: string; nd: number; d0: string; d1: string }>(
          "SELECT source, COUNT(DISTINCT day) AS nd, CAST(MIN(day) AS VARCHAR) AS d0, CAST(MAX(day) AS VARCHAR) AS d1 FROM v_sp_obs_day GROUP BY source ORDER BY source",
        )
      ).map((r) => ({
        source: String(r.source), days: Number(r.nd), first: String(r.d0), last: String(r.d1),
        typical: this.rows.some((o) => o.source === String(r.source)) && this.rows.filter((o) => o.source === String(r.source)).every((o) => o.date_kind === "typical"),
      }));
      this.simRows = [];
      this.tsKind = null;
      if (pkg.hasSim) {
        const cols = await s.query<{ column_name: string; column_type: string }>("DESCRIBE subpath_sim_jt");
        const names = cols.map((c) => String(c.column_name));
        const missing = missingSimColumns(names);
        if (missing.length) throw new Error(t("err.simCols", "subpath_sim_jt is missing column(s): {{c}}. Expected route, direction_norm, seconds and either a segment (interval_start_s, duration_s) or ts_bucket.", { c: missing.join(", ") }));
        const segmented = names.some((n) => n.toLowerCase() === "interval_start_s") && names.some((n) => n.toLowerCase() === "duration_s");
        const kind = segmented ? null : classifyTsType(String(cols.find((c) => String(c.column_name).toLowerCase() === "ts_bucket")?.column_type ?? ""));
        if (!segmented && !kind) throw new Error(t("err.simTs", "subpath_sim_jt.ts_bucket has an unsupported type (use TIMESTAMP, TIME, 'HH:MM' text or numeric minutes since midnight)."));
        this.tsKind = kind;
        await s.exec(buildSimSql(this.bucketMin, kind ?? "numeric", names));
        this.simRows = (await s.query("SELECT route, direction_norm, bucket_start_min, interval_start_s, duration_s, sim_s, n, run FROM v_sp_sim ORDER BY 1, 2, 3, 8")).map((r) => ({
          route: String(r.route), direction_norm: String(r.direction_norm), bucket_start_min: Number(r.bucket_start_min), sim_s: Number(r.sim_s), n: Number(r.n),
          interval_start_s: Number(r.interval_start_s), duration_s: Number(r.duration_s), run: String(r.run ?? pkg.run ?? "Run"),
        }));
        if (!this.winTouched && this.simRows.length) {
          const bs = this.simRows.map((r) => r.bucket_start_min);
          this.win = { from: Math.min(...bs), to: Math.max(...bs) + this.bucketMin };
        }
      }
      this.secRows = [];
      if (pkg.hasSectionTt && pkg.sections) {
        const scols = (await s.query<{ column_name: string }>("DESCRIBE section_sim_tt")).map((c) => String(c.column_name).toLowerCase());
        const missingSec = ["subpath_oid", "seq", "interval_start_s", "duration_s"].filter((c) => !scols.includes(c));
        if (missingSec.length) pkg.notes.push(`section_sim_tt is missing column(s): ${missingSec.join(", ")}; per-section delay is not drawn.`);
        else {
          const pick = (c: string): string => (scols.includes(c) ? c : `NULL AS ${c}`);
          const where = scols.includes("valid") ? "WHERE valid IS NOT FALSE" : "";
          this.secRows = toSecRows(await s.query(`SELECT subpath_oid, seq, ${["section_id", "run", "ttime_s", "dtime_s", "speed_kmh", "flow"].map(pick).join(", ")}, interval_start_s, duration_s FROM section_sim_tt ${where}`));
        }
      }
      this.pkg = pkg;
      this.geo = pkg.geo;
      if (!this.sources.some((s) => s.source === this.source)) this.source = this.sources[0]?.source ?? "";
      if (!this.rows.some((r) => r.source === this.source && `${r.route}\u0000${r.direction_norm}` === this.routeKey)) this.routeKey = "";
      this.pickDefaults();
      if (this.viewMode === VIEW_VALIDATION && !this.simRows.length) this.viewMode = VIEW_JT;
      this.status = t("status.loaded", "Loaded {{n}} observed rows.", { n: this.rows.length });
      return true;
    } catch (e) {
      this.pkg = null;
      this.rows = [];
      this.error = e instanceof Error ? e.message : String(e);
      this.status = this.error;
      return false;
    } finally {
      this.busy = false;
      this.build();
      this.updateMap();
    }
  }

  private pairsOf(source: string): ObsPair[] {
    const seen = new Set<string>();
    const out: ObsPair[] = [];
    for (const r of this.rows) {
      if (r.source !== source) continue;
      const k = `${r.route}\u0000${r.direction_norm}\u0000${r.subpath_oid ?? ""}\u0000${r.source_id ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ route: r.route, direction: r.direction_norm, source, subpath_oid: r.subpath_oid ?? null, match_method: r.match_method ?? null, source_id: r.source_id ?? null });
    }
    return out;
  }

  /** Route default + matching for the current source. */
  private pickDefaults(): void {
    const pairs = this.pairsOf(this.source);
    if (!pairs.some((p) => `${p.route}\u0000${p.direction}` === this.routeKey)) {
      this.routeKey = pairs[0] ? `${pairs[0].route}\u0000${pairs[0].direction}` : "";
    }
    this.match = this.geo ? buildMatching(pairs, subpathRefs(this.geo)) : null;
    const buckets = this.rows.filter((r) => r.source === this.source).map((r) => r.bucket_start_min);
    if (!this.hostWin && buckets.length && !buckets.includes(this.bucket)) {
      this.bucket = buckets.reduce((best, b) => (Math.abs(b - 480) < Math.abs(best - 480) ? b : best), buckets[0]);
    }
  }

  // ---- rendering -------------------------------------------------------------------------------
  private renderBody(): void {
    const body = this.body;
    if (!body) return;
    const { t } = this.d;
    clear(body);
    body.dataset.avpState = this.stateName();
    if (this.error) body.append(banner("error", this.error));
    if (!this.pkg) {
      if (!this.error && !this.busy) body.append(banner("info", t("empty", "No package loaded yet.")));
      return;
    }
    const hasSimRows = this.simRows.length > 0;
    const cmp = this.compareInfo();
    const hasSim = hasSimRows && cmp.mode === "compare";
    const runs = [...new Set(this.simRows.map((r) => r.run).filter((r): r is string => !!r))];
    const typical = this.isTypical();
    const noSimReason = !hasSimRows
      ? (this.pkg?.simReason ?? t("nosim.reason", "no simulated subpath journey-time table (subpath_sim_jt) in this package"))
      : (cmp.reason ?? "");
    const validationOff = !hasSim ? t("nosim.short", "Validation and Comparison are disabled: observed profile only ({{why}}).", { why: noSimReason }) : "";
    const fewRuns = t("comparison.disabled", "Comparison is disabled: at least two runs with simulated journey time are required.");
    const comparisonOff = typical ? validationOff : runs.length < 2 ? fewRuns : validationOff;
    body.append(this.modeTabs([
      [VIEW_JT, t("view.jt", "Journey time"), ""],
      [VIEW_VALIDATION, t("view.validation", "Validation"), validationOff],
      [VIEW_COMPARISON, t("view.comparison", "Comparison"), comparisonOff],
    ]));
    const reasons: string[] = [];
    if (validationOff) reasons.push(validationOff);
    else if (!typical && runs.length < 2) reasons.push(fewRuns);
    if (this.viewMode === VIEW_VALIDATION && hasSim) {
      this.removeOverlays();
      this.renderValidation(body, reasons);
      return;
    }
    if (this.viewMode === VIEW_COMPARISON && hasSim && typical) {
      this.removeOverlays();
      this.renderPeriodComparison(body, reasons);
      return;
    }
    if (this.viewMode === VIEW_COMPARISON && hasSim && new Set(this.simRows.map((r) => r.run).filter(Boolean)).size > 1) {
      this.removeOverlays(); this.renderComparison(body); return;
    }

    // Observed source: a choice only when there is more than one; sources are never mixed.
    if (this.sources.length > 1) {
      const toggle = el("fieldset", { class: "avp-section", "data-avp": "source" }, el("legend", { class: "avp-h", text: t("source.title", "Observed source") }));
      for (const s of this.sources) {
        const radio = el("input", { type: "radio", name: "avp-source", value: s.source, checked: s.source === this.source });
        radio.addEventListener("change", () => {
          this.source = s.source;
          this.routeKey = "";
          this.pickDefaults();
          this.renderBody();
          this.updateMap();
        });
        toggle.append(el("label", { class: "avp-inline" }, radio, this.sourceText(s)));
      }
      body.append(toggle);
    } else if (this.sources[0]) {
      body.append(el("p", { class: "avp-small", "data-avp": "source" }, `${t("source.title", "Observed source")}: ${this.sourceText(this.sources[0])}`));
    }
    const unit = this.unitBanner();
    if (unit) body.append(unit);
    if (cmp.mode === "profile-only" && cmp.reason) reasons.push(t("profile.only", "Profile-only: {{why}}.", { why: cmp.reason ?? "" }));

    // Route picker
    const pairs = this.pairsOf(this.source);
    const matchedKeys = new Set(this.match?.matchedObs.map((m) => `${m.route}\u0000${m.direction}`));
    const sel = el("select", { class: "avp-select", "aria-label": t("route.title", "Route and direction"), "data-avp": "route" });
    const listed = new Set<string>();
    for (const p of pairs) {
      const k = `${p.route}\u0000${p.direction}`;
      if (listed.has(k)) continue;
      listed.add(k);
      const tag = this.match ? (matchedKeys.has(k) ? "" : ` (${t("route.nomodel", "no model subpath")})`) : "";
      const o = el("option", { value: k, text: `${p.route} - ${p.direction}${tag}` });
      o.selected = k === this.routeKey;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      this.routeKey = sel.value;
      this.updateChart();
      this.updateMap();
    });
    const statSel = el("select", { class: "avp-select", "aria-label": t("stat.title", "Statistic"), "data-avp": "stat" });
    for (const [v, k, def] of [["mean", "stat.mean", "Mean across days"], ["median", "stat.median", "Median across days"]] as const) {
      const o = el("option", { value: v, text: t(k, def) });
      o.selected = v === this.stat;
      statSel.append(o);
    }
    statSel.addEventListener("change", () => {
      this.stat = statSel.value as Stat;
      this.updateChart();
      this.updateMap();
    });
    body.append(
      el("section", { class: "avp-section", "data-avp": "profile" }, el("h3", { class: "avp-h", text: t("profile.title", "Journey time profile") }), el("div", { class: "avp-row" }, sel, statSel)),
    );
    const chart = el("div", { class: "avp-chart", "data-avp": "chart" });
    const readout = el("p", { class: "avp-small", "data-avp": "readout" });
    body.lastElementChild!.append(chart, readout);

    // Map controls + legends (the time cursor comes from the host; standalone keeps a minimal slider)
    if (!this.geo) reasons.push(t("map.degraded", "Chart-only mode: this package has no subpath geometry (subpaths.geojson), so there is no map layer and no name matching."));
    else body.append(this.mapSection());
    body.append(this.detailsSection(reasons));
    this.updateChart();
  }

  /** Tab strip shared in look with Counts (same markup and classes); a disabled tab keeps its reason as title. */
  private modeTabs(tabs: ReadonlyArray<readonly [string, string, string]>): HTMLElement {
    const { t } = this.d;
    const strip = el("div", { class: "av-tabs", attrs: { role: "tablist", "aria-label": t("view.title", "View mode"), "data-avp": "view-mode", "data-testid": "view-mode" } });
    for (const [id, label, off] of tabs) {
      const b = el("button", { class: `av-tab${this.viewMode === id ? " av-tab-active" : ""}`, text: label, attrs: { type: "button", role: "tab", "aria-selected": String(this.viewMode === id), "data-mode": id } });
      if (off) { b.disabled = true; b.title = off; b.dataset.reason = off; }
      b.addEventListener("click", () => {
        if (b.disabled || this.viewMode === id) return;
        this.viewMode = id;
        if (this.viewMode !== VIEW_JT) this.removeOverlays();
        this.build();
        this.updateMap();
      });
      strip.append(b);
    }
    return strip;
  }

  private sourceText(s: SourceInfo): string {
    const { t } = this.d;
    const [k, def] = SOURCE_LABELS[s.source] ?? [`source.${s.source}`, s.source];
    return s.typical
      ? `${t(k, def)} (${t("source.typical", "typical day, time-only observations (no real date)")})`
      : `${t(k, def)} (${t("source.days", "{{n}} days", { n: s.days })}, ${s.first} - ${s.last})`;
  }

  /** Only when the unit is really unverified (the monthly file); otherwise nothing: the chart axis already says seconds. */
  private unitBanner(): HTMLElement | null {
    const { t } = this.d;
    if (this.source !== "monthly_15min") return null;
    return banner(
      "warn",
      t(
        "unit.monthly",
        "Unit unverified: the monthly file's Avg_traveltime column states no unit. Values are shown as seconds because their magnitude fits seconds (Al Ain Road median ~64 vs 84-86 s typical duration in the subnetwork file, still ~25% apart), not because the source says so. Confirm with the data owner.",
      ),
      { "data-avp": "unit-warning" },
    );
  }

  /** True when the plugin must offer its own time slider: standalone, or host-managed without a period to drive it. */
  private needsSlider(): boolean {
    return !this.hostManaged || this.currentPeriod() === null;
  }

  private mapSection(): HTMLElement {
    const { t } = this.d;
    const sec = el("section", { class: "avp-section", "data-avp": "map" });
    if (this.needsSlider()) {
      const slider = el("input", { type: "range", class: "avp-range", min: 0, max: 1440 / BUCKET - 1, step: 1, value: this.bucket / BUCKET, "aria-label": t("map.bucket", "Time bucket"), "data-avp": "bucket" });
      const label = el("b", { "data-avp": "bucket-label", text: bucketLabel(this.bucket) });
      slider.addEventListener("input", () => {
        this.bucket = Number(slider.value) * BUCKET;
        label.textContent = bucketLabel(this.bucket);
        this.updateChart();
        this.updateMap();
      });
      sec.append(el("div", { class: "avp-row" }, el("span", { text: t("map.time", "Time") }), label, slider));
    }
    const col = el("select", { class: "avp-select", "aria-label": t("map.colourBy", "Colour by"), "data-avp": "colour-by" });
    for (const [v, k, def] of [["seconds", "map.seconds", "Journey time (s)"], ["ratio", "map.ratio", "Ratio to the route's own day median"]] as const) {
      const o = el("option", { value: v, text: t(k, def) });
      o.selected = v === this.colourBy;
      col.append(o);
    }
    col.addEventListener("change", () => {
      this.colourBy = col.value as ColourBy;
      this.updateMap();
    });
    sec.append(
      el("div", { class: "avp-row" }, col),
      el("div", { class: "avp-legend", "data-avp": "legend" }, el("span", { "data-avp": "legend-min" }), el("div", { class: "avp-ramp" }), el("span", { "data-avp": "legend-max" })),
    );
    const secUi = this.sectionControls();
    if (secUi) sec.append(secUi);
    return sec;
  }

  /** The ONE collapsed disclosure of a view: reasons, rules, drawn-overlay notes and the name-matching report. */
  private detailsBlock(notes: readonly string[], extra: ReadonlyArray<HTMLElement | null> = []): HTMLDetailsElement {
    const { t } = this.d;
    const det = el("details", { class: "avp-details avp-section", "data-avp": "matching" });
    det.append(el("summary", { "data-avp": "match-summary", text: t("details.title", "Details") }));
    for (const n of notes) if (n) det.append(el("p", { class: "avp-hint", text: n }));
    for (const x of extra) if (x) det.append(x);
    return det;
  }

  private detailsSection(reasons: readonly string[]): HTMLElement {
    const { t } = this.d;
    const notes = [...reasons, t("source.never", "Sources are never mixed: every number below comes from the selected source only.")];
    const note = el("p", { class: "avp-hint", "data-avp": "overlay-note" });
    note.textContent = this.overlayNote;
    const det = this.detailsBlock(notes, [note, this.sectionsReason()]);
    this.appendMatching(det);
    return det;
  }

  private appendMatching(det: HTMLElement): void {
    const { t } = this.d;
    const m = this.match;
    if (!m) {
      det.append(el("p", { class: "avp-hint", text: t("match.none", "Name matching needs subpath geometry (names) in the package.") }));
      return;
    }
    const c = m.counts;
    det.dataset.obsMatched = String(c.obsMatched);
    det.dataset.obsTotal = String(c.obsTotal);
    det.dataset.subpathsMatched = String(c.subpathsMatched);
    det.dataset.subpathsTotal = String(c.subpathsTotal);
    det.dataset.subpathsUnmatched = String(c.subpathsUnmatched);
    det.dataset.subpathsDropped = String(c.subpathsDroppedDuplicate);
    det.append(
      el("p", {
        class: "avp-hint",
        text: t("match.summary", "Name matching: {{om}} of {{ot}} observed routes matched; {{sm}} of {{st}} model subpaths matched ({{sn}} not in this scenario, {{sd}} duplicates dropped)", {
          om: c.obsMatched, ot: c.obsTotal, sm: c.subpathsMatched, st: c.subpathsTotal, sn: c.subpathsNotInScenario, sd: c.subpathsDroppedDuplicate,
        }),
      }),
      el("p", { class: "avp-hint", text: t("match.rules0", "Order: a verified subpath_oid wins; then an exact full-name match; then the name + direction rules below. NB and SB are their own directions and are never equated with IB/OB.") }),
      el("p", { class: "avp-hint", text: t("match.rules", "Rules: trim/collapse spaces and lower-case; In -> IB, Out -> OB; strip a _IB/_OB/_In/_Out/_EW/_WE suffix from the subpath name; match on base name + direction. If one key matches subpaths in several groups, only the group '{{g}}' is used and the others are listed as dropped duplicates. Nothing else is guessed.", { g: PREFERRED_GROUP }) }),
    );
    const mk = (headers: string[], rows: string[][], attr: string) => {
      const tb = el("table", { class: "avp-table", "data-avp": attr }, el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { text: h })))));
      const tbody = el("tbody");
      for (const r of rows) tbody.append(el("tr", {}, ...r.map((x) => el("td", { text: x }))));
      tb.append(tbody);
      return el("div", { class: "avp-table-wrap" }, tb);
    };
    det.append(
      el("h4", { class: "avp-h", text: t("match.matched", "Matched") }),
      mk(
        [t("col.route", "Route"), t("col.dir", "Dir"), t("col.subpaths", "Model subpaths"), t("col.via", "Rule"), t("col.dropped", "Duplicates dropped (other groups)")],
        m.matchedObs.map((r) => [
          r.route,
          r.direction || "-",
          r.matches.map((x) => `${x.subpath.name} [${x.subpath.group ?? "-"}]`).join("; "),
          r.matches[0].via + (r.dropped.length ? `; ${t("match.pref", "only group '{{g}}' used", { g: PREFERRED_GROUP })}` : ""),
          r.dropped.map((x) => `${x.subpath.name} [${x.subpath.group ?? "-"}]`).join("; "),
        ]),
        "matched-table",
      ),
      el("h4", { class: "avp-h", "data-avp": "unmatched-obs-title", text: t("match.unmatchedObs", "Unmatched observed routes ({{n}}, {{a}} ambiguous)", { n: c.obsUnmatched, a: m.ambiguousObs.length }) }),
      mk(
        [t("col.route", "Route"), t("col.dir", "Dir"), t("col.oid", "Subpath oid"), t("col.reason", "Reason")],
        m.unmatchedObs.map((r) => [r.route, r.direction || "-", r.subpath_oid === null ? "-" : String(r.subpath_oid), this.reasonText(r.reason, r.candidates.map((c) => `${c.subpath.name} [${String(c.subpath.oid ?? c.subpath.id)}]`))]),
        "unmatched-obs",
      ),
      el("h4", { class: "avp-h", "data-avp": "unmatched-sp-title", text: t("match.unmatchedSp", "Unmatched model subpaths ({{n}})", { n: c.subpathsUnmatched }) }),
      mk(
        [t("col.subpath", "Subpath"), t("col.group", "Group"), t("col.reason", "Reason")],
        m.unmatchedSubpaths.map((u) => [
          u.subpath.name,
          u.subpath.group ?? "-",
          u.reason === "not-in-scenario"
            ? t("reason.scenario", "not in this run's scenario")
            : u.reason === "ambiguous-observed"
              ? t("reason.ambiguousSp", "shares an exact name with another subpath: observed route is ambiguous")
            : u.reason === "no-direction-suffix"
              ? t("reason.nosuffix", "no direction suffix")
              : t("reason.noobs", "no observed route with this name+direction"),
        ]),
        "unmatched-subpaths",
      ),
    );
  }

  /** Validation/Comparison need a simulated table AND (for time-only typical-day data) a window declared in the data. */
  private compareInfo(): { mode: "compare" | "profile-only"; reason: string | null } {
    const rows = this.rows.filter((r) => r.source === this.source);
    if (!this.isTypical()) {
      const c = comparisonMode(rows);
      return { mode: c.mode, reason: c.reason };
    }
    // C11: time-only typical-day observations are compared by clock time inside the simulated run period.
    if (!this.simRows.length) return { mode: "profile-only", reason: null };
    const av = periodAvailability({ hasSim: true, simReason: this.pkg?.simReason ?? null, hasObs: rows.length > 0, result: this.periodResult() });
    return av.enabled ? { mode: "compare", reason: null } : { mode: "profile-only", reason: av.reason };
  }

  /** True when every row of the selected source is a time-only typical-day observation (C11 period matching applies). */
  private isTypical(): boolean {
    return !!this.sources.find((x) => x.source === this.source)?.typical;
  }

  private runNames(): string[] {
    return [...new Set(this.simRows.map((r) => r.run).filter((r): r is string => !!r))];
  }

  /** Run used for period matching and section values (the package's single run, else the user's choice). */
  private activeRun(): string | null {
    const runs = this.runNames();
    return runs.includes(this.periodRun) ? this.periodRun : (runs[0] ?? null);
  }

  /** C11 pairing of the selected observed source with one simulated run (default: the active run). */
  private periodResult(run?: string): PeriodResult {
    const r = run ?? this.activeRun();
    const rows = this.rows.filter((x) => x.source === this.source);
    const cfg = resolvePeriodConfig(this.pkg?.periodInfo ?? EMPTY_PERIOD_INFO, { source: this.source, source_id: rows.find((x) => x.source_id)?.source_id ?? null }, r);
    return matchPeriod(obsPointsOf(this.rows, this.source).points, this.simRows.filter((x) => r === null || x.run === r), cfg, this.criteria, r);
  }

  private routeRowsFor(pairs: ReturnType<typeof toValidationPairs>): ReturnType<typeof perRoute> {
    return this.isTypical() ? routeRowsFromPairs(pairs) : perRoute(pairs, this.criteria);
  }

  private runSelect(onChange: () => void): HTMLElement | null {
    const { t } = this.d;
    const runs = this.runNames();
    if (runs.length < 2 || this.hostManaged) return null; // the host owns the run
    const sel = el("select", { class: "avp-select", attrs: { "data-testid": "period-run", "aria-label": t("period.run", "Simulated run") } });
    for (const r of runs) { const o = el("option", { value: r, text: r }); o.selected = r === this.activeRun(); sel.append(o); }
    sel.addEventListener("change", () => { this.periodRun = sel.value; onChange(); });
    return el("label", { class: "avp-lbl" }, t("period.run", "Simulated run"), sel);
  }

  private periodText(res: PeriodResult): string {
    const { t } = this.d;
    const c = res.config;
    return t("period.info", "Simulated period {{p}} ({{src}}); matching {{mode}}, convention {{conv}}, tolerance {{tol}} s{{decl}}.", {
      p: res.periodLabel ?? "unknown", src: res.period?.source ?? "-", mode: c.matchMode, conv: c.convention, tol: c.toleranceS,
      decl: c.declared ? ", declared in the run configuration" : ", defaults",
    });
  }

  private reasonText(reason: MatchReason, candidates: readonly string[] = []): string {
    const { t } = this.d;
    switch (reason) {
      case "ambiguous": return t("reason.ambiguous", "ambiguous: several model subpaths share this exact name ({{c}})", { c: candidates.join("; ") });
      case "oid-not-in-model": return t("reason.oidMissing", "subpath_oid is not a subpath of this model/scenario and no name matched");
      case "no-direction": return t("reason.noDirection", "no exact name match and no recognisable direction");
      case "no-subpath": return t("reason.noSubpath", "no model subpath with this name + direction");
      default: return t("reason.matched", "matched");
    }
  }

  // ---- incremental updates ---------------------------------------------------------------------
  private updateChart(): void {
    const body = this.body;
    const chart = body?.querySelector<HTMLElement>('[data-avp="chart"]');
    const readout = body?.querySelector<HTMLElement>('[data-avp="readout"]');
    if (!chart || !readout) return;
    const { t } = this.d;
    const [route, dir] = this.routeKey.split("\u0000");
    const p = profileOf(this.rows, route ?? "", dir ?? "", this.source);
    const info = this.sources.find((s) => s.source === this.source);
    const selectedKey = pairKey(route ?? "", dir ?? "");
    const sim = this.simRows.filter((r) => pairKey(r.route, r.direction_norm) === selectedKey);
    const simWindow = sim.length ? {
      start: Math.min(...sim.map((r) => (r.interval_start_s ?? r.bucket_start_min * 60) / 60)),
      end: Math.max(...sim.map((r) => ((r.interval_start_s ?? r.bucket_start_min * 60) + (r.duration_s ?? this.bucketMin * 60)) / 60)),
    } : null;
    const simSeries = [...new Set(sim.map((r) => r.run ?? this.pkg?.run ?? "run"))].map((run) => ({
      label: t("profile.simulated", "Simulated {{run}}", { run }),
      points: sim.filter((r) => (r.run ?? this.pkg?.run ?? "run") === run).flatMap((r) => [
        { x: (r.interval_start_s ?? r.bucket_start_min * 60) / 60, y: r.sim_s },
        { x: ((r.interval_start_s ?? r.bucket_start_min * 60) + (r.duration_s ?? this.bucketMin * 60)) / 60, y: r.sim_s },
      ]), color: STATUS_COLORS.fail, step: true, width: 2.5,
    }));
    mountChart(
      chart,
      lineSvg({
        label: t("chart.aria", "Typical-day observed and simulated journey time for {{r}} {{d}}", { r: route ?? "", d: dir ?? "" }),
        series: [
          { label: p.dateKind === "typical" ? t("stat.typical", "Observed typical day") : t("stat.medianShort", "Observed median across days"), points: p.median, color: "hsl(var(--primary))" },
          ...(p.hasSupplied && p.nDaysMax > 1
            ? [
                { label: t("chart.dayMin", "Across-day minimum of daily means"), points: p.band.map((b) => ({ x: b.x, y: b.lo })), color: "hsl(var(--muted-foreground))", width: 1 },
                { label: t("chart.dayMax", "Across-day maximum of daily means"), points: p.band.map((b) => ({ x: b.x, y: b.hi })), color: "hsl(var(--muted-foreground))", width: 1 },
              ]
            : []),
          ...simSeries,
        ],
        band: p.hasSupplied
          ? { label: t("chart.bandSupplied", "Observed min-max supplied by the source"), points: p.suppliedBand }
          : { label: t("chart.band", "Observed min-max across days"), points: p.band },
        simWindow,
        vline: this.geo || this.hostManaged ? this.bucket : null,
        xMin: 0,
        xMax: 1440,
        xTitle: t("chart.x", "Time of day"),
        yTitle: t("chart.y", "Journey time (s)"),
      }),
    );
    chart.dataset.testid = "day-profile";
    chart.dataset.points = String(p.mean.filter((x) => x.y !== null).length);
    chart.dataset.supplied = String(p.hasSupplied);
    chart.dataset.dateKind = p.dateKind;
    const at = this.rows.find((r) => r.source === this.source && r.route === route && r.direction_norm === dir && r.bucket_start_min === this.bucket);
    const dayRange = at ? t("readout.dayRange", "across-day range {{lo}}-{{hi}} s over {{n}} days", { lo: fmt(at.min_s), hi: fmt(at.max_s), n: at.n_days }) : "";
    readout.textContent = at
      ? at.sup_min_s !== null && at.sup_min_s !== undefined && at.sup_max_s !== null && at.sup_max_s !== undefined
        ? t("readout.supplied", "{{time}}: observed {{mean}} s, supplied min-max {{smin}}-{{smax}} s; {{day}}", {
            time: bucketLabel(this.bucket), mean: fmt(at.mean_s), smin: fmt(at.sup_min_s), smax: fmt(at.sup_max_s), day: dayRange,
          })
        : t("readout", "{{time}}: observed median {{median}} s (mean {{mean}} s), range {{lo}}-{{hi}} s over {{n}} days", {
            time: bucketLabel(this.bucket), mean: fmt(at.mean_s), median: fmt(at.median_s), lo: fmt(at.min_s), hi: fmt(at.max_s), n: at.n_days,
          })
      : t("readout.none", "{{time}}: no observation for this bucket", { time: bucketLabel(this.bucket) });
    void info;
  }

  private currentFeatures(): GeoJSONFC | null {
    if (!this.geo || !this.match) return null;
    const typicalCmp = this.isTypical();
    if (this.viewMode === VIEW_VALIDATION || this.viewMode === VIEW_COMPARISON) {
      const errorMode = typicalCmp && this.cmpColour === "error";
      const fc: GeoJSONFC = { type: "FeatureCollection", features: [] };
      const geometry = new Map(this.geo.features.map((f, i) => [String((f.properties?.id as string | number | undefined) ?? f.id ?? i), f.geometry]));
      const add = (rows: ReturnType<typeof perRoute>, statusOverride?: Map<string, string>, extras?: Map<string, Record<string, unknown>>): void => {
        const byKey = new Map(rows.map((r) => [r.key, r]));
        for (const route of this.match!.matchedObs) for (const match of route.matches) {
          const item = byKey.get(route.key ?? "");
          const status = statusOverride?.get(route.key ?? "") ?? item?.status ?? "only";
          const statusColour = status === "pass" || status === "improved" ? STATUS_COLORS.pass : status === "warn" ? STATUS_COLORS.warn : status === "fail" || status === "degraded" ? STATUS_COLORS.fail : "#888888";
          const color = errorMode && item ? divergingColour(item.errorPct, ERROR_CAP) : statusColour;
          const g = geometry.get(String(match.subpath.id)); if (!g) continue;
          fc.features.push({ type: "Feature", id: match.subpath.id, geometry: g, properties: {
            name: match.subpath.name, route: route.route, direction: route.direction, status, stroke: color,
            sim_s: item?.sim ?? null, obs_s: item?.obs ?? null, error_pct: item?.errorPct ?? null,
            tooltip: statusOverride
              ? `${route.route} - ${route.direction}; Run A |error| ${fmt(extras?.get(route.key ?? "")?.error_a_pct as number)}%; Run B |error| ${fmt(extras?.get(route.key ?? "")?.error_b_pct as number)}%; ${status}`
              : `${route.route} - ${route.direction}; simulated ${fmt(item?.sim)} s; observed ${fmt(item?.obs)} s; relative error ${fmt(item?.errorPct)}% (${status})`,
            ...(extras?.get(route.key ?? "") ?? {}), "stroke-width": 4, "stroke-opacity": 0.9,
          } });
        }
      };
      if (this.viewMode === VIEW_VALIDATION || typicalCmp) add(this.routeRowsFor(this.validationPairing().pairs));
      else {
        const a = this.routeRowsFor(this.validationPairing(this.comparisonA).pairs), b = this.routeRowsFor(this.validationPairing(this.comparisonB).pairs);
        const joined = joinComparison(a, b), status = new Map(joined.map((r) => [r.key, r.status]));
        const keysA = new Set(this.simRows.filter((r) => r.run === this.comparisonA).map((r) => pairKey(r.route, r.direction_norm)).filter((k): k is string => !!k));
        const keysB = new Set(this.simRows.filter((r) => r.run === this.comparisonB).map((r) => pairKey(r.route, r.direction_norm)).filter((k): k is string => !!k));
        for (const k of keysA) if (!keysB.has(k)) status.set(k, "only");
        for (const k of keysB) if (!keysA.has(k)) status.set(k, "only");
        add(a, status, new Map(joined.map((r) => [r.key, { error_a_pct: r.a, error_b_pct: r.b, change_pct: r.change }])));
      }
      return fc;
    }
    const rows = this.rows.filter((r) => r.source === this.source);
    const values = valuesAtBucket(rows, this.bucket, this.stat, this.colourBy);
    const matchedKeys = new Set(this.match.matchedObs.map((m) => m.key));
    const scale = colourScale([...values.values()].filter((v) => matchedKeys.has(v.key)).map((v) => v.value));
    const fc = overlayFeatures({ geo: this.geo, match: this.match, values, source: this.source, bucket: this.bucket, scale });
    if (this.sectionTarget()) {
      const [selRoute, selDir] = this.routeKey.split("\u0000");
      fc.features = fc.features
        .filter((f) => !(f.properties?.route === selRoute && f.properties?.direction === selDir))
        .map((f) => ({ ...f, properties: { ...f.properties, "stroke-width": 2, "stroke-opacity": 0.4 } }));
    }
    const body = this.body;
    if (body) {
      const q = (a: string) => body.querySelector<HTMLElement>(`[data-avp="${a}"]`);
      const unit = this.colourBy === "seconds" ? " s" : "x";
      const d = this.colourBy === "seconds" ? 0 : 2;
      const lo = q("legend-min");
      const hi = q("legend-max");
      if (lo) lo.textContent = `${scale.min.toFixed(d)}${unit}`;
      if (hi) hi.textContent = `${scale.max.toFixed(d)}${unit}`;
    }
    return fc;
  }

  updateMap(): void {
    const { t } = this.d;
    const note = (txt: string): void => {
      this.overlayNote = txt;
      const n = this.body?.querySelector<HTMLElement>('[data-avp="overlay-note"]');
      if (n) n.textContent = txt;
    };
    const fc = this.pkg ? this.currentFeatures() : null;
    if (!fc) {
      this.removeOverlays();
      return;
    }
    if (!fc.features.length && !this.sectionTarget()) {
      this.removeOverlays();
      note(t("map.nomatch", "No matched subpath to draw for this source."));
      return;
    }
    if (!this.overlay.set(fc)) {
      note(t("map.noMap", "No 2D map is available on this renderer; chart and route values remain available."));
      return;
    }
    note(this.viewMode === VIEW_VALIDATION
      ? t("map.validationDrawn", "{{n}} subpath lines coloured by validation status; sim, obs and relative error are attached to each line.", { n: fc.features.length })
      : this.viewMode === VIEW_COMPARISON
        ? t("map.comparisonDrawn", "{{n}} subpath lines coloured by change between the selected runs.", { n: fc.features.length })
        : t("map.drawn", "{{n}} subpath lines drawn for {{time}} as a live plugin overlay.", { n: fc.features.length, time: bucketLabel(this.bucket) }));
    this.updateSections();
    this.updateCmpLegend();
    this.fitRun();
  }

  /** Fit once per run/package to the whole subpath geometry; never on source/bucket/window changes. */
  private fitRun(): void {
    const app = this.d.getApp();
    if (!app || !this.geo || !this.pkg) return;
    this.fitter ??= new RunFitter({ getMap: () => (this.d.getApp()?.getMap?.() as never) ?? null, fitBounds: (b) => this.d.getApp()?.fitBounds?.(b) });
    this.fitter.fit(`${this.lastUrl}|${this.pkg.origin ?? ""}|${this.pkg.run ?? ""}`, geometryPositions(this.geo.features.map((f) => f.geometry as { coordinates?: unknown })));
  }

  // ---- C12: per-section delay --------------------------------------------------------------------------------------------
  /** Model subpath oid of the selected route when per-section data exists for it, else null (current behaviour). */
  private sectionTarget(): string | null {
    if (this.viewMode !== VIEW_JT || !this.pkg?.sections || !this.secRows.length || !this.match) return null;
    const [route, dir] = this.routeKey.split("\u0000");
    const row = this.match.matchedObs.find((m) => m.route === route && m.direction === dir);
    if (!row) return null;
    const have = new Set(this.secRows.map((r) => r.subpath_oid));
    const cands = [row.subpath_oid, ...row.matches.map((m) => m.subpath.oid ?? m.subpath.id)].filter((v) => v !== null && v !== undefined).map(String);
    for (const c of cands) if (have.has(c) && sectionGeometry(this.pkg.sections, c).length) return c;
    return null;
  }

  /** Why the per-section layer is unavailable (goes to the Details disclosure), or null when it is available / nothing to explain. */
  private sectionsReason(): HTMLElement | null {
    const { t } = this.d;
    const pkg = this.pkg;
    if (!pkg || (pkg.sections && this.secRows.length)) return null;
    const why = pkg.sectionReason ?? (!pkg.sections && !pkg.hasSectionTt ? "no per-section tables (subpath_sections.geojson, section_sim_tt) in this package" : !pkg.sections ? "subpath_sections.geojson is missing" : "section_sim_tt is missing or has no usable rows");
    if (!pkg.hasSim && !pkg.sectionReason && !pkg.sections && !pkg.hasSectionTt) return null; // legacy / observed-only: nothing to explain
    return el("p", { class: "avp-hint", "data-avp": "sections-unavailable", "data-reason": why, text: t("sections.unavailable", "Per-section speed is unavailable ({{why}}).", { why }) });
  }

  /** Speed-only section legend (red slow, yellow, green fast; breakpoints at 0/25/50/75/100 % of the route max) and the slowest sections. */
  private sectionControls(): HTMLElement | null {
    const { t } = this.d;
    const pkg = this.pkg;
    if (!pkg || !(pkg.sections && this.secRows.length)) return null;
    const ramp = el("div", { class: "avp-ramp avp-speed-ramp", "data-avp": "sec-ramp" });
    ramp.style.background = speedGradient();
    const wrap = el("div", { class: "avp-section", "data-avp": "sections" },
      el("h4", { class: "avp-h", text: t("sections.title", "Selected route: speed by section (km/h)") }),
      el("div", { class: "avp-legend", "data-avp": "sec-legend" }, el("span", { "data-avp": "sec-legend-min" }), ramp, el("span", { "data-avp": "sec-legend-max" })),
      el("div", { class: "avp-ticks avp-small", "data-avp": "sec-breaks" }),
      el("p", { class: "avp-small", "data-avp": "sec-note" }),
      el("h4", { class: "avp-h", text: t("sections.slowest.title", "Slowest 3 sections") }),
      el("ol", { class: "avp-small", "data-avp": "worst-sections" }),
    );
    return wrap;
  }

  private updateSections(): void {
    const { t } = this.d;
    const q = (a: string): HTMLElement | null => this.body?.querySelector<HTMLElement>(`[data-avp="${a}"]`) ?? null;
    const note = (txt: string): void => { const n = q("sec-note"); if (n) n.textContent = txt; };
    const drawn = (txt: string): void => { const n = q("overlay-note"); if (n) n.textContent = `${this.overlayNote} ${txt}`.trim(); };
    const worstEl = q("worst-sections");
    if (worstEl) worstEl.replaceChildren();
    q("sec-breaks")?.replaceChildren();
    const oid = this.sectionTarget();
    if (!oid || !this.pkg?.sections) {
      this.sectionOverlay.remove();
      note(this.pkg?.sections && this.secRows.length && this.viewMode === VIEW_JT ? t("sections.none", "The selected route has no per-section data; the route line is drawn as usual.") : "");
      return;
    }
    const from = this.cursorFromS();
    const values = sectionValuesAt(this.secRows, oid, this.activeRun(), from, from + JT_BUCKET_S);
    const scale = speedScale([...values.values()].map((v) => v.speed_kmh));
    const [route, dir] = this.routeKey.split("\u0000");
    const geometry = sectionGeometry(this.pkg.sections, oid);
    const fc = sectionFeatures({ geometry, values, scale, bucketLabel: bucketLabel(this.bucket), routeName: `${route} ${dir}`.trim() });
    const lo = q("sec-legend-min");
    const hi = q("sec-legend-max");
    if (lo) lo.textContent = "0";
    if (hi) hi.textContent = `${scale.max.toFixed(0)} km/h`;
    const ticks = q("sec-breaks");
    if (ticks) for (const [i, b] of scale.breaks.entries()) ticks.append(el("span", { "data-avp": `sec-break-${i}`, text: b.toFixed(0) }));
    if (!values.size) { this.sectionOverlay.remove(); note(t("sections.nodata", "No simulated section values for {{time}} (outside the simulated period).", { time: bucketLabel(this.bucket) })); return; }
    if (!this.sectionOverlay.set(fc)) { note(t("map.noMap", "No 2D map is available on this renderer; chart and route values remain available.")); return; }
    note(t("sections.range", "Speed {{lo}}-{{hi}} km/h at {{time}}.", { lo: scale.min.toFixed(0), hi: scale.max.toFixed(0), time: bucketLabel(this.bucket) }));
    const geomMethods = new Set(fc.features.map((f) => String(f.properties?.geometry_method ?? "")).filter(Boolean));
    drawn(t("sections.drawn", "{{n}} sections drawn for {{time}}, coloured by speed; unselected routes are dimmed.", { n: fc.features.length, time: bucketLabel(this.bucket) }) + (geomMethods.has("split-approx") ? ` ${t("sections.approx", "Section geometry is approximate (split of the subpath line).")}` : ""));
    if (worstEl) {
      for (const w of slowestSections(values, geometry, 3)) worstEl.append(el("li", { text: t("sections.slowest", "#{{seq}} section {{id}}: {{v}} km/h, {{len}} m", { seq: w.seq, id: w.section_id, v: fmt(w.speed_kmh), len: w.length_m === null ? "-" : fmt(w.length_m, 0) }) }));
    }
  }

  // ---- C11: comparison view (pairs, aggregates, per-route status) ------------------------------------------------------------
  private mapColourControls(): HTMLElement {
    const { t } = this.d;
    const sel = el("select", { class: "avp-select", "aria-label": t("cmp.colour", "Map colour"), "data-avp": "cmp-colour" });
    for (const [v, k, def] of [["status", "cmp.colour.status", "Status (pass / warn / fail)"], ["error", "cmp.colour.error", "Signed error (diverging)"]] as const) {
      const o = el("option", { value: v, text: t(k, def) }); o.selected = v === this.cmpColour; sel.append(o);
    }
    sel.addEventListener("change", () => { this.cmpColour = sel.value as "status" | "error"; this.updateMap(); });
    return el("section", { class: "avp-section", "data-avp": "cmp-map" }, el("label", { class: "avp-lbl" }, t("cmp.colour", "Map colour"), sel), el("div", { class: "avp-legend", "data-avp": "cmp-legend" }), el("p", { class: "avp-small", "data-avp": "overlay-note" }));
  }

  private updateCmpLegend(): void {
    const { t } = this.d;
    const box = this.body?.querySelector<HTMLElement>('[data-avp="cmp-legend"]');
    if (!box) return;
    box.replaceChildren();
    if (this.cmpColour === "error") {
      const ramp = el("div", { class: "avp-ramp" });
      ramp.style.background = DIVERGING_GRADIENT;
      box.append(el("span", { text: `-${ERROR_CAP}%` }), ramp, el("span", { text: `+${ERROR_CAP}%` }));
      box.title = t("cmp.legend.error", "Signed relative error of the simulated value (blue: simulated faster than observed, red: slower); saturates at +-{{c}}%.", { c: ERROR_CAP });
      return;
    }
    for (const [colour, label] of [[STATUS_COLORS.pass, t("status.pass", "Pass")], [STATUS_COLORS.warn, t("status.warn", "Warn")], [STATUS_COLORS.fail, t("status.fail", "Fail")], ["#888888", t("cmp.nopair", "No pair")]] as const) {
      const sw = el("span", { class: "avp-swatch" });
      sw.style.background = colour;
      box.append(sw, el("span", { text: label }));
    }
  }

  private renderPeriodComparison(body: HTMLElement, reasons: readonly string[] = []): void {
    const { t } = this.d;
    const redraw = (): void => this.renderBody();
    const res = this.periodResult();
    const agg = aggregates(res.pairs);
    const rs = this.runSelect(redraw);
    const periodInfoEl = el("p", { class: "avp-hint", attrs: { "data-avp": "period-info", "data-period": res.periodLabel ?? "" } }, this.periodText(res));
    const thresholds = el("p", { class: "avp-hint", attrs: { "data-avp": "thresholds" } }, t("period.thresholds", "Status: pass when the simulated value is inside the supplied min-max band or the absolute error is <= {{p}}%; warn up to {{f}}%; fail beyond (editable below). A route takes the worst status of its pairs.", { p: this.criteria.passPct, f: this.criteria.failPct }));
    if (rs) body.append(el("section", { class: "avp-section", attrs: { "data-testid": "period-controls" } }, rs));
    body.append(this.criteriaSection(redraw));
    if (!res.pairs.length) { body.append(banner("warn", t("period.none", "No observation is inside the simulated period."), { "data-testid": "validation-disabled" }), this.detailsBlock(reasons, [periodInfoEl, thresholds])); this.updateMap(); return; }
    const pct = (v: number | null): string => (v === null ? "-" : `${v.toFixed(1)}%`);
    const kpi = (id: string, label: string, value: string): HTMLElement => el("div", { class: "avp-kpi", attrs: { "data-kpi": id, "data-value": value } }, el("b", { text: value }), el("span", { text: label }));
    body.append(el("div", { class: "avp-kpis", attrs: { "data-testid": "period-kpis" } },
      kpi("n", t("kpi.pairs", "Pairs"), String(agg.n)), kpi("routes", t("kpi.routes", "Routes"), String(agg.nRoutes)),
      kpi("mape", t("kpi.mape", "MAPE (%)"), pct(agg.mape)), kpi("bias", t("kpi.bias", "Bias (s)"), fmt(agg.bias)),
      kpi("band", t("kpi.band", "Inside min-max band"), agg.bandHitRate === null ? "-" : `${agg.bandHitRate.toFixed(0)}% (${agg.nBand})`),
      kpi("pass", t("status.pass", "Pass"), String(agg.nPass)), kpi("warn", t("status.warn", "Warn"), String(agg.nWarn)), kpi("fail", t("status.fail", "Fail"), String(agg.nFail))));
    const routes = this.routeRowsFor(toValidationPairs(res.pairs));
    const chart = el("div", { class: "avp-chart", attrs: { "data-testid": "route-status-chart" } });
    mountChart(chart, barSvg(routes.map((r) => ({ label: `${r.route} ${r.direction}`.trim(), value: r.errorPct, color: STATUS_COLORS[r.status] })), { label: t("period.statusChart", "Mean signed error per route, coloured by status"), yTitle: t("period.errorPct", "Error (%)") }));
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("period.byRoute", "Per-route status") }), chart,
      el("div", { class: "avp-table-wrap" }, (() => {
        const tb = el("table", { class: "avp-table", attrs: { "data-testid": "route-status" } }, el("thead", {}, el("tr", {}, ...["Route", "Direction", "Pairs", "Observed (s)", "Simulated (s)", "Error (%)", "Status"].map((h) => el("th", { text: t(`table.${h}`, h) })))));
        const tbd = el("tbody");
        for (const r of routes) tbd.append(el("tr", { attrs: { "data-status": r.status } }, el("td", { text: r.route }), el("td", { text: r.direction }), el("td", { text: String(r.nBuckets) }), el("td", { text: fmt(r.obs) }), el("td", { text: fmt(r.sim) }), el("td", { text: fmt(r.errorPct) }), el("td", { text: t(`status.${r.status}`, r.status) })));
        tb.append(tbd);
        return tb;
      })())));
    // pairs table
    const tb = el("table", { class: "avp-table", attrs: { "data-testid": "pairs-table" } });
    tb.append(el("thead", {}, el("tr", {}, ...["Route", "Direction", "Time", "Simulated (s)", "Observed (s)", "Min (s)", "Max (s)", "Error (s)", "Error (%)", "Inside band", "Status"].map((h) => el("th", { text: t(`table.${h}`, h) })))));
    const tbody = el("tbody");
    for (const p of res.pairs) {
      tbody.append(el("tr", { attrs: { "data-status": p.status, "data-kind": p.kind } }, el("td", { text: p.route }), el("td", { text: p.direction }), el("td", { text: p.timeLabel }), el("td", { text: fmt(p.sim) }), el("td", { text: fmt(p.obs) }),
        el("td", { text: fmt(p.min) }), el("td", { text: fmt(p.max) }), el("td", { text: fmt(p.errorS) }), el("td", { text: fmt(p.errorPct) }),
        el("td", { text: p.inBand === null ? "-" : p.inBand ? t("yes", "yes") : t("no", "no") }), el("td", { text: t(`status.${p.status}`, p.status) })));
    }
    tb.append(tbody);
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("period.pairs", "Simulated vs observed pairs") }), el("div", { class: "avp-table-wrap" }, tb)));
    // unpaired
    const det = el("div", { class: "avp-section", attrs: { "data-avp": "unpaired", "data-n": String(res.unpaired.length) } });
    det.append(el("h4", { class: "avp-h", text: t("period.unpaired", "Not compared: {{n}} observation(s), {{o}} route(s) without simulation, {{s}} simulated-only route(s)", { n: res.unpaired.length, o: res.obsOnlyRoutes.length, s: res.simOnlyRoutes.length }) }));
    const ut = el("table", { class: "avp-table", attrs: { "data-testid": "unpaired-table" } }, el("thead", {}, el("tr", {}, ...["Route", "Direction", "Time", "Reason"].map((h) => el("th", { text: t(`table.${h}`, h) })))));
    const ub = el("tbody");
    for (const u of res.unpaired) ub.append(el("tr", { attrs: { "data-code": u.code } }, el("td", { text: u.route }), el("td", { text: u.direction }), el("td", { text: u.timeLabel }), el("td", { text: u.reason })));
    ut.append(ub);
    det.append(el("div", { class: "avp-table-wrap" }, ut));
    if (res.simOnlyRoutes.length) det.append(el("p", { class: "avp-small", text: `${t("unm.sim", "Simulated only")}: ${res.simOnlyRoutes.join("; ")}` }));
    body.append(this.mapColourControls(), this.detailsBlock(reasons, [periodInfoEl, thresholds, det]));
    if (this.runNames().length > 1) this.renderComparison(body);
    else this.updateMap();
  }

  private criteriaSection(onChange: () => void): HTMLElement {
    const { t } = this.d;
    const details = el("details", { class: "avp-details avp-section", attrs: { "data-testid": "criteria" } });
    details.append(el("summary", { class: "avp-h", text: t("criteria.title", "Criteria") }));
    const error = el("p", { class: "avp-hint", attrs: { role: "alert", "data-testid": "criteria-error" } });
    const entries: Array<[string, string, number]> = [
      ["passPct", "Pass relative error (%)", this.criteria.passPct], ["failPct", "Fail relative error (%)", this.criteria.failPct],
      ["targetPct", "Target passing (%)", this.criteria.targetPct], ["absoluteSeconds", "Absolute alternative (s)", this.criteria.absoluteSeconds],
      ...this.criteria.bandEdges.map((v, i) => [`edge${i + 1}`, `Observed JT band edge ${i + 1} (s)`, v] as [string, string, number]),
      ["bandPassPct", "Band green threshold (%)", this.criteria.bandPassPct], ["bandWarnPct", "Band orange threshold (%)", this.criteria.bandWarnPct],
    ];
    const inputs = entries.map(([key, label, value]) => {
      const input = el("input", { class: "avp-input avp-num", attrs: { type: "number", min: "0", step: "any", value: String(value), "data-criteria": key, "aria-label": t(`criteria.${key}`, label) } });
      input.addEventListener("change", () => {
        const all = [...details.querySelectorAll<HTMLInputElement>("input[data-criteria]")];
        const v = Object.fromEntries(all.map((node) => [node.dataset.criteria!, node.valueAsNumber])) as Record<string, number>;
        const checkbox = details.querySelector<HTMLInputElement>('[data-criteria="absoluteEnabled"]');
        try {
          this.criteria = validateCriteria({ passPct: v.passPct, failPct: v.failPct, targetPct: v.targetPct,
            absoluteEnabled: checkbox?.checked ?? false, absoluteSeconds: v.absoluteSeconds,
            bandEdges: [v.edge1, v.edge2, v.edge3, v.edge4], bandPassPct: v.bandPassPct, bandWarnPct: v.bandWarnPct });
          error.textContent = ""; onChange();
        } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
      });
      return el("label", { class: "avp-lbl" }, t(`criteria.${key}`, label), input);
    });
    const absolute = el("input", { type: "checkbox", checked: this.criteria.absoluteEnabled, attrs: { "data-criteria": "absoluteEnabled" } });
    absolute.addEventListener("change", () => {
      const pass = details.querySelector<HTMLInputElement>('[data-criteria="passPct"]')!;
      pass.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const reset = el("button", { class: "avp-btn avp-secondary", text: t("criteria.reset", "Reset to defaults"), attrs: { type: "button", "data-testid": "criteria-reset" } });
    reset.addEventListener("click", () => { this.criteria = { ...DEFAULT_CRITERIA, bandEdges: [...DEFAULT_CRITERIA.bandEdges] }; onChange(); });
    details.append(el("div", { class: "avp-row" }, ...inputs, el("label", { class: "avp-inline" }, absolute, t("criteria.absolute", "Enable absolute pass within seconds"))), error, reset);
    return details;
  }

  private validationPairing(run?: string): PairingResult {
    if (this.isTypical()) {
      const r = this.periodResult(run);
      const paired = new Set(r.pairs.map((x) => x.key));
      const noOverlap = [...new Map(r.unpaired.filter((u) => u.key && !paired.has(u.key) && u.code !== "no-sim-route").map((u) => [u.key!, `${u.route} - ${u.direction}`])).values()];
      return { pairs: toValidationPairs(r.pairs), obsOnly: r.obsOnlyRoutes, simOnly: r.simOnlyRoutes, noOverlap };
    }
    const obs = this.rows.filter((r) => r.source === this.source);
    const sim = run ? this.simRows.filter((r) => r.run === run) : this.simRows;
    return pairObsSim(obs, sim, "median", this.win, this.criteria);
  }

  private renderProfile(body: HTMLElement, route: string, direction: string, sim: SimRow[]): void {
    const { t } = this.d;
    const p = profileOf(this.rows, route, direction, this.source);
    const selectedKey = pairKey(route, direction);
    const selectedSims = sim.filter((r) => pairKey(r.route, r.direction_norm) === selectedKey);
    const series = [...new Set(selectedSims.map((r) => r.run ?? "run"))].map((run) => ({
      label: t("profile.simulated", "Simulated {{run}}", { run }), color: STATUS_COLORS.fail, step: true, width: 2.5,
      points: selectedSims.filter((r) => (r.run ?? "run") === run).flatMap((r) => [
        { x: (r.interval_start_s ?? r.bucket_start_min * 60) / 60, y: r.sim_s },
        { x: ((r.interval_start_s ?? r.bucket_start_min * 60) + (r.duration_s ?? this.bucketMin * 60)) / 60, y: r.sim_s },
      ]),
    }));
    const chart = el("div", { class: "avp-chart", attrs: { "data-testid": "day-profile" } });
    mountChart(chart, lineSvg({ label: t("profile.aria", "Typical-day observed and simulated journey time"),
      series: [{ label: t("profile.obsMedian", "Observed median across days"), points: p.median, color: "hsl(var(--primary))" }, ...series],
      band: { label: t("profile.band", "Observed min-max across days"), points: p.band },
      xMin: 0, xMax: 1440, xTitle: t("chart.x", "Time of day"), yTitle: t("chart.y", "Journey time (s)") }));
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("profile.title", "Day profile — {{route}} {{dir}}", { route, dir: direction }) }),
      chart));
  }

  private renderValidation(body: HTMLElement, reasons: readonly string[] = []): void {
    const { t } = this.d;
    const redraw = (): void => { this.renderBody(); };
    const source = el("select", { class: "avp-select", attrs: { "data-testid": "validation-source", "aria-label": t("source.title", "Observed source") } });
    for (const item of this.sources) { const option = el("option", { value: item.source, text: t(...(SOURCE_LABELS[item.source] ?? [`source.${item.source}`, item.source])) }); option.selected = item.source === this.source; source.append(option); }
    source.addEventListener("change", () => { this.source = source.value; this.pickDefaults(); this.renderBody(); });
    const sourceControl: HTMLElement | null = this.sources.length > 1
      ? el("label", { class: "avp-lbl" }, t("source.title", "Observed source"), source)
      : this.sources[0] ? el("p", { class: "avp-small", attrs: { "data-testid": "validation-source-label" } }, `${t("source.title", "Observed source")}: ${this.sourceText(this.sources[0])}`) : null;
    const current = this.win ?? { from: 0, to: 1440 };
    const time = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const from = el("input", { type: "time", class: "avp-input", value: time(current.from), attrs: { "data-testid": "validation-window-from" } });
    const to = el("input", { type: "time", class: "avp-input", value: time(current.to % 1440), attrs: { "data-testid": "validation-window-to" } });
    const applyWindow = (): void => {
      const parse = (v: string): number | null => { const m = /^(\d{2}):(\d{2})$/.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const a = parse(from.value); let b = parse(to.value); if (a === null || b === null) return; if (b <= a) b = b === 0 ? 1440 : b;
      if (b > a) { this.win = { from: a, to: b }; this.winTouched = true; redraw(); }
    };
    from.addEventListener("change", applyWindow); to.addEventListener("change", applyWindow);
    const periodInfoEl = this.isTypical() ? el("p", { class: "avp-hint", attrs: { "data-avp": "period-info" } }, this.periodText(this.periodResult())) : null;
    const controls = [sourceControl,
      this.isTypical() || this.hostManaged ? null : el("label", { class: "avp-lbl" }, t("window.title", "Time window"), el("span", { class: "avp-row" }, from, to)), // host window is used in host mode
      this.isTypical() ? this.runSelect(redraw) : null].filter((x): x is HTMLElement => !!x);
    if (controls.length) body.append(el("section", { class: "avp-section", attrs: { "data-testid": "validation-controls" } }, el("div", { class: "avp-row" }, ...controls)));
    const detailsNotes = [...reasons, t("source.never", "Sources are never mixed; the observed typical-day median is paired over the selected time window.")];
    body.append(this.criteriaSection(redraw));
    if (this.isTypical()) body.append(this.mapColourControls());
    const pairing = this.validationPairing();
    const rows = this.routeRowsFor(pairing.pairs);
    if (!rows.length) {
      body.append(banner("warn", t("validation.none", "Validation is disabled: this package contains no simulated JT segments overlapping the selected source and time window."), { "data-testid": "validation-disabled" }), this.detailsBlock(detailsNotes, [periodInfoEl]));
      return;
    }
    const stats = kpis(rows.map((r) => r.obs), rows.map((r) => r.sim), this.criteria.passPct, this.criteria);
    const kpi = (id: string, label: string, value: string): HTMLElement => el("div", { class: "avp-kpi", attrs: { "data-kpi": id, "data-value": value } }, el("b", { text: value }), el("span", { text: label }));
    const pct = (v: number | null): string => v === null ? "-" : `${v.toFixed(1)}%`;
    body.append(el("div", { class: "avp-kpis", attrs: { "data-testid": "validation-kpis" } },
      kpi("n", t("kpi.n", "Subpaths"), String(stats.count)), kpi("rmse", t("kpi.rmse", "RMSE (s)"), fmt(stats.rmse)),
      kpi("mae", t("kpi.mae", "MAE (s)"), fmt(stats.mae)), kpi("bias", t("kpi.bias", "Bias (s)"), fmt(stats.bias)),
      kpi("mape", t("kpi.mape", "MAPE (%)"), pct(rows.length ? rows.reduce((s, r) => s + Math.abs(r.errorPct), 0) / rows.length : null)),
      kpi("r2", t("kpi.r2", "R²"), fmt(stats.r2, 3)), kpi("slope", t("kpi.slope", "Slope"), fmt(stats.slope, 3)),
      kpi("pctWithin", t("kpi.pass", "% within pass / target {{target}}%", { target: this.criteria.targetPct }), pct(stats.count ? stats.nPass / stats.count * 100 : null))));
    const shares = { pass: stats.nPass / stats.count * 100, warn: stats.nWarn / stats.count * 100, fail: stats.nFail / stats.count * 100 };
    const compliance = el("div", { class: "avp-chart", attrs: { "data-testid": "compliance-bar" } });
    mountChart(compliance, stackedBarSvg([
      { label: t("status.pass", "Pass"), value: shares.pass, color: STATUS_COLORS.pass },
      { label: t("status.warn", "Warn"), value: shares.warn, color: STATUS_COLORS.warn },
      { label: t("status.fail", "Fail"), value: shares.fail, color: STATUS_COLORS.fail },
    ], this.criteria.targetPct, t("validation.compliance", "Validation compliance")));
    body.append(el("section", { class: "avp-section", attrs: { "data-testid": "compliance" } }, el("h3", { class: "avp-h", text: t("validation.compliance", "Compliance") }), compliance));

    const maxError = Math.max(this.criteria.failPct + 5, ...rows.map((r) => Math.abs(r.errorPct)));
    const cap = Math.max(40, Math.ceil(maxError / 10) * 10);
    const edges = [...new Set([0, ...Array.from({ length: cap / 5 }, (_, i) => (i + 1) * 5).filter((x) => x < cap), this.criteria.passPct, this.criteria.failPct, cap])].sort((a, b) => a - b);
    const bins = edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1], value: 0 }));
    for (const row of rows) { const v = Math.min(cap, Math.abs(row.errorPct)); const i = v >= cap ? bins.length - 1 : bins.findIndex((b) => v >= b.start && v < b.end); bins[Math.max(0, i)].value++; }
    const hist = el("div", { class: "avp-chart", attrs: { "data-testid": "error-histogram" } });
    mountChart(hist, histogramSvg(bins, { label: t("chart.errorHistogram", "Absolute percentage error distribution"), xTitle: t("chart.errorX", "Absolute relative error (%)"), yTitle: t("chart.count", "Subpaths"),
      binColor: (b) => b.end <= this.criteria.passPct ? STATUS_COLORS.pass : b.start >= this.criteria.failPct ? STATUS_COLORS.fail : STATUS_COLORS.warn,
      guides: [{ value: this.criteria.passPct, label: t("criteria.passGuide", "Pass {{n}}%", { n: this.criteria.passPct }), color: STATUS_COLORS.pass }, { value: this.criteria.failPct, label: t("criteria.failGuide", "Fail {{n}}%", { n: this.criteria.failPct }), color: STATUS_COLORS.fail }] }));
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("chart.errorHistogram", "Error histogram") }), hist));

    const scatter = el("div", { class: "avp-chart", attrs: { "data-testid": "validation-scatter" } });
    mountChart(scatter, scatterSvg(rows.map((r) => r.obs), rows.map((r) => r.sim), { label: t("scatter.aria", "Simulated versus observed journey time"), xTitle: t("scatter.x", "Observed (s)"), yTitle: t("scatter.y", "Simulated (s)"), identityLine: true,
      pointColor: (i) => STATUS_COLORS[rows[i].status] }));
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("scatter.title", "Simulated vs observed") }), scatter));

    const bands = journeyTimeBands(rows, this.criteria.bandEdges);
    const bar = el("div", { class: "avp-chart", attrs: { "data-testid": "pass-rate-by-band" } });
    mountChart(bar, groupedBarSvg(bands.filter((b) => b.passPct !== null).map((b) => ({ label: b.label, value: b.passPct!, n: b.n,
      color: b.passPct! >= this.criteria.bandPassPct ? STATUS_COLORS.pass : b.passPct! >= this.criteria.bandWarnPct ? STATUS_COLORS.warn : STATUS_COLORS.fail })),
      { label: t("validation.band", "Pass rate by observed journey-time band"), yTitle: t("validation.passRate", "Passing (%)") }));
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("validation.band", "Pass rate by observed journey-time band") }), bar));

    const top = el("select", { class: "avp-select", attrs: { "data-testid": "worst-count", "aria-label": t("worst.n", "Worst subpaths") } });
    for (const n of [10, 20, 50, 100]) { const option = el("option", { value: String(n), text: String(n) }); option.selected = n === this.topN; top.append(option); }
    top.addEventListener("change", () => { this.topN = Number(top.value); this.renderBody(); });
    const table = el("table", { class: "avp-table", attrs: { "data-testid": "worst-subpaths" } });
    const headings = ["Route", "Direction", "Observed (s)", "Simulated (s)", "Error (%)", "Status"].map((v) => el("th", { text: t(`table.${v}`, v) }));
    table.append(el("thead", {}, el("tr", {}, ...headings)));
    const tbody = el("tbody");
    const nTop = this.topN;
    for (const r of [...rows].sort((a, b) => b.absError - a.absError).slice(0, nTop)) {
      const tr = el("tr", { attrs: { "data-clickable": "true", "data-selected": String(this.selected === r.key), "data-status": r.status } },
        el("td", { text: r.route }), el("td", { text: r.direction }), el("td", { text: fmt(r.obs) }), el("td", { text: fmt(r.sim) }), el("td", { text: fmt(r.errorPct) }), el("td", { text: t(`status.${r.status}`, r.status) }));
      tr.addEventListener("click", () => { this.selected = r.key; this.renderBody(); });
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("worst.title", "Worst subpaths by absolute error") }), top,
      el("div", { class: "avp-table-wrap" }, table)));
    const selected = rows.find((r) => r.key === this.selected);
    if (selected) this.renderProfile(body, selected.route, selected.direction, this.simRows);
    body.append(this.detailsBlock(detailsNotes, [periodInfoEl]));
    this.updateMap();
  }

  private renderComparison(body: HTMLElement): void {
    const { t } = this.d;
    const runs = [...new Set(this.simRows.map((r) => r.run).filter((r): r is string => !!r))];
    if (runs.length < 2) { body.append(banner("warn", t("comparison.disabled", "Comparison is disabled: at least two runs with simulated journey time are required."))); return; }
    this.comparisonA = runs.includes(this.comparisonA) ? this.comparisonA : runs[0];
    this.comparisonB = runs.includes(this.comparisonB) && this.comparisonB !== this.comparisonA ? this.comparisonB : runs.find((r) => r !== this.comparisonA)!;
    const selectRun = (name: string, current: string): HTMLElement => {
      const s = el("select", { class: "avp-select", attrs: { "data-testid": name } });
      for (const run of runs) { const o = el("option", { value: run, text: run }); o.selected = run === current; s.append(o); }
      s.addEventListener("change", () => { if (name === "run-a") this.comparisonA = s.value; else this.comparisonB = s.value; this.renderBody(); });
      return s;
    };
    body.append(el("div", { class: "avp-row" }, el("label", { class: "avp-lbl" }, t("comparison.a", "Run A baseline"), selectRun("run-a", this.comparisonA)),
      el("label", { class: "avp-lbl" }, t("comparison.b", "Run B"), selectRun("run-b", this.comparisonB))));
    const pairByRun = new Map(runs.map((r) => [r, this.routeRowsFor(this.validationPairing(r).pairs)]));
    const table = el("table", { class: "avp-table", attrs: { "data-testid": "comparison-kpis" } });
    table.append(el("thead", {}, el("tr", {}, el("th", { text: t("comparison.metric", "Metric") }), ...runs.map((r) => el("th", { text: r })))));
    const metrics: Array<[string, (r: ReturnType<typeof perRoute>[number][]) => string]> = [
      ["n", (rs) => String(rs.length)], ["RMSE (s)", (rs) => fmt(kpis(rs.map((r) => r.obs), rs.map((r) => r.sim), this.criteria.passPct, this.criteria).rmse)],
      ["MAE (s)", (rs) => fmt(kpis(rs.map((r) => r.obs), rs.map((r) => r.sim), this.criteria.passPct, this.criteria).mae)],
      ["Bias (s)", (rs) => fmt(kpis(rs.map((r) => r.obs), rs.map((r) => r.sim), this.criteria.passPct, this.criteria).bias)],
      ["% pass", (rs) => { const k = kpis(rs.map((r) => r.obs), rs.map((r) => r.sim), this.criteria.passPct, this.criteria); return fmt(k.count ? k.nPass / k.count * 100 : null); }],
    ];
    for (const [label, value] of metrics) table.append(el("tr", {}, el("th", { text: t(`comparison.${label}`, label) }), ...runs.map((r) => el("td", { text: value(pairByRun.get(r)!) }))));
    body.append(table);
    const a = pairByRun.get(this.comparisonA)!, b = pairByRun.get(this.comparisonB)!;
    const joined = joinComparison(a, b);
    const both = joined.filter((r) => r.status !== "only");
    const ak = kpis(a.map((r) => r.obs), a.map((r) => r.sim), this.criteria.passPct, this.criteria);
    const bk = kpis(b.map((r) => r.obs), b.map((r) => r.sim), this.criteria.passPct, this.criteria);
    body.append(el("div", { class: "avp-kpis", attrs: { "data-testid": "comparison-deltas" } },
      el("div", { class: "avp-kpi" }, el("b", { text: fmt((bk.rmse ?? 0) - (ak.rmse ?? 0)) }), el("span", { text: t("comparison.deltaRmse", "Δ RMSE (B − A)") })),
      el("div", { class: "avp-kpi" }, el("b", { text: fmt((bk.count ? bk.nPass / bk.count * 100 : 0) - (ak.count ? ak.nPass / ak.count * 100 : 0)) }), el("span", { text: t("comparison.deltaPass", "Δ pass rate (B − A)") }))));
    const keysA = new Set(this.simRows.filter((r) => r.run === this.comparisonA).map((r) => pairKey(r.route, r.direction_norm)).filter((k): k is string => !!k));
    const keysB = new Set(this.simRows.filter((r) => r.run === this.comparisonB).map((r) => pairKey(r.route, r.direction_norm)).filter((k): k is string => !!k));
    const onlyA = [...keysA].filter((k) => !keysB.has(k)).length;
    const onlyB = [...keysB].filter((k) => !keysA.has(k)).length;
    body.append(el("p", { class: "avp-hint", attrs: { "data-testid": "comparison-coverage" }, text: t("comparison.coverage", "{{both}} shared subpaths; {{onlyA}} only in {{a}}; {{onlyB}} only in {{b}}.", { both: both.length, onlyA, a: this.comparisonA, onlyB, b: this.comparisonB }) }));
    const period = (run: string): [number, number] => { const s = this.simRows.filter((r) => r.run === run); return [Math.min(...s.map((r) => r.interval_start_s ?? r.bucket_start_min * 60)), Math.max(...s.map((r) => (r.interval_start_s ?? r.bucket_start_min * 60) + (r.duration_s ?? this.bucketMin * 60)))]; };
    const pa = period(this.comparisonA), pb = period(this.comparisonB);
    if (pa[0] !== pb[0] || pa[1] !== pb[1]) body.append(banner("warn", t("comparison.period", "Warning: {{a}} and {{b}} cover different simulated periods.", { a: this.comparisonA, b: this.comparisonB }), { "data-testid": "period-differs" }));
    const scatter = el("div", { class: "avp-chart", attrs: { "data-testid": "comparison-scatter" } });
    mountChart(scatter, scatterSvg(both.map((r) => r.a!), both.map((r) => r.b!), { xTitle: t("comparison.x", "Run A |error| (s)"), yTitle: t("comparison.y", "Run B |error| (s)"), label: t("comparison.scatter", "Per-subpath absolute error in A versus B"),
      pointColor: (i) => joined.filter((r) => r.status !== "only")[i].status === "improved" ? STATUS_COLORS.pass : joined.filter((r) => r.status !== "only")[i].status === "degraded" ? STATUS_COLORS.fail : "#888888" }));
    body.append(scatter);
    const topTable = (status: "improved" | "degraded"): HTMLElement => {
      const list = joined.filter((r) => r.status === status).sort((x, y) => status === "improved" ? (y.change ?? 0) - (x.change ?? 0) : (x.change ?? 0) - (y.change ?? 0)).slice(0, 10);
      const tb = el("table", { class: "avp-table", attrs: { "data-testid": `top-${status}` } });
      const bdy = el("tbody");
      for (const r of list) { const tr = el("tr", { attrs: { "data-clickable": "true" } }, el("td", { text: `${r.route} - ${r.direction}` }), el("td", { text: fmt(r.a) }), el("td", { text: fmt(r.b) }));
        tr.addEventListener("click", () => { this.selected = r.key; this.renderBody(); }); bdy.append(tr); }
      tb.append(bdy); return tb;
    };
    body.append(el("h3", { class: "avp-h", text: t("comparison.improved", "Improved") }), topTable("improved"),
      el("h3", { class: "avp-h", text: t("comparison.degraded", "Degraded") }), topTable("degraded"));
    const selected = a.find((r) => r.key === this.selected) ?? b.find((r) => r.key === this.selected);
    if (selected) this.renderProfile(body, selected.route, selected.direction, this.simRows.filter((r) => r.run === this.comparisonA || r.run === this.comparisonB));
    this.updateMap();
  }

  private unmatchedRoutes(p: PairingResult): HTMLElement {
    const { t } = this.d;
    const details = el("details", { class: "avp-details avp-section", attrs: { "data-avp": "unmatched", "data-obs-only": String(p.obsOnly.length), "data-sim-only": String(p.simOnly.length), "data-no-overlap": String(p.noOverlap.length) } });
    details.append(el("summary", { text: t("unm.title", "Not compared: {{o}} observed-only, {{s}} simulated-only, {{n}} without overlap", { o: p.obsOnly.length, s: p.simOnly.length, n: p.noOverlap.length }) }));
    for (const [title, items] of [[t("unm.obs", "Observed only"), p.obsOnly], [t("unm.sim", "Simulated only"), p.simOnly], [t("unm.none", "No common bucket"), p.noOverlap]] as const) details.append(el("p", { class: "avp-small", text: `${title}: ${items.join("; ") || "-"}` }));
    return details;
  }
  /** Test/diagnostic view of the controller state. */
  debug(): Record<string, unknown> {
    return { source: this.source, routeKey: this.routeKey, bucket: this.bucket, counts: this.match?.counts ?? null, overlayNote: this.overlayNote };
  }
}
