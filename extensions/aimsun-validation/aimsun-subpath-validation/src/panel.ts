/**
 * Simulated-vs-observed subpath journey time validation panel.
 * Fully driven by the optional table `subpath_sim_jt`; without it the panel shows a clear
 * "no simulated journey time in this package" state (this delivery has none).
 */
import type { DuckDbHandle } from "../../_shared/src/duckdb";
import { mountChart, scatterSvg } from "../../_shared/src/charts";
import { buildSubpathSql } from "../../_shared/src/sql/subpath.sql";
import type { Translator } from "../../aimsun-subpath-jt/src/common/i18n";
import type { HostApp } from "../../aimsun-subpath-jt/src/common/host";
import { lineSvg } from "../../aimsun-subpath-jt/src/common/lineSvg";
import { pairKey } from "../../aimsun-subpath-jt/src/common/match";
import { loadFromFiles, loadFromManifestUrl, type PackageSummary } from "../../aimsun-subpath-jt/src/common/pkg";
import { bucketLabel, toObsRows, type ObsRow, type Stat } from "../../aimsun-subpath-jt/src/common/profile";
import { openSession, type Session } from "../../aimsun-subpath-jt/src/common/session";
import { banner, clear, el, fmt, packageBar, type PackageBar } from "../../aimsun-subpath-jt/src/common/ui";
import { buildSimSql, classifyTsType, missingSimColumns } from "./simtable";
import { kpis, pairObsSim, perRoute, points, type Level, type PairingResult, type RouteRow, type SimRow, type Window } from "./validation";

export const PLUGIN_ID = "aimsun-subpath-validation";

const pad = (n: number): string => String(n).padStart(2, "0");
const toTime = (m: number): string => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fromTime = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export interface Deps {
  getApp: () => HostApp | null;
  getDuck: () => Promise<DuckDbHandle>;
  t: Translator;
}

type SortKey = "route" | "obs" | "sim" | "delta" | "ratio";

export class ValidationController {
  private session: Session | null = null;
  private disposed = false;
  private pkg: PackageSummary | null = null;
  private obsRows: ObsRow[] = [];
  private simRows: SimRow[] = [];
  private sources: string[] = [];
  private source = "";
  private stat: Stat = "mean";
  private bucketMin = 15;
  private tol = 15;
  private level: Level = "route";
  private win: Window | null = null;
  private winTouched = false;
  private selected = "";
  private sort: { key: SortKey; dir: 1 | -1 } = { key: "route", dir: 1 };
  private tsKind = "";
  private busy = false;
  private error: string | null = null;
  private status = "";
  private lastUrl = "";
  private root: HTMLElement | null = null;
  private bar: PackageBar | null = null;
  private body: HTMLElement | null = null;
  private results: HTMLElement | null = null;

  constructor(private readonly d: Deps) {}

  mount(container: HTMLElement): () => void {
    this.root = el("div", { class: "avp-root", "data-avp-plugin": PLUGIN_ID });
    container.append(this.root);
    this.build();
    return () => {
      this.root?.remove();
      this.root = this.bar = this.body = this.results = null;
    };
  }

  dispose(): void {
    this.disposed = true;
    void this.session?.dispose(); // drops this panel's tables/views, detaches its catalog, closes its connection
    this.session = null;
  }

  private stateName(): string {
    if (this.error) return "error";
    if (this.busy) return "loading";
    if (!this.pkg) return "empty";
    return this.pkg.hasSim ? "ready" : "no-sim";
  }

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
    this.bar.setStatus(this.status, this.error ? "error" : this.busy ? "busy" : "info");
    this.body = el("div", { class: "avp-body", "data-avp-state": this.stateName() });
    this.root.append(this.bar.root, this.body);
    this.renderBody();
  }

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
      const h = await this.d.getDuck();
      if (this.disposed) return;
      const opened = this.session ?? (await openSession(h, "aimsun_subpath_validation"));
      if (this.disposed) {
        await opened.dispose(); // deactivated while the session was opening: nothing may outlive the plugin
        return;
      }
      this.session = opened;
      const s = opened;
      const pkg = await fn(s);
      if (!pkg.hasObs) throw new Error(t("err.noObs", "This package has no observed journey-time table (subpath_obs_jt)."));
      this.tsKind = "";
      if (pkg.hasSim) {
        const cols = (await s.query<{ column_name: string; column_type: string }>("DESCRIBE subpath_sim_jt")).map((c) => ({ name: String(c.column_name), type: String(c.column_type) }));
        const missing = missingSimColumns(cols.map((c) => c.name));
        if (missing.length) throw new Error(t("err.simCols", "subpath_sim_jt is missing column(s): {{c}}. Expected route, direction_norm, ts_bucket, seconds.", { c: missing.join(", ") }));
        const kind = classifyTsType(cols.find((c) => c.name.toLowerCase() === "ts_bucket")!.type);
        if (!kind) throw new Error(t("err.simTs", "subpath_sim_jt.ts_bucket has an unsupported type (use TIMESTAMP, TIME, 'HH:MM' text or numeric minutes since midnight)."));
        this.tsKind = kind;
      }
      this.pkg = pkg;
      this.winTouched = false;
      this.selected = "";
      await this.reloadViews();
      this.status = t("status.loaded", "Loaded package from {{origin}}.", { origin: pkg.origin });
    } catch (e) {
      this.pkg = null;
      this.obsRows = [];
      this.simRows = [];
      this.error = e instanceof Error ? e.message : String(e);
      this.status = this.error;
    } finally {
      this.busy = false;
      this.build();
    }
  }

  /** (Re)build the views for the current bucket size and pull the rows into memory. */
  private async reloadViews(): Promise<void> {
    const s = this.session;
    if (!s || !this.pkg) return;
    await s.exec(buildSubpathSql({ bucketMinutes: this.bucketMin }));
    this.obsRows = toObsRows(await s.query("SELECT * FROM v_sp_obs ORDER BY source, route, direction_norm, bucket_start_min"));
    this.sources = [...new Set(this.obsRows.map((r) => r.source))].sort();
    if (!this.sources.includes(this.source)) this.source = this.sources[0] ?? "";
    this.simRows = [];
    if (this.pkg.hasSim) {
      await s.exec(buildSimSql(this.bucketMin, this.tsKind as "temporal" | "numeric" | "text"));
      this.simRows = (await s.query("SELECT route, direction_norm, bucket_start_min, sim_s, n FROM v_sp_sim ORDER BY 1, 2, 3")).map((r) => ({
        route: String(r.route),
        direction_norm: String(r.direction_norm),
        bucket_start_min: Number(r.bucket_start_min),
        sim_s: Number(r.sim_s),
        n: Number(r.n),
      }));
      if (!this.winTouched && this.simRows.length) {
        const bs = this.simRows.map((r) => r.bucket_start_min);
        this.win = { from: Math.min(...bs), to: Math.max(...bs) + this.bucketMin };
      }
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
    if (!this.pkg.hasSim) {
      body.append(this.noSimState());
      return;
    }
    body.append(this.controls());
    this.results = el("div", { class: "avp-results", "data-avp": "results" });
    body.append(this.results);
    this.renderResults();
  }

  private noSimState(): HTMLElement {
    const { t } = this.d;
    const nObs = new Set(this.obsRows.map((r) => `${r.source}|${r.route}|${r.direction_norm}`)).size;
    return el(
      "section",
      { class: "avp-section", "data-avp": "no-sim" },
      banner(
        "warn",
        t("nosim.title", "No simulated journey time in this package."),
        { "data-avp": "no-sim-banner" },
      ),
      el("p", {
        class: "avp-hint",
        text: t(
          "nosim.body",
          "Nothing can be validated yet: the model delivery has no simulated subpath journey time (the results database has no subpath table and the journey-time column of the model is 0 for every subpath). This panel switches on by itself as soon as the package contains subpath_sim_jt.parquet with the columns route, direction_norm, ts_bucket, seconds.",
        ),
      }),
      el("p", { class: "avp-small", "data-avp": "obs-summary", text: t("nosim.obs", "Observed side is present: {{n}} route/direction/source series are available in the observed journey-time panel.", { n: nObs }) }),
    );
  }

  private controls(): HTMLElement {
    const { t } = this.d;
    const sec = el("section", { class: "avp-section", "data-avp": "controls" }, el("h3", { class: "avp-h", text: t("ctl.title", "Comparison settings") }));
    const sel = <T extends string>(attr: string, aria: string, opts: ReadonlyArray<readonly [T, string]>, cur: T, on: (v: T) => void): HTMLSelectElement => {
      const s = el("select", { class: "avp-select", "aria-label": aria, "data-avp": attr });
      for (const [v, text] of opts) {
        const o = el("option", { value: v, text });
        o.selected = v === cur;
        s.append(o);
      }
      s.addEventListener("change", () => on(s.value as T));
      return s;
    };
    const srcSel = sel("source", t("ctl.source", "Observed source"), this.sources.map((s) => [s, s] as const), this.source, (v) => {
      this.source = v;
      this.selected = "";
      this.renderResults();
    });
    const statSel = sel("stat", t("ctl.stat", "Observed statistic"), [["mean", t("stat.mean", "Mean across days")], ["median", t("stat.median", "Median across days")]] as const, this.stat, (v) => {
      this.stat = v;
      this.renderResults();
    });
    const bucketSel = sel("bucket", t("ctl.bucket", "Time bucket"), [["15", "15 min"], ["30", "30 min"], ["60", "60 min"]] as const, String(this.bucketMin), (v) => {
      this.bucketMin = Number(v);
      void this.reloadViews().then(() => this.renderResults());
    });
    const levelSel = sel("level", t("ctl.level", "Points"), [["route", t("level.route", "One per route (window mean)")], ["bucket", t("level.bucket", "One per route and bucket")]] as const, this.level, (v) => {
      this.level = v;
      this.renderResults();
    });
    const tol = el("input", { type: "number", class: "avp-input avp-num", min: 1, max: 100, step: 1, value: this.tol, "aria-label": t("ctl.tol", "Tolerance (%)"), "data-avp": "tolerance" });
    tol.addEventListener("input", () => {
      const v = Number(tol.value);
      if (v > 0) {
        this.tol = v;
        this.renderResults();
      }
    });
    const win = this.win ?? { from: 0, to: 1440 };
    const from = el("input", { type: "time", class: "avp-input", value: toTime(win.from), "aria-label": t("ctl.from", "From"), "data-avp": "win-from" });
    const to = el("input", { type: "time", class: "avp-input", value: toTime(win.to % 1440), "aria-label": t("ctl.to", "To"), "data-avp": "win-to" });
    const onWin = (): void => {
      const a = fromTime(from.value);
      let b = fromTime(to.value);
      if (a === null || b === null) return;
      if (b <= a) b = b === 0 ? 1440 : b;
      this.win = { from: a, to: b };
      this.winTouched = true;
      this.renderResults();
    };
    from.addEventListener("change", onWin);
    to.addEventListener("change", onWin);
    const lbl = (text: string, ...c: HTMLElement[]) => el("label", { class: "avp-lbl" }, text, ...c);
    sec.append(
      el("div", { class: "avp-row" }, lbl(t("ctl.source", "Observed source"), srcSel), lbl(t("ctl.stat", "Observed statistic"), statSel)),
      el("div", { class: "avp-row" }, lbl(t("ctl.bucket", "Time bucket"), bucketSel), lbl(t("ctl.level", "Points"), levelSel)),
      el("div", { class: "avp-row" }, lbl(t("ctl.window", "Time window"), el("span", { class: "avp-row" }, from, to)), lbl(t("ctl.tol", "Tolerance (%)"), tol)),
    );
    return sec;
  }

  private compute(): { pairing: PairingResult; rows: RouteRow[] } {
    const win: Window | null = this.win;
    const obs = this.obsRows.filter((r) => r.source === this.source);
    const pairing = pairObsSim(obs, this.simRows, this.stat, win);
    return { pairing, rows: perRoute(pairing.pairs) };
  }

  private renderResults(): void {
    const box = this.results;
    if (!box) return;
    const { t } = this.d;
    clear(box);
    const { pairing, rows } = this.compute();
    if (this.source === "monthly_15min") {
      box.append(
        banner(
          "warn",
          t("unit.monthly", "Unit unverified: the monthly file's Avg_traveltime column states no unit; it is treated as seconds (magnitude fits seconds) and compared with the simulated seconds as-is. Confirm with the data owner."),
          { "data-avp": "unit-warning" },
        ),
      );
    }
    if (!pairing.pairs.length) {
      box.append(
        banner("warn", t("res.none", "No observed/simulated pair overlaps in this window and bucket size. Check the route names (obs-only: {{o}}, sim-only: {{s}}) and the time window.", { o: pairing.obsOnly.length, s: pairing.simOnly.length }), { "data-avp": "no-pairs" }),
        this.unmatchedBlock(pairing),
      );
      return;
    }
    const pts = points(pairing.pairs, this.level);
    const k = kpis(pts.obs, pts.sim, this.tol);
    box.dataset.n = String(k.count);
    const kpi = (id: string, name: string, value: string, raw: number | null): HTMLElement => {
      const e = el("div", { class: "avp-kpi", "data-kpi": id, "data-value": raw === null ? "" : String(raw) }, el("b", { text: value }), el("span", { text: name }));
      return e;
    };
    box.append(
      el(
        "div",
        { class: "avp-kpis", "data-avp": "kpis" },
        kpi("n", t("kpi.n", "points"), String(k.count), k.count),
        kpi("rmse", t("kpi.rmse", "RMSE (s)"), fmt(k.rmse), k.rmse),
        kpi("bias", t("kpi.bias", "bias sim-obs (s)"), fmt(k.bias), k.bias),
        kpi("r2", t("kpi.r2", "R2 (OLS)"), fmt(k.r2, 3), k.r2),
        kpi("slope", t("kpi.slope", "slope"), fmt(k.slope, 3), k.slope),
        kpi("within", t("kpi.within", "within +-{{x}}%", { x: this.tol }), `${fmt(k.pctWithin)}%`, k.pctWithin),
        kpi("ratio", t("kpi.ratio", "mean sim/obs"), fmt(k.meanRatio, 3), k.meanRatio),
      ),
    );
    const chart = el("div", { class: "avp-chart", "data-avp": "scatter" });
    mountChart(
      chart,
      scatterSvg(pts.obs, pts.sim, {
        label: t("scatter.aria", "Simulated versus observed journey time"),
        xTitle: t("scatter.x", "Observed (s)"),
        yTitle: t("scatter.y", "Simulated (s)"),
        identityLine: true,
        trend: k.slope !== null && k.intercept !== null ? { slope: k.slope, intercept: k.intercept } : null,
      }),
    );
    chart.dataset.points = String(pts.obs.length);
    box.append(el("section", { class: "avp-section" }, el("h3", { class: "avp-h", text: t("scatter.title", "Simulated vs observed (dashed: y = x, solid: OLS)") }), chart));

    // Per-route table
    const dir = this.sort.dir;
    const val = (r: RouteRow): number | string => (this.sort.key === "route" ? `${r.route} ${r.direction}` : (r[this.sort.key] ?? -Infinity));
    const sorted = [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir;
    });
    const th = (key: SortKey, text: string, num = true): HTMLElement => {
      const h = el("th", { class: num ? "avp-n" : "", "data-sort": key, text: text + (this.sort.key === key ? (dir === 1 ? " ^" : " v") : "") });
      h.addEventListener("click", () => {
        this.sort = { key, dir: this.sort.key === key && this.sort.dir === 1 ? -1 : 1 };
        this.renderResults();
      });
      return h;
    };
    const tbody = el("tbody");
    const tolR = this.tol / 100;
    for (const r of sorted) {
      const ok = r.ratio !== null && Math.abs(r.ratio - 1) <= tolR + 1e-12;
      const tr = el(
        "tr",
        { "data-clickable": "true", "data-selected": String(r.key === this.selected), "data-key": r.key, "data-within": String(ok) },
        el("td", { text: `${r.route} - ${r.direction}` }),
        el("td", { class: "avp-n", text: String(r.nBuckets) }),
        el("td", { class: "avp-n", "data-col": "obs", text: fmt(r.obs) }),
        el("td", { class: "avp-n", "data-col": "sim", text: fmt(r.sim) }),
        el("td", { class: "avp-n", "data-col": "delta", text: fmt(r.delta) }),
        el("td", { class: "avp-n", "data-col": "ratio", text: fmt(r.ratio, 3) }),
        el("td", { text: ok ? t("tbl.ok", "within") : t("tbl.out", "outside") }),
      );
      tr.addEventListener("click", () => {
        this.selected = this.selected === r.key ? "" : r.key;
        this.renderResults();
      });
      tbody.append(tr);
    }
    box.append(
      el(
        "section",
        { class: "avp-section", "data-avp": "route-table" },
        el("h3", { class: "avp-h", text: t("tbl.title", "Per route (mean over the paired buckets)") }),
        el(
          "div",
          { class: "avp-table-wrap" },
          el(
            "table",
            { class: "avp-table" },
            el("thead", {}, el("tr", {}, th("route", t("tbl.route", "Route - dir"), false), el("th", { class: "avp-n", text: t("tbl.n", "buckets") }), th("obs", t("tbl.obs", "obs (s)")), th("sim", t("tbl.sim", "sim (s)")), th("delta", t("tbl.delta", "delta (s)")), th("ratio", t("tbl.ratio", "sim/obs")), el("th", { text: `+-${this.tol}%` }))),
            tbody,
          ),
        ),
      ),
    );
    const prof = this.profileSection();
    if (prof) box.append(prof);
    box.append(this.unmatchedBlock(pairing));
  }

  private profileSection(): HTMLElement | null {
    if (!this.selected) return null;
    const { t } = this.d;
    const obs = this.obsRows.filter((r) => r.source === this.source && pairKey(r.route, r.direction_norm) === this.selected);
    const sim = this.simRows.filter((r) => pairKey(r.route, r.direction_norm) === this.selected);
    if (!obs.length) return null;
    const pick = (r: ObsRow): number | null => (this.stat === "mean" ? r.mean_s : r.median_s);
    const win = this.win ?? { from: 0, to: 1440 };
    const chart = el("div", { class: "avp-chart", "data-avp": "profile-chart" });
    mountChart(
      chart,
      lineSvg({
        label: t("profile.aria", "Observed and simulated profile"),
        series: [
          { label: t("profile.obs", "observed"), points: obs.map((r) => ({ x: r.bucket_start_min, y: pick(r) })) },
          { label: t("profile.sim", "simulated"), points: sim.map((r) => ({ x: r.bucket_start_min, y: r.sim_s })) },
        ],
        band: { label: t("chart.band", "observed min-max across days"), points: obs.map((r) => ({ x: r.bucket_start_min, lo: r.min_s, hi: r.max_s })) },
        xMin: win.from,
        xMax: win.to,
        xTicks: undefined,
        xTitle: t("chart.x", "Time of day"),
        yTitle: t("chart.y", "Journey time (s)"),
        gapFactor: 1.5,
      }),
    );
    void bucketLabel;
    return el("section", { class: "avp-section", "data-avp": "profile" }, el("h3", { class: "avp-h", text: t("profile.title", "Profile of the selected route") }), chart);
  }


  private unmatchedBlock(p: PairingResult): HTMLElement {
    const { t } = this.d;
    const det = el("details", { class: "avp-details avp-section", "data-avp": "unmatched", "data-obs-only": String(p.obsOnly.length), "data-sim-only": String(p.simOnly.length), "data-no-overlap": String(p.noOverlap.length) });
    det.append(el("summary", { text: t("unm.title", "Not compared: {{o}} observed-only, {{s}} simulated-only, {{n}} without overlap", { o: p.obsOnly.length, s: p.simOnly.length, n: p.noOverlap.length }) }));
    const list = (title: string, items: string[]): void => {
      det.append(el("h4", { class: "avp-h", text: `${title} (${items.length})` }), el("p", { class: "avp-small", text: items.length ? items.join("; ") : "-" }));
    };
    list(t("unm.obs", "Observed routes without simulated data"), p.obsOnly);
    list(t("unm.sim", "Simulated routes without observed data"), p.simOnly);
    list(t("unm.none", "Matched but no common bucket in the window"), p.noOverlap);
    return det;
  }
}
