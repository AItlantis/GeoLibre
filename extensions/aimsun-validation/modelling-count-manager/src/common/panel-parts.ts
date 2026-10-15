/** Panel building blocks shared by both detector plugins (plain DOM). */
import type { DetAgg, SortKey } from "./aggregate.ts";
import type { DetController } from "./controller.ts";
import type { AppLike } from "./host.ts";
import { locateOid } from "./geo.ts";
import { filesFromInput } from "./package-source.ts";
import { durationLabel, OBS_SOURCES, WHOLE_PERIOD, type LegacyObsSource, type ResolvedSource } from "./sql.ts";
import { minToLabel, TIME_STEPS } from "./state.ts";
import { hostLabel, packageUiPlan } from "../../../_shared/src/host-managed.ts";
import { el, field, selectEl, STATUS_COLORS, type Translate, makeFormat } from "./ui.ts";

export interface Ctx {
  app: AppLike;
  t: Translate;
  fmt: ReturnType<typeof makeFormat>;
  ctl: DetController;
}

const STORE_KEY = "aimsun-validation:last-package-url";

function store(op: "get" | "set", v?: string): string {
  try {
    if (op === "set") localStorage.setItem(STORE_KEY, v ?? "");
    else return localStorage.getItem(STORE_KEY) ?? "";
  } catch {
    /* storage can be blocked: the panel works without it */
  }
  return "";
}

/** Folder picker + manifest URL box. Persistent (not re-rendered) so typed text survives. */
export function packageSection(ctx: Ctx, initialUrl?: string): { root: HTMLElement; setUrl: (u: string) => void } {
  const { t, ctl } = ctx;
  const url = el("input", {
    class: "av-input av-grow",
    attrs: { type: "url", placeholder: "https://…/manifest.json", "aria-label": t("pkg.url", "Package manifest URL"), dir: "ltr" },
  });
  url.value = initialUrl ?? store("get");
  const input = el("input", { attrs: { type: "file", webkitdirectory: "", multiple: "", hidden: "" } });
  input.addEventListener("change", () => {
    const files = input.files ? filesFromInput(input.files) : [];
    if (!files.length) return;
    const first = files[0].path.split("/")[0] || "folder";
    void ctl.loadFiles(files, first);
    input.value = "";
  });
  const load = (): void => {
    const v = url.value.trim();
    if (!v) return;
    store("set", v);
    void ctl.loadUrl(v);
  };
  url.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") load();
  });
  const root = el("section", { class: "av-section" }, [
    el("div", { class: "av-row" }, [
      el("button", { class: "av-btn", text: t("pkg.pickFolder", "Open package folder…"), attrs: { type: "button" }, on: { click: () => input.click() } }),
      input,
    ]),
    el("div", { class: "av-row" }, [
      url,
      el("button", { class: "av-btn", text: t("pkg.load", "Load"), attrs: { type: "button" }, on: { click: load } }),
    ]),
    el("p", {
      class: "av-hint",
      text: t("pkg.hint", "Choose the package folder (it holds <RUN>/detectors_sim.parquet; detectors_obs.parquet enables Validation) or paste a manifest URL. A ?aimsunPackage=<manifest url> parameter loads it automatically."),
    }),
  ]);
  return { root, setUrl: (u) => (url.value = u) };
}

/** Loading / error / source banner (re-rendered). */
export function statusBanner(ctx: Ctx, hostManaged = false): HTMLElement {
  const { t, ctl } = ctx;
  const s = ctl.state;
  const box = el("div", { class: "av-status" });
  if (s.phase === "error") box.append(el("p", { class: "av-alert av-bad", text: s.error ?? t("err.generic", "Something went wrong."), attrs: { role: "alert" } }));
  else if (s.phase === "loading" || s.busy) box.append(el("p", { class: "av-hint", text: t("status.loading", "Loading…"), attrs: { role: "status" } }));
  if (hostManaged) {
    const label = hostLabel(s.sourceLabel, s.run, t);
    if (label && s.phase !== "empty") box.append(el("p", { class: "av-hint", text: label, attrs: { "data-testid": "host-label" } }));
  } else if (s.sourceLabel && s.phase !== "empty") box.append(el("p", { class: "av-hint", text: t("pkg.source", "Package: {{label}}", { label: s.sourceLabel }) }));
  return box;
}

/** Run, observed source, time window, bucket. */
export function controlsSection(ctx: Ctx, hostManaged = false): HTMLElement {
  const { t, ctl } = ctx;
  const ui = packageUiPlan(hostManaged);
  const s = ctl.state;
  if (s.phase === "empty" || s.phase === "error" || !s.runs.length) return el("div");
  const disabled = s.phase === "loading";
  const run = selectEl(s.runs.map((r) => ({ value: r, label: r })), s.run ?? "", (v) => void ctl.selectRun(v), { "aria-label": t("ctl.run", "Run") });
  const srcLabels: Record<LegacyObsSource, string> = {
    validation: t("ctl.obs.validation", "Validation"),
    calibration: t("ctl.obs.calibration", "Calibration"),
    both: t("ctl.obs.both", "Both"),
  };
  // v2 packages: one option per source_id (+ 'all comparable' when homogeneous); legacy packages: the three fixed files
  const sourceLabel = (src: ResolvedSource): string =>
    src.sourceId + (src.file && src.file !== src.sourceId ? ` (${src.file})` : "") + (src.effective === "profile-only" ? ` - ${t("ctl.obs.profileOnly", "profile only")}` : "");
  const choices = ctl.obsSourceChoices();
  const obsOptions = choices
    ? choices.map((c) => ({ value: c.value, label: c.kind === "all" ? t("ctl.obs.all", "All comparable sources") : sourceLabel(c.source as ResolvedSource) }))
    : OBS_SOURCES.map((v) => ({ value: v, label: srcLabels[v] }));
  const obs = selectEl(obsOptions, s.obsSource, (v) => ctl.setObsSource(String(v)));
  const steps = (lo: number, hi: number, cur: number): Array<{ value: number; label: string }> => {
    const set = new Set(TIME_STEPS.filter((m) => m >= lo && m <= hi));
    set.add(cur);
    return [...set].sort((a, b) => a - b).map((m) => ({ value: m, label: minToLabel(m) }));
  };
  const from = selectEl(steps(0, 1425, s.fromMin), s.fromMin, (v) => ctl.setWindow(Number(v), s.toMin));
  const to = selectEl(steps(s.fromMin + 1, 1440, s.toMin), s.toMin, (v) => ctl.setWindow(s.fromMin, Number(v)));
  const bucketLabel = (b: number): string => {
    if (b === WHOLE_PERIOD) {
      const w = ctl.whole();
      return w ? t("ctl.bucket.whole", "Whole period ({{d}})", { d: durationLabel(w.minutes) }) : t("ctl.bucket.wholeNone", "Whole period (span too short)");
    }
    return b % 60 === 0 ? t("ctl.bucket.h", "{{n}} h", { n: b / 60 }) : t("ctl.bucket.min", "{{n}} min", { n: b });
  };
  const bucket = selectEl(
    s.bucketOptions.map((b) => ({ value: b, label: bucketLabel(b) })),
    s.bucket,
    (v) => ctl.setBucket(Number(v)),
  );
  for (const c of [run, from, to, bucket]) c.disabled = disabled;
  obs.disabled = disabled || !ctl.hasObsData;
  // C2: a select only with more than one observed source; exactly one = plain text; none = the existing disabled select
  const single = choices && choices.length === 1 ? choices[0] : null;
  const obsField = single
    ? el("p", { class: "av-hint av-span", attrs: { "data-testid": "observed-source-label" }, text: t("ctl.obsSource.single", "Observed: {{name}}", { name: single.kind === "all" ? t("ctl.obs.all", "All comparable sources") : sourceLabel(single.source as ResolvedSource) }) })
    : field(t("ctl.obsSource", "Observed source"), obs);
  return el("section", { class: "av-section av-grid" }, [
    ...(ui.showRunSelector ? [field(t("ctl.run", "Run"), run)] : []),
    obsField,
    // host-managed (Testudo owns the time window and derives the bucket): no From / To / Bucket and no bucket hint
    ...(hostManaged
      ? []
      : [
          field(t("ctl.from", "From"), from),
          field(t("ctl.to", "To"), to),
          field(t("ctl.bucket", "Bucket"), bucket),
          el("p", {
            class: "av-hint av-span",
            text: t("ctl.bucketNote", "Buckets are whole multiples of the {{n}}-minute interval shared by the simulation and the observations; Whole period is the From-To span rounded to complete intervals.", {
              n: ctl.bucketStepMin,
            }),
          }),
        ]),
    ...(ctl.validationReason
      ? [el("p", { class: "av-alert av-warn av-span", attrs: { role: "status", "data-testid": "validation-reason" }, text: t("ctl.obs.disabledReason", "Validation and Comparison are disabled for this observed source ({{reason}}). It is shown in the day profile only.", { reason: ctl.validationReason }) })]
      : []),
    ...(ctl.reports.length
      ? [el("p", { class: "av-hint av-span", attrs: { "data-testid": "reports" }, text: t("ctl.reports", "Reports: {{names}}", { names: ctl.reports.map((r) => r.name).join(", ") }) })]
      : []),
  ]);
}

/** Visible warning for simulated detectors that carry flow but have no external id. Null when none. */
export function unmatchedWarning(ctx: Ctx): HTMLElement | null {
  const { t, fmt, ctl } = ctx;
  const n = ctl.unmatched.length;
  if (n === 0) return null;
  return el("p", {
    class: "av-alert av-warn",
    attrs: { role: "status", "data-testid": "unmatched-warning" },
    text: t("unmatched.warn", "{{n}} simulated detectors with flow have no external id and are excluded from validation", { n: fmt.int(n) }),
  });
}

/** The unmatched detectors, flagged "unmatched"; a row zooms to the point when it has geometry. */
export function unmatchedTable(ctx: Ctx, onZoom: (oid: string) => void, maxRows = 100): HTMLElement | null {
  const { t, fmt, ctl } = ctx;
  const list = ctl.unmatched;
  if (list.length === 0) return null;
  const head = el("tr", {}, [
    el("th", { class: "av-th av-text", text: t("unmatched.oid", "Object id"), attrs: { scope: "col" } }),
    el("th", { class: "av-th av-num", text: t("unmatched.flow", "Simulated (veh/h)"), attrs: { scope: "col" } }),
    el("th", { class: "av-th av-text", text: t("tbl.status", "Status"), attrs: { scope: "col" } }),
    el("th", { class: "av-th av-text", text: t("unmatched.map", "On map"), attrs: { scope: "col" } }),
  ]);
  const body = el("tbody");
  for (const u of list.slice(0, maxRows)) {
    const placed = locateOid(ctl.geo, u.oid) !== null;
    body.append(
      el("tr", { class: "av-um", attrs: { "data-oid": u.oid, "data-status": "unmatched", ...(placed ? { tabindex: "0" } : {}) }, on: placed ? { click: () => onZoom(u.oid) } : {} }, [
        el("td", { class: "av-text", text: u.oid }),
        el("td", { class: "av-num", text: fmt.int(u.flow) }),
        el("td", { class: "av-text", text: t("unmatched.status", "Unmatched") }),
        el("td", { class: "av-text", text: placed ? t("unmatched.yes", "yes") : t("unmatched.no", "no geometry") }),
      ]),
    );
  }
  const wrap = el("div", { class: "av-table-wrap", attrs: { "data-testid": "unmatched-table" } }, [el("table", { class: "av-table" }, [el("thead", {}, [head]), body])]);
  if (list.length > maxRows) wrap.append(el("p", { class: "av-hint", text: t("tbl.truncated", "Showing the first {{n}} of {{total}} detectors.", { n: maxRows, total: list.length }) }));
  return el("div", {}, [el("h3", { class: "av-h", text: t("unmatched.h", "Unmatched simulated detectors") }), wrap]);
}

export function kpiGrid(items: Array<{ key?: string; label: string; value: string; tone?: "ok" | "warn" | "bad"; hint?: string }>): HTMLElement {
  return el(
    "div",
    { class: "av-kpis" },
    items.map((i) =>
      el("div", { class: `av-kpi${i.tone ? ` av-${i.tone}` : ""}`, attrs: { ...(i.hint ? { title: i.hint } : {}), ...(i.key ? { "data-kpi": i.key } : {}) } }, [
        el("div", { class: "av-kpi-v", text: i.value, attrs: i.key ? { "data-kpi-value": i.key } : {} }),
        el("div", { class: "av-kpi-l", text: i.label }),
      ]),
    ),
  );
}

export type Col = "id" | "sim" | "obs" | "diff" | "relErr" | "geh" | "status";

export function detectorTable(
  ctx: Ctx,
  rows: readonly DetAgg[],
  cols: readonly Col[],
  onSelect: (id: string) => void,
  maxRows = 400,
): HTMLElement {
  const { t, fmt, ctl } = ctx;
  const s = ctl.state;
  const heads: Record<Col, string> = {
    id: t("tbl.detector", "Detector"),
    sim: t("tbl.sim", "Simulated (veh/h)"),
    obs: t("tbl.obs", "Observed (veh/h)"),
    diff: t("tbl.diff", "Sim - obs"),
    relErr: t("tbl.rel", "Rel. error"),
    geh: t("tbl.geh", "GEH"),
    status: t("tbl.status", "Status"),
  };
  const statusText = { pass: t("status.pass", "Pass"), warn: t("status.warn", "Warn"), fail: t("status.fail", "Fail") };
  const tr = el("tr");
  for (const c of cols) {
    const sortable = c !== "status";
    const th = el("th", { class: c === "id" || c === "status" ? "av-th av-text" : "av-th av-num", attrs: { scope: "col" } });
    if (sortable) {
      const active = s.sortKey === c;
      th.setAttribute("aria-sort", active ? (s.sortDir === "asc" ? "ascending" : "descending") : "none");
      th.append(
        el("button", {
          class: "av-sort",
          text: heads[c] + (active ? (s.sortDir === "asc" ? " ▲" : " ▼") : ""),
          attrs: { type: "button" },
          on: { click: () => ctl.dispatch({ type: "sort", key: c as SortKey }) },
        }),
      );
    } else th.textContent = heads[c];
    tr.append(th);
  }
  const body = el("tbody");
  for (const a of rows.slice(0, maxRows)) {
    const row = el("tr", {
      class: `av-tr${a.id === s.selectedId ? " av-selected" : ""}`,
      attrs: { tabindex: "0", "data-id": a.id },
      on: { click: () => onSelect(a.id), keydown: (e) => ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") && (e.preventDefault(), onSelect(a.id)) },
    });
    for (const c of cols) {
      const td = el("td", { class: c === "id" || c === "status" ? "av-text" : "av-num" });
      switch (c) {
        case "id": td.textContent = a.id; break;
        case "sim": td.textContent = fmt.int(a.sim); break;
        case "obs": td.textContent = fmt.int(a.obs); break;
        case "diff": td.textContent = fmt.signed(a.diff, 0); break;
        case "relErr": td.textContent = a.relErr === null ? "-" : fmt.pct(a.relErr * 100, 0); break;
        case "geh": td.textContent = fmt.num(a.geh, 1); break;
        case "status":
          td.append(el("span", { class: "av-dot", attrs: { style: `background:${STATUS_COLORS[a.status]}`, "aria-hidden": "true" } }), statusText[a.status]);
          break;
      }
      row.append(td);
    }
    body.append(row);
  }
  const wrap = el("div", { class: "av-table-wrap" }, [el("table", { class: "av-table" }, [el("thead", {}, [tr]), body])]);
  if (rows.length > maxRows) wrap.append(el("p", { class: "av-hint", text: t("tbl.truncated", "Showing the first {{n}} of {{total}} detectors.", { n: maxRows, total: rows.length }) }));
  if (!rows.length) wrap.append(el("p", { class: "av-hint", text: t("tbl.empty", "No detectors with both simulated and observed flow in this window.") }));
  return wrap;
}
