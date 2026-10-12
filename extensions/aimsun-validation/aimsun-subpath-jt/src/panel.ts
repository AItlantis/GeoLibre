/**
 * Observed subpath journey time panel: package picker, route/direction picker, source toggle,
 * time-of-day profile (mean / median / min-max band across days), name-matching report and a map
 * overlay coloured by the selected 15-min bucket. Observed data only (no simulated JT exists).
 */
import type { DuckDbHandle } from "../../_shared/src/duckdb";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql";
import { mountChart } from "../../_shared/src/charts";
import type { GeoJSONFC, HostApp } from "./common/host";
import type { Translator } from "./common/i18n";
import { lineSvg } from "./common/lineSvg";
import { buildMatching, PREFERRED_GROUP, type MatchResult, type ObsPair } from "./common/match";
import { MapOverlay } from "./common/overlay";
import { loadFromFiles, loadFromManifestUrl, subpathRefs, type PackageSummary } from "./common/pkg";
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
} from "./common/profile";
import { openSession, sqlStr, type Session } from "./common/session";
import { banner, clear, el, fmt, packageBar, type PackageBar } from "./common/ui";

export const PLUGIN_ID = "aimsun-subpath-jt";
const BUCKET = 15;

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
}

export class JtController {
  private session: Session | null = null;
  private disposed = false;
  private pkg: PackageSummary | null = null;
  private rows: ObsRow[] = [];
  private sources: SourceInfo[] = [];
  private source = "";
  private routeKey = "";
  private stat: Stat = "mean";
  private bucket = 480;
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
      const opened = this.session ?? (await openSession(h, "aimsun_subpath_jt"));
      if (this.disposed) {
        await opened.dispose(); // deactivated while the session was opening: nothing may outlive the plugin
        return;
      }
      this.session = opened;
      const s = opened;
      const pkg = await fn(s);
      if (!pkg.hasObs) throw new Error(t("err.noObs", "This package has no observed journey-time table (subpath_obs_jt)."));
      await s.exec(buildSubpathSql({ bucketMinutes: BUCKET }));
      this.rows = toObsRows(await s.query("SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
      this.sources = (
        await s.query<{ source: string; nd: number; d0: string; d1: string }>(
          "SELECT source, COUNT(DISTINCT day) AS nd, CAST(MIN(day) AS VARCHAR) AS d0, CAST(MAX(day) AS VARCHAR) AS d1 FROM v_sp_obs_day GROUP BY source ORDER BY source",
        )
      ).map((r) => ({ source: String(r.source), days: Number(r.nd), first: String(r.d0), last: String(r.d1) }));
      this.pkg = pkg;
      this.geo = pkg.geo;
      this.source = this.sources[0]?.source ?? "";
      this.fitted = false;
      this.routeKey = "";
      this.pickDefaults();
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
    const snap = el("button", { type: "button", class: "avp-btn avp-secondary", text: t("map.snapshot", "Add snapshot to Layers"), "data-avp": "snapshot" });
    snap.addEventListener("click", () => this.snapshot());
    sec.append(
      el("div", { class: "avp-row" }, el("span", { text: t("map.time", "Time") }), label, slider),
      el("div", { class: "avp-row" }, col, snap),
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
    mountChart(
      chart,
      lineSvg({
        label: t("chart.aria", "Observed journey time profile of {{r}} {{d}}", { r: route ?? "", d: dir ?? "" }),
        series: [
          { label: t("stat.meanShort", "mean"), points: p.mean },
          { label: t("stat.medianShort", "median"), points: p.median, dash: "5 3" },
        ],
        band: { label: t("chart.band", "min-max across days"), points: p.band },
        vline: this.geo ? this.bucket : null,
        xMin: 0,
        xMax: 1440,
        xTitle: t("chart.x", "Time of day"),
        yTitle: t("chart.y", "Journey time (s)"),
      }),
    );
    chart.dataset.points = String(p.mean.filter((x) => x.y !== null).length);
    const at = this.rows.find((r) => r.source === this.source && r.route === route && r.direction_norm === dir && r.bucket_start_min === this.bucket);
    readout.textContent = at
      ? t("readout", "{{time}}: mean {{mean}} s, median {{median}} s, range {{lo}}-{{hi}} s over {{n}} days", {
          time: bucketLabel(this.bucket), mean: fmt(at.mean_s), median: fmt(at.median_s), lo: fmt(at.min_s), hi: fmt(at.max_s), n: at.n_days,
        })
      : t("readout.none", "{{time}}: no observation for this bucket", { time: bucketLabel(this.bucket) });
    void info;
  }

  private currentFeatures(): GeoJSONFC | null {
    if (!this.geo || !this.match) return null;
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
      note(t("map.noMap", "No 2D map on this renderer: use \"Add snapshot to Layers\"."));
      return;
    }
    note(t("map.drawn", "{{n}} subpath lines drawn for {{time}} (plugin overlay; use the snapshot button to keep it as a layer).", { n: fc.features.length, time: bucketLabel(this.bucket) }));
    if (!this.fitted) {
      const b = featuresBounds(fc);
      if (b) this.d.getApp()?.fitBounds?.(b);
      this.fitted = true;
    }
  }

  snapshot(): void {
    const fc = this.currentFeatures();
    const app = this.d.getApp();
    if (!fc || !fc.features.length || !app) return;
    const name = this.d.t("snapshot.name", "Observed journey time {{src}} {{time}}", { src: this.source, time: bucketLabel(this.bucket) });
    app.addGeoJsonLayer(name, fc);
  }

  /** Test/diagnostic view of the controller state. */
  debug(): Record<string, unknown> {
    return { source: this.source, routeKey: this.routeKey, bucket: this.bucket, counts: this.match?.counts ?? null, overlayNote: this.overlayNote };
  }
}
