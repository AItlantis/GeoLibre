/** aimsun-trips: OD desire lines + top pairs + straight-line trip-length histogram for one matrix (before or after). */
import { histogramSvg } from "../../_shared/src/charts";
import { selectionStatsSql, tripLengthSql, topPairsSql, type PairQuery } from "../../_shared/src/sql/od-adapter.sql";
import { boundsOf, describeSelection, linesToFc, radiusPx, widthPx, type FC, type LineRow } from "../../_od/calc.ts";
import type { OdView, ViewEnv } from "../../_od/plugin.ts";
import { allSel, selectorControl, toSelection, validSel, type SelState } from "../../_od/selector.ts";
import { chartBox, clear, el, field, kpi, section, select, table } from "../../_od/ui.ts";

export const TRIPS_OVERLAY = [
  { id: "centroids", source: "centroids", type: "circle" as const, paint: { "circle-opacity": 0.5, "circle-stroke-width": 0 } },
  { id: "lines", source: "lines", type: "line" as const },
  { id: "ends", source: "ends", type: "circle" as const },
];

export interface TripsState {
  side: "before" | "after";
  origin: SelState;
  destination: SelState;
  topN: number;
  minTrips: number;
  intrazonal: boolean;
  binKm: number;
}

const DEFAULTS = (): TripsState => ({ side: "before", origin: allSel(), destination: allSel(), topN: 200, minTrips: 1, intrazonal: false, binKm: 2 });
export const MAX_LINES = 2000;

const ORIGIN_COLOR = "#e66100";
const DEST_COLOR = "#1c71d8";
const BOTH_COLOR = "#7e3fa8";
const LINE_COLOR = "#26547c";

interface PairRow extends LineRow {
  origin_group?: string | null;
  destination_group?: string | null;
  dist_km: number | null;
}

export function createTripsView(env: ViewEnv): OdView {
  const { ctl, overlay } = env;
  let st: TripsState = DEFAULTS();
  let host: HTMLElement | null = null;
  let out: HTMLElement | null = null;
  let tok = 0;
  let last: { pairs: PairRow[]; stats: Record<string, unknown> | null; hist: Array<Record<string, unknown>> | null; side: string; sel: string } | null = null;
  let centroidsDrawn = "";

  const query = (): PairQuery => ({
    side: st.side,
    origin: toSelection(st.origin),
    destination: toSelection(st.destination),
    excludeIntrazonal: !st.intrazonal,
    minTrips: st.minTrips,
  });

  const drawCentroids = (): void => {
    const key = `${ctl.state.run}`;
    if (key === centroidsDrawn) return;
    centroidsDrawn = key;
    const fc: FC = {
      type: "FeatureCollection",
      features: ctl.state.centroids
        .filter((c) => c.lon !== null && c.lat !== null)
        .map((c) => ({ type: "Feature" as const, geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { c: "#8a8f98", r: 2, tip: `${c.name} (${c.id})\n${c.grp}` } })),
    };
    overlay.set("centroids", fc);
  };

  const pushMap = (pairs: PairRow[]): void => {
    const max = pairs.reduce((m, p) => Math.max(m, p.trips), 0);
    const side = st.side === "before" ? env.t("side.before", "before") : env.t("side.after", "after");
    const lines = linesToFc(
      pairs,
      () => LINE_COLOR,
      (r) => widthPx(r.trips, max),
      (r) =>
        `${r.origin_name ?? r.origin} (${r.origin}) → ${r.destination_name ?? r.destination} (${r.destination})\n${env.fmt.num(r.trips, 1)} ${env.t("trips", "trips")} (${side})\n${env.fmt.num((r as PairRow).dist_km, 1)} km ${env.t("straight", "straight-line")}`,
    );
    // endpoints: size by the trips of the shown lines through them
    const agg = new Map<string, { lon: number; lat: number; name: string; o: number; d: number }>();
    for (const p of pairs) {
      if (p.o_lon === null || p.d_lon === null || p.o_lat === null || p.d_lat === null) continue;
      const a = agg.get(p.origin) ?? { lon: p.o_lon, lat: p.o_lat, name: String(p.origin_name ?? ""), o: 0, d: 0 };
      a.o += p.trips;
      agg.set(p.origin, a);
      const b = agg.get(p.destination) ?? { lon: p.d_lon, lat: p.d_lat, name: String(p.destination_name ?? ""), o: 0, d: 0 };
      b.d += p.trips;
      agg.set(p.destination, b);
    }
    const maxEnd = Math.max(1, ...[...agg.values()].map((a) => Math.max(a.o, a.d)));
    const ends: FC = {
      type: "FeatureCollection",
      features: [...agg.entries()].map(([id, a]) => ({
        type: "Feature" as const,
        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        properties: {
          c: a.o && a.d ? BOTH_COLOR : a.o ? ORIGIN_COLOR : DEST_COLOR,
          r: radiusPx(Math.max(a.o, a.d), maxEnd, 3, 14),
          tip: `${a.name} (${id})\n${env.t("tip.out", "origin of {{n}} trips", { n: env.fmt.num(a.o, 1) })}\n${env.t("tip.in", "destination of {{n}} trips", { n: env.fmt.num(a.d, 1) })}`,
        },
      })),
    };
    overlay.set("lines", lines);
    overlay.set("ends", ends);
    if (boundsOf(lines)) overlay.fit();
  };

  const renderResults = (): void => {
    if (!out) return;
    clear(out);
    if (!last) return;
    const { t, fmt } = env;
    const { pairs, stats, hist } = last;
    const kp = el("div", { class: "ao-kpis" }, [
      kpi(t("kpi.trips", "Trips in selection"), fmt.int(Number(stats?.trips ?? 0))),
      kpi(t("kpi.cells", "OD cells"), fmt.int(Number(stats?.n_cells ?? 0)), t("kpi.cellsSub", "{{o}} origins x {{d}} destinations", { o: fmt.int(Number(stats?.n_origins ?? 0)), d: fmt.int(Number(stats?.n_destinations ?? 0)) })),
      kpi(t("kpi.mean", "Mean distance"), `${fmt.num(stats?.mean_km === null || stats?.mean_km === undefined ? null : Number(stats.mean_km), 1)} km`, t("kpi.meanSub", "trip-weighted, straight-line")),
      kpi(t("kpi.shown", "Lines drawn"), fmt.int(pairs.length), t("kpi.shownSub", "{{p}} of selection trips", { p: fmt.pct(Number(stats?.trips) > 0 ? pairs.reduce((s, p) => s + p.trips, 0) / Number(stats?.trips) : null, 0) })),
    ]);
    const legend = el("div", { class: "ao-legend" }, [
      el("span", { text: t("legend.origin", "origin") }),
      el("span", { text: "●", attrs: { style: `color:${ORIGIN_COLOR}` } }),
      el("span", { text: t("legend.dest", "destination") }),
      el("span", { text: "●", attrs: { style: `color:${DEST_COLOR}` } }),
      el("span", { text: t("legend.width", "line width ~ trips") }),
    ]);
    const tbl = table<PairRow>(
      [
        { label: t("col.origin", "Origin"), value: (r) => `${r.origin}${r.origin_name ? ` ${r.origin_name}` : ""}` },
        { label: t("col.dest", "Destination"), value: (r) => `${r.destination}${r.destination_name ? ` ${r.destination_name}` : ""}` },
        { label: t("col.trips", "Trips"), value: (r) => fmt.num(r.trips, 1), num: true },
        { label: t("col.km", "km"), value: (r) => fmt.num(r.dist_km, 1), num: true },
      ],
      pairs,
      (r) => {
        if (r.o_lon !== null && r.o_lat !== null && r.d_lon !== null && r.d_lat !== null) overlay.zoomTo((r.o_lon + r.d_lon) / 2, (r.o_lat + r.d_lat) / 2, 11);
      },
      MAX_LINES,
    );
    const bins = (hist ?? []).map((h) => ({ start: Number(h.bin_start_km), end: Number(h.bin_end_km), value: Number(h.trips) }));
    out.append(
      kp,
      section(t("map.title", "Desire lines on the map"), [legend], t("map.hint", "Straight lines between centroids, not routes. Grey dots: all centroids.")),
      section(t("top.title", "Top OD pairs"), [tbl]),
      section(
        t("hist.title", "Trip-length distribution"),
        [
          chartBox(
            histogramSvg(bins, {
              label: t("hist.title", "Trip-length distribution"),
              xTitle: t("hist.x", "straight-line centroid distance (km), not route length"),
              yTitle: t("hist.y", "trips"),
            }),
          ),
        ],
        t("hist.hint", "Trip-weighted histogram of the haversine distance between origin and destination centroids ({{w}} km bins). It is not the length of the route driven.", { w: st.binKm }),
      ),
    );
  };

  const refresh = async (): Promise<void> => {
    if (!ctl.ready) return;
    const my = ++tok;
    const { t } = env;
    if (out) {
      clear(out);
      out.append(el("p", { class: "ao-alert", text: t("busy", "Querying…") }));
    }
    try {
      drawCentroids();
      const q = query();
      const pairs = (await ctl.q<PairRow>(topPairsSql({ ...q, limit: Math.min(MAX_LINES, Math.max(1, st.topN)) }), "pairs")).map((p) => ({
        ...p,
        trips: Number(p.trips),
        origin: String(p.origin),
        destination: String(p.destination),
        o_lon: p.o_lon === null ? null : Number(p.o_lon),
        o_lat: p.o_lat === null ? null : Number(p.o_lat),
        d_lon: p.d_lon === null ? null : Number(p.d_lon),
        d_lat: p.d_lat === null ? null : Number(p.d_lat),
        dist_km: p.dist_km === null ? null : Number(p.dist_km),
      }));
      if (my !== tok) return;
      last = { pairs, stats: null, hist: null, side: st.side, sel: "" };
      pushMap(pairs);
      renderResults();
      const stats = (await ctl.q(selectionStatsSql(q), "stats"))[0] ?? null;
      if (my !== tok) return;
      const hist = await ctl.q(tripLengthSql({ ...q, minTrips: 0, binKm: st.binKm }), "hist");
      if (my !== tok) return;
      last = { pairs, stats, hist, side: st.side, sel: "" };
      renderResults();
    } catch (e) {
      if (my === tok && out) {
        clear(out);
        out.append(el("p", { class: "ao-alert ao-bad", text: e instanceof Error ? e.message : String(e) }));
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 250);
  };

  const controls = (): HTMLElement => {
    const { t } = env;
    st.origin = validSel(env, st.origin);
    st.destination = validSel(env, st.destination);
    const num = (label: string, v: number, min: number, max: number, step: number, set: (n: number) => void): HTMLElement => {
      const i = el("input", { class: "ao-input", attrs: { type: "number", min: String(min), max: String(max), step: String(step) } });
      i.value = String(v);
      i.addEventListener("change", () => {
        const n = Number(i.value);
        if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)));
        schedule();
      });
      return field(label, i);
    };
    const grid = el("div", { class: "ao-grid" }, [
      field(
        t("matrix", "Matrix"),
        select(
          [
            { value: "before", label: t("side.beforeCap", "Before adjustment") },
            { value: "after", label: t("side.afterCap", "After adjustment") },
          ],
          st.side,
          (v) => {
            st.side = v as TripsState["side"];
            schedule();
          },
        ),
      ),
      num(t("topn", "Top-N lines (max {{m}})", { m: MAX_LINES }), st.topN, 1, MAX_LINES, 10, (n) => (st.topN = Math.round(n))),
      selectorControl(env, t("origin", "Origin"), st.origin, (s) => {
        st.origin = s;
        schedule();
      }),
      selectorControl(env, t("dest", "Destination"), st.destination, (s) => {
        st.destination = s;
        schedule();
      }),
      num(t("min", "Min trips per pair"), st.minTrips, 0, 1e6, 0.5, (n) => (st.minTrips = n)),
      num(t("bin", "Histogram bin (km)"), st.binKm, 0.5, 50, 0.5, (n) => (st.binKm = n)),
    ]);
    const chk = el("input", { attrs: { type: "checkbox" } });
    chk.checked = st.intrazonal;
    chk.addEventListener("change", () => {
      st.intrazonal = chk.checked;
      schedule();
    });
    return el("div", { class: "ao-section" }, [grid, el("label", { class: "ao-check" }, [chk, el("span", { text: t("intra", "Include intrazonal trips (origin = destination)") })])]);
  };

  return {
    mount(h) {
      host = h;
      clear(host);
      out = el("div", { class: "ao-results" });
      host.append(controls(), out);
      if (last) renderResults();
      else if (ctl.ready) void refresh();
    },
    onData() {
      if (host && out) {
        const c = host.firstElementChild;
        c?.replaceWith(controls());
      }
      centroidsDrawn = "";
      void refresh();
    },
    relocalize() {
      if (host && out) {
        host.firstElementChild?.replaceWith(controls());
        renderResults();
      }
    },
    getState: () => st,
    setState(s) {
      if (!s || typeof s !== "object") return;
      const x = s as Partial<TripsState>;
      st = { ...DEFAULTS(), ...x, origin: { ...allSel(), ...(x.origin ?? {}) }, destination: { ...allSel(), ...(x.destination ?? {}) } };
      if (host && out) {
        host.firstElementChild?.replaceWith(controls());
        void refresh();
      }
    },
    dispose() {
      tok++;
      if (timer) clearTimeout(timer);
      host = out = null;
    },
  };
}

export { describeSelection };
