/**
 * Observed subpath journey time panel: package picker, route/direction picker, source toggle,
 * time-of-day profile (mean / median / min-max band across days), name-matching report and a map
 * overlay coloured by the selected 15-min bucket. Observed data only (no simulated JT exists).
 */
import type { DuckDbHandle } from "../../_shared/src/duckdb";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql";
import { groupedBarSvg, histogramSvg, mountChart, scatterSvg, stackedBarSvg, STATUS_COLORS } from "../../_shared/src/charts";
import type { GeoJSONFC, HostApp } from "./host";
import type { Translator } from "./i18n";
import { lineSvg } from "./lineSvg";
import { buildMatching, PREFERRED_GROUP, pairKey, type MatchResult, type ObsPair } from "./match";
import { MapOverlay } from "./overlay";
import { loadFromFiles, loadFromManifestUrl, subpathRefs, type PackageSummary } from "./pkg";
import {
  bucketLabel,
  colourScale,
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

export const PLUGIN_ID = "modelling-journey-time";
const BUCKET = 15;
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
  private fitted = false;
  private readonly overlay: MapOverlay;
  // DOM
  private root: HTMLElement | null = null;
  private bar: PackageBar | null = null;
  private body: HTMLElement | null = null;
  private lastUrl = "";

  constructor(private readonly d: Deps) {
    this.overlay = new MapOverlay(d.getApp);
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
    this.root.append(this.bar.root, this.body);
    this.bar.setStatus(this.status, this.error ? "error" : this.busy ? "busy" : "info");
    this.renderBody();
  }

  private stateName(): string {
    return this.error ? "error" : this.busy ? "loading" : this.pkg ? "ready" : "empty";
  }

  dispose(): void {
    this.overlay.remove();
    this.disposed = true;
    void this.session?.dispose(); // drops this panel's tables/views, detaches its catalog, closes its connection
    this.session = null;
  }

  // ---- loading ---------------------------------------------------------------------------------
  async loadUrl(url: string): Promise<void> {
    this.lastUrl = url;
    this.bar?.setUrl(url);
    await this.load((s) => loadFromManifestUrl(s, url));
  }

  async loadFiles(files: File[]): Promise<void> {
    await this.load((s) => loadFromFiles(s, files));
  }

  private async load(fn: (s: Session) => Promise<PackageSummary>): Promise<void> {
    const { t } = this.d;
    this.busy = true;
    this.error = null;
    this.status = t("status.loading", "Loading package...");
    this.build();
    try {
      this.overlay.remove();
      const h = await this.d.getDuck();
      if (this.disposed) return;
      const opened = this.session ?? (await openSession(h, "modelling_journey_time"));
      if (this.disposed) {
        await opened.dispose(); // deactivated while the session was opening: nothing may outlive the plugin
        return;
      }
      this.session = opened;
      const s = opened;
      const pkg = await fn(s);
      if (!pkg.hasObs) throw new Error(t("err.noObs", "This package is missing the required observed journey-time table subpath_obs_jt."));
      await s.exec(buildSubpathSql({ bucketMinutes: BUCKET }));
      this.rows = toObsRows(await s.query("SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
      this.sources = (
        await s.query<{ source: string; nd: number; d0: string; d1: string }>(
          "SELECT source, COUNT(DISTINCT day) AS nd, CAST(MIN(day) AS VARCHAR) AS d0, CAST(MAX(day) AS VARCHAR) AS d1 FROM v_sp_obs_day GROUP BY source ORDER BY source",
        )
      ).map((r) => ({ source: String(r.source), days: Number(r.nd), first: String(r.d0), last: String(r.d1) }));
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
      this.pkg = pkg;
      this.geo = pkg.geo;
      if (!this.sources.some((s) => s.source === this.source)) this.source = this.sources[0]?.source ?? "";
      this.fitted = false;
      if (!this.rows.some((r) => r.source === this.source && `${r.route}\u0000${r.direction_norm}` === this.routeKey)) this.routeKey = "";
      this.pickDefaults();
      if (this.viewMode === VIEW_VALIDATION && !this.simRows.length) this.viewMode = VIEW_JT;
      this.status = t("status.loaded", "Loaded {{n}} observed rows from {{origin}}.", { n: this.rows.length, origin: pkg.origin });
    } catch (e) {
      this.pkg = null;
      this.rows = [];
      this.error = e instanceof Error ? e.message : String(e);
      this.status = this.error;
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
      const k = `${r.route}\u0000${r.direction_norm}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ route: r.route, direction: r.direction_norm, source });
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
    if (buckets.length && !buckets.includes(this.bucket)) {
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
    const mode = el("select", { class: "avp-select", "aria-label": t("view.title", "View mode"), "data-avp": "view-mode" });
    const jtOption = el("option", { value: VIEW_JT, text: t("view.jt", "Journey Time") });
    jtOption.selected = this.viewMode === VIEW_JT;
    mode.append(jtOption);
    const hasSim = this.simRows.length > 0;
    const runs = [...new Set(this.simRows.map((r) => r.run).filter((r): r is string => !!r))];
    const validationOption = el("option", { value: VIEW_VALIDATION, text: t("view.validation", "Validation"), disabled: !hasSim });
    validationOption.selected = this.viewMode === VIEW_VALIDATION; mode.append(validationOption);
    const comparisonOption = el("option", { value: VIEW_COMPARISON, text: t("view.comparison", "Comparison"), disabled: runs.length < 2 });
    comparisonOption.selected = this.viewMode === VIEW_COMPARISON; mode.append(comparisonOption);
    if (!hasSim) body.append(el("p", { class: "avp-hint", "data-avp": "mode-unavailable", text: t("nosim.short", "Validation and Comparison are disabled: this package has observed journey time only (subpath_sim_jt is absent or empty).") }));
    else if (runs.length < 2) body.append(el("p", { class: "avp-hint", "data-avp": "comparison-unavailable", text: t("comparison.disabled", "Comparison is disabled: at least two runs with simulated journey time are required.") }));
    mode.addEventListener("change", () => {
      this.viewMode = mode.value;
      if (this.viewMode !== VIEW_JT) this.overlay.remove();
      this.build();
      this.updateMap();
    });
    body.append(el("section", { class: "avp-section avp-mode", "data-avp": "mode-selector" }, el("label", { class: "avp-lbl" }, t("view.title", "View mode"), mode)));
    if (this.viewMode === VIEW_VALIDATION && this.simRows.length) {
      this.overlay.remove();
      this.renderValidation(body);
      return;
    }
    if (this.viewMode === VIEW_COMPARISON && new Set(this.simRows.map((r) => r.run).filter(Boolean)).size > 1) {
      this.overlay.remove(); this.renderComparison(body); return;
    }
    const info = this.sources.find((s) => s.source === this.source);

    // Source toggle (sources are never mixed)
    const toggle = el("fieldset", { class: "avp-section", "data-avp": "source" }, el("legend", { class: "avp-h", text: t("source.title", "Observed source") }));
    for (const s of this.sources) {
      const [k, def] = SOURCE_LABELS[s.source] ?? [`source.${s.source}`, s.source];
      const radio = el("input", { type: "radio", name: "avp-source", value: s.source, checked: s.source === this.source });
      radio.addEventListener("change", () => {
        this.source = s.source;
        this.routeKey = "";
        this.pickDefaults();
        this.renderBody();
        this.updateMap();
      });
      toggle.append(el("label", { class: "avp-inline" }, radio, `${t(k, def)} (${t("source.days", "{{n}} days", { n: s.days })}, ${s.first} - ${s.last})`));
    }
    toggle.append(el("p", { class: "avp-hint", text: t("source.never", "Sources are never mixed: every number below comes from the selected source only.") }));
    body.append(toggle, this.unitBanner());

    // Route picker
    const pairs = this.pairsOf(this.source);
    const matchedKeys = new Set(this.match?.matchedObs.map((m) => `${m.route}\u0000${m.direction}`));
    const sel = el("select", { class: "avp-select", "aria-label": t("route.title", "Route and direction"), "data-avp": "route" });
    for (const p of pairs) {
      const k = `${p.route}\u0000${p.direction}`;
      const tag = this.match ? (matchedKeys.has(k) ? "" : ` (${t("route.nomodel", "no model subpath")})`) : "";
      const o = el("option", { value: k, text: `${p.route} - ${p.direction}${tag}` });
      o.selected = k === this.routeKey;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      this.routeKey = sel.value;
      this.updateChart();
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

    // Time bucket + map
    body.append(this.mapSection(info));
    body.append(this.matchingSection());
    this.updateChart();
  }

  private unitBanner(): HTMLElement {
    const { t } = this.d;
    if (this.source === "monthly_15min") {
      return banner(
        "warn",
        t(
          "unit.monthly",
          "Unit unverified: the monthly file's Avg_traveltime column states no unit. Values are shown as seconds because their magnitude fits seconds (Al Ain Road median ~64 vs 84-86 s typical duration in the subnetwork file, still ~25% apart), not because the source says so. Confirm with the data owner.",
        ),
        { "data-avp": "unit-warning" },
      );
    }
    return banner("info", t("unit.other", "Unit: seconds."), { "data-avp": "unit-note" });
  }

  private mapSection(info: SourceInfo | undefined): HTMLElement {
    const { t } = this.d;
    const sec = el("section", { class: "avp-section", "data-avp": "map" }, el("h3", { class: "avp-h", text: t("map.title", "Map by time of day") }));
    if (!this.geo) {
      sec.append(
        banner(
          "warn",
          t(
            "map.degraded",
            "Chart-only mode: this package has no subpath geometry (subpaths.geojson), so there is no map layer and no name matching.",
          ),
          { "data-avp": "degraded" },
        ),
      );
      return sec;
    }
    void info;
    const slider = el("input", { type: "range", class: "avp-range", min: 0, max: 1440 / BUCKET - 1, step: 1, value: this.bucket / BUCKET, "aria-label": t("map.bucket", "Time bucket"), "data-avp": "bucket" });
    const label = el("b", { "data-avp": "bucket-label", text: bucketLabel(this.bucket) });
    slider.addEventListener("input", () => {
      this.bucket = Number(slider.value) * BUCKET;
      label.textContent = bucketLabel(this.bucket);
      this.updateChart();
      this.updateMap();
    });
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
      el("div", { class: "avp-row" }, el("span", { text: t("map.time", "Time") }), label, slider),
      el("div", { class: "avp-row" }, col),
      el("div", { class: "avp-legend", "data-avp": "legend" }, el("span", { "data-avp": "legend-min" }), el("div", { class: "avp-ramp" }), el("span", { "data-avp": "legend-max" })),
      el("p", { class: "avp-small", "data-avp": "overlay-note" }),
    );
    return sec;
  }

  private matchingSection(): HTMLElement {
    const { t } = this.d;
    const det = el("details", { class: "avp-details avp-section", "data-avp": "matching" });
    const m = this.match;
    if (!m) {
      det.append(el("summary", { text: t("match.title", "Name matching") }), el("p", { class: "avp-hint", text: t("match.none", "Needs subpath geometry (names) in the package.") }));
      return det;
    }
    const c = m.counts;
    det.dataset.obsMatched = String(c.obsMatched);
    det.dataset.obsTotal = String(c.obsTotal);
    det.dataset.subpathsMatched = String(c.subpathsMatched);
    det.dataset.subpathsTotal = String(c.subpathsTotal);
    det.dataset.subpathsUnmatched = String(c.subpathsUnmatched);
    det.dataset.subpathsDropped = String(c.subpathsDroppedDuplicate);
    det.append(
      el("summary", {
        "data-avp": "match-summary",
        text: t("match.summary", "Name matching: {{om}} of {{ot}} observed routes matched; {{sm}} of {{st}} model subpaths matched ({{sn}} not in this scenario, {{sd}} duplicates dropped)", {
          om: c.obsMatched, ot: c.obsTotal, sm: c.subpathsMatched, st: c.subpathsTotal, sn: c.subpathsNotInScenario, sd: c.subpathsDroppedDuplicate,
        }),
      }),
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
          r.direction,
          r.matches.map((x) => `${x.subpath.name} [${x.subpath.group ?? "-"}]`).join("; "),
          r.matches[0].via + (r.dropped.length ? `; ${t("match.pref", "only group '{{g}}' used", { g: PREFERRED_GROUP })}` : ""),
          r.dropped.map((x) => `${x.subpath.name} [${x.subpath.group ?? "-"}]`).join("; "),
        ]),
        "matched-table",
      ),
      el("h4", { class: "avp-h", "data-avp": "unmatched-obs-title", text: t("match.unmatchedObs", "Unmatched observed routes ({{n}})", { n: c.obsUnmatched }) }),
      mk([t("col.route", "Route"), t("col.dir", "Dir")], m.unmatchedObs.map((r) => [r.route, r.direction]), "unmatched-obs"),
      el("h4", { class: "avp-h", "data-avp": "unmatched-sp-title", text: t("match.unmatchedSp", "Unmatched model subpaths ({{n}})", { n: c.subpathsUnmatched }) }),
      mk(
        [t("col.subpath", "Subpath"), t("col.group", "Group"), t("col.reason", "Reason")],
        m.unmatchedSubpaths.map((u) => [
          u.subpath.name,
          u.subpath.group ?? "-",
          u.reason === "not-in-scenario"
            ? t("reason.scenario", "not in this run's scenario")
            : u.reason === "no-direction-suffix"
              ? t("reason.nosuffix", "no direction suffix")
              : t("reason.noobs", "no observed route with this name+direction"),
        ]),
        "unmatched-subpaths",
      ),
    );
    return det;
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
          { label: t("stat.medianShort", "Observed median across days"), points: p.median, color: "hsl(var(--primary))" },
          ...simSeries,
        ],
        band: { label: t("chart.band", "Observed min-max across days"), points: p.band },
        simWindow,
        vline: this.geo ? this.bucket : null,
        xMin: 0,
        xMax: 1440,
        xTitle: t("chart.x", "Time of day"),
        yTitle: t("chart.y", "Journey time (s)"),
      }),
    );
    chart.dataset.testid = "day-profile";
    chart.dataset.points = String(p.mean.filter((x) => x.y !== null).length);
    const at = this.rows.find((r) => r.source === this.source && r.route === route && r.direction_norm === dir && r.bucket_start_min === this.bucket);
    readout.textContent = at
      ? t("readout", "{{time}}: observed median {{median}} s (mean {{mean}} s), range {{lo}}-{{hi}} s over {{n}} days", {
          time: bucketLabel(this.bucket), mean: fmt(at.mean_s), median: fmt(at.median_s), lo: fmt(at.min_s), hi: fmt(at.max_s), n: at.n_days,
        })
      : t("readout.none", "{{time}}: no observation for this bucket", { time: bucketLabel(this.bucket) });
    void info;
  }

  private currentFeatures(): GeoJSONFC | null {
    if (!this.geo || !this.match) return null;
    if (this.viewMode === VIEW_VALIDATION || this.viewMode === VIEW_COMPARISON) {
      const fc: GeoJSONFC = { type: "FeatureCollection", features: [] };
      const geometry = new Map(this.geo.features.map((f, i) => [String((f.properties?.id as string | number | undefined) ?? f.id ?? i), f.geometry]));
      const add = (rows: ReturnType<typeof perRoute>, statusOverride?: Map<string, string>, extras?: Map<string, Record<string, unknown>>): void => {
        const byKey = new Map(rows.map((r) => [r.key, r]));
        for (const route of this.match!.matchedObs) for (const match of route.matches) {
          const item = byKey.get(route.key ?? "");
          const status = statusOverride?.get(route.key ?? "") ?? item?.status ?? "only";
          const color = status === "pass" || status === "improved" ? STATUS_COLORS.pass : status === "warn" ? STATUS_COLORS.warn : status === "fail" || status === "degraded" ? STATUS_COLORS.fail : "#888888";
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
      if (this.viewMode === VIEW_VALIDATION) add(perRoute(this.validationPairing().pairs, this.criteria));
      else {
        const a = perRoute(this.validationPairing(this.comparisonA).pairs, this.criteria), b = perRoute(this.validationPairing(this.comparisonB).pairs, this.criteria);
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
      this.overlay.remove();
      return;
    }
    if (!fc.features.length) {
      this.overlay.remove();
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
    if (!this.fitted) {
      const b = featuresBounds(fc);
      if (b) this.d.getApp()?.fitBounds?.(b);
      this.fitted = true;
    }
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
      el("p", { class: "avp-hint", text: t("profile.days", "{{n}} observed days; hover for time and value.", { n: p.nDaysMax }) }), chart));
  }

  private renderValidation(body: HTMLElement): void {
    const { t } = this.d;
    const redraw = (): void => { this.renderBody(); };
    const source = el("select", { class: "avp-select", attrs: { "data-testid": "validation-source", "aria-label": t("source.title", "Observed source") } });
    for (const item of this.sources) { const option = el("option", { value: item.source, text: t(...(SOURCE_LABELS[item.source] ?? [`source.${item.source}`, item.source])) }); option.selected = item.source === this.source; source.append(option); }
    source.addEventListener("change", () => { this.source = source.value; this.pickDefaults(); this.renderBody(); });
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
    body.append(el("section", { class: "avp-section", attrs: { "data-testid": "validation-controls" } },
      el("div", { class: "avp-row" }, el("label", { class: "avp-lbl" }, t("source.title", "Observed source"), source),
        el("label", { class: "avp-lbl" }, t("window.title", "Time window"), el("span", { class: "avp-row" }, from, to))),
      el("p", { class: "avp-hint", text: t("source.never", "Sources are never mixed; the observed typical-day median is paired over the selected time window.") })));
    body.append(this.criteriaSection(redraw));
    const pairing = this.validationPairing();
    const rows = perRoute(pairing.pairs, this.criteria);
    if (!rows.length) {
      body.append(banner("warn", t("validation.none", "Validation is disabled: this package contains no simulated JT segments overlapping the selected source and time window."), { "data-testid": "validation-disabled" }));
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
    const pairByRun = new Map(runs.map((r) => [r, perRoute(this.validationPairing(r).pairs, this.criteria)]));
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
