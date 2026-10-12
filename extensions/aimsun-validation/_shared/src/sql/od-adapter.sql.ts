/**
 * OD adapter + query builders for the real extractor output (aconsole fragment) of an Aimsun run.
 *
 * Raw inputs, registered by the plugin's package loader (parquet is read by file handle / URL,
 * never copied into JS; the 4.4M-row matrices stay in DuckDB's streaming reader):
 *   od_before_raw / od_after_raw (origin_id BIGINT, origin_name, destination_id BIGINT, destination_name, value DOUBLE)
 *       value = trips for the demand interval (summed over user classes). ~4.4M cells each.
 *   centroids_geo(id BIGINT, name, external_id, lon, lat)         built by {@link centroidsFromGeoJsonSql}
 *   groupings_raw(grouping_id, grouping_name, filter_type, group_id, group_name, group_external_id,
 *                 membership_policy, member_id, member_external_id, member_name)
 *       all 13 GKGroupingType families; the centroid ones have filter_type = 'GKCentroid'.
 *
 * {@link buildOdAdapterSql} creates
 *   v_od_before_norm / v_od_after_norm (origin, destination, trips)   ids stay BIGINT (the shared views CAST)
 *   v_centroids_norm (id, name, grp, lon, lat)                         grp = group of the selected grouping
 * and, with installContract (default), the contract relations od_before / od_after / centroids as plain
 * views over them, so views.sql.ts (v_od_diff, v_od_group_agg, v_trip_length*) work unchanged.
 * NOTE those shared views FULL OUTER JOIN the two 4.4M-row matrices on VARCHAR-cast keys; the plugins use
 * the integer-keyed `od_cell` table and the builders below instead (same results, tested equal).
 *
 * Identifiers are fixed (`v_od_before_norm`, `od_cell`, ...), so one set of them can exist per DuckDB CATALOG.
 * The OD plugins therefore run every controller in its own private in-memory catalog (own connection,
 * ATTACH + USE, see _od/controller.ts) and unique registered-file names; nothing here is global.
 * {@link OD_OWNED} / {@link dropOdStateSql} list and drop everything these builders create.
 *
 * User-controlled values (grouping/group names, centroid ids) go through
 * {@link lit} / {@link intLit}.
 */
import { ident } from "./views.sql.ts";

/** SQL string literal. */
export const lit = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;

/** Integer literal from a decimal string or number; throws otherwise (no injection). */
export function intLit(v: string | number): string {
  const s = String(v).trim();
  if (!/^-?\d{1,18}$/.test(s)) throw new Error(`not an integer id: ${s}`);
  return s;
}

const num = (v: number, name: string): number => {
  if (!Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return v;
};
const posInt = (v: number, name: string, max = 1e6): number => {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${name} must be an integer in 1..${max}`);
  return v;
};

export interface OdAdapterOptions {
  rawBefore?: string;
  rawAfter?: string;
  rawCentroids?: string;
  rawGroupings?: string;
  /** Centroid grouping name (groupings_raw.grouping_name). null/undefined: one group "All". */
  grouping?: string | null;
  /** Also create od_before / od_after / centroids (contract names). Default true. */
  installContract?: boolean;
}

/** Every relation the builders of this module (plus the controller's raw views) create. */
export const OD_OWNED = {
  /** In drop order (dependants first). */
  views: ["od_before", "od_after", "centroids", "v_od_before_norm", "v_od_after_norm", "v_centroids_norm", "od_before_raw", "od_after_raw", "groupings_raw"],
  tables: ["od_cell", "centroids_geo"],
} as const;

/** DROP statements for everything in {@link OD_OWNED} (idempotent; includes the large `od_cell` table). */
export function dropOdStateSql(): string {
  return [...OD_OWNED.views.map((v) => `DROP VIEW IF EXISTS ${v};`), ...OD_OWNED.tables.map((t) => `DROP TABLE IF EXISTS ${t};`)].join("\n");
}

export const NO_GROUP = "(none)";
export const ALL_GROUP = "All";

export function buildOdAdapterSql(o: OdAdapterOptions = {}): string {
  const b = ident(o.rawBefore ?? "od_before_raw", "rawBefore");
  const a = ident(o.rawAfter ?? "od_after_raw", "rawAfter");
  const c = ident(o.rawCentroids ?? "centroids_geo", "rawCentroids");
  const g = ident(o.rawGroupings ?? "groupings_raw", "rawGroupings");
  const grouping = o.grouping ?? null;
  const grpExpr = grouping === null ? lit(ALL_GROUP) : `COALESCE(g.group_name, ${lit(NO_GROUP)})`;
  const grpJoin =
    grouping === null
      ? ""
      : `LEFT JOIN (
  SELECT member_id, MIN(group_name) AS group_name   -- overlapping groupings: smallest name wins (deterministic)
  FROM ${g}
  WHERE filter_type = 'GKCentroid' AND grouping_name = ${lit(grouping)} AND member_id IS NOT NULL AND group_name IS NOT NULL
  GROUP BY member_id
) g ON g.member_id = c.id`;
  return `
CREATE OR REPLACE VIEW v_od_before_norm AS
SELECT origin_id AS origin, destination_id AS destination, value AS trips FROM ${b} WHERE value IS NOT NULL;

CREATE OR REPLACE VIEW v_od_after_norm AS
SELECT origin_id AS origin, destination_id AS destination, value AS trips FROM ${a} WHERE value IS NOT NULL;

CREATE OR REPLACE VIEW v_centroids_norm AS
SELECT c.id AS id, c.name AS name, ${grpExpr} AS grp, c.lon AS lon, c.lat AS lat
FROM ${c} c
${grpJoin};
${
  o.installContract === false
    ? ""
    : `
CREATE OR REPLACE VIEW od_before AS SELECT * FROM v_od_before_norm;
CREATE OR REPLACE VIEW od_after AS SELECT * FROM v_od_after_norm;
CREATE OR REPLACE VIEW centroids AS SELECT * FROM v_centroids_norm;
`
}`;
}

/**
 * centroids.geojson (FeatureCollection of Points; properties id, name, external_id, groups) -> table
 * `centroids_geo`. `file` is the name the geojson is registered under in DuckDB.
 */
export function centroidsFromGeoJsonSql(file: string, table = "centroids_geo"): string {
  ident(table, "table");
  return `CREATE OR REPLACE TABLE ${table} AS
SELECT CAST(f.properties.id AS BIGINT) AS id,
       CAST(f.properties.name AS VARCHAR) AS name,
       CAST(f.properties.external_id AS VARCHAR) AS external_id,
       CAST(f.geometry.coordinates[1] AS DOUBLE) AS lon,
       CAST(f.geometry.coordinates[2] AS DOUBLE) AS lat
FROM (SELECT unnest(features) AS f FROM read_json_auto(${lit(file)}, maximum_object_size = 67108864));`;
}

/** Wrap a registered parquet file as a view (streams from the registered handle/URL on every query). */
export function parquetViewSql(view: string, file: string): string {
  return `CREATE OR REPLACE VIEW ${ident(view, "view")} AS SELECT * FROM read_parquet(${lit(file)});`;
}

// ---------------------------------------------------------------------------------------------
// Groupings

export interface GroupingInfo {
  name: string;
  nGroups: number;
  nMembers: number;
  /** Size of the largest group. */
  maxGroup: number;
}

export function listGroupingsSql(rawGroupings = "groupings_raw"): string {
  const g = ident(rawGroupings, "rawGroupings");
  return `SELECT grouping_name AS name, COUNT(*) AS n_groups, SUM(n) AS n_members, MAX(n) AS max_group
FROM (
  SELECT grouping_name, group_name, COUNT(DISTINCT member_id) AS n
  FROM ${g}
  WHERE filter_type = 'GKCentroid' AND member_id IS NOT NULL AND group_name IS NOT NULL
  GROUP BY 1, 2
)
GROUP BY 1 ORDER BY 2, 1`;
}

export function groupSizesSql(grouping: string, rawGroupings = "groupings_raw"): string {
  const g = ident(rawGroupings, "rawGroupings");
  return `SELECT group_name AS name, COUNT(DISTINCT member_id) AS n
FROM ${g}
WHERE filter_type = 'GKCentroid' AND grouping_name = ${lit(grouping)} AND member_id IS NOT NULL AND group_name IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC, 1`;
}

/**
 * Default grouping: the one with the FEWEST groups that still splits the centroids sensibly
 * (>= 2 groups and its largest group holds at most `maxShare` of the members); when none qualifies,
 * the one with the most balanced largest share. Ties: more members, then name.
 */
export function pickDefaultGrouping(groupings: readonly GroupingInfo[], maxShare = 0.9): string | null {
  const usable = groupings.filter((x) => x.nGroups >= 2 && x.nMembers > 0);
  if (!usable.length) return groupings.find((x) => x.nGroups >= 1)?.name ?? null;
  const share = (x: GroupingInfo) => x.maxGroup / x.nMembers;
  const sensible = usable.filter((x) => share(x) <= maxShare);
  const pool = sensible.length ? sensible : usable;
  const cmp = (x: GroupingInfo, y: GroupingInfo) =>
    sensible.length
      ? x.nGroups - y.nGroups || y.nMembers - x.nMembers || x.name.localeCompare(y.name)
      : share(x) - share(y) || x.nGroups - y.nGroups || x.name.localeCompare(y.name);
  return [...pool].sort(cmp)[0].name;
}

// ---------------------------------------------------------------------------------------------
// Selections

export type Selection = { kind: "all" } | { kind: "group"; value: string } | { kind: "centroid"; value: string };
export const ALL: Selection = { kind: "all" };

/** WHERE fragment (without AND) restricting `col` to the selection; "" for all. */
export function selectionPredicate(sel: Selection, col: string): string {
  ident(col.replace(/\./g, "_"), "col");
  if (sel.kind === "all") return "";
  if (sel.kind === "centroid") return `${col} = ${intLit(sel.value)}`;
  return `${col} IN (SELECT id FROM v_centroids_norm WHERE grp = ${lit(sel.value)})`;
}

const and = (...parts: string[]): string => {
  const p = parts.filter(Boolean);
  return p.length ? `WHERE ${p.join(" AND ")}` : "";
};

/** Haversine (km) between two lon/lat column pairs; same formula as v_trip_length_od. */
export function haversineKm(lat1: string, lon1: string, lat2: string, lon2: string, R = 6371.0088): string {
  return `(2 * ${R} * asin(sqrt(least(1.0, pow(sin(radians(${lat2} - ${lat1}) / 2), 2) + cos(radians(${lat1})) * cos(radians(${lat2})) * pow(sin(radians(${lon2} - ${lon1}) / 2), 2)))))`;
}

export type Side = "before" | "after";
const rel = (s: Side): string => (s === "before" ? "v_od_before_norm" : "v_od_after_norm");

export interface PairQuery {
  side: Side;
  origin?: Selection;
  destination?: Selection;
  /** Drop origin = destination. Default true. */
  excludeIntrazonal?: boolean;
  /** Keep cells with trips >= minTrips. Default 0. */
  minTrips?: number;
}

function pairWhere(q: PairQuery, o = "origin", d = "destination"): string {
  return and(
    selectionPredicate(q.origin ?? ALL, o),
    selectionPredicate(q.destination ?? ALL, d),
    q.excludeIntrazonal === false ? "" : `${o} <> ${d}`,
    q.minTrips && q.minTrips > 0 ? `trips >= ${num(q.minTrips, "minTrips")}` : "",
  );
}

/** Top-N OD pairs by trips with centroid coordinates and straight-line distance. */
export function topPairsSql(q: PairQuery & { limit?: number }): string {
  const limit = posInt(q.limit ?? 200, "limit", 20000);
  return `WITH t AS (
  SELECT origin, destination, trips FROM ${rel(q.side)} ${pairWhere(q)} ORDER BY trips DESC LIMIT ${limit}
)
SELECT CAST(t.origin AS VARCHAR) AS origin, CAST(t.destination AS VARCHAR) AS destination, t.trips,
       co.name AS origin_name, cd.name AS destination_name, co.grp AS origin_group, cd.grp AS destination_group,
       co.lon AS o_lon, co.lat AS o_lat, cd.lon AS d_lon, cd.lat AS d_lat,
       ${haversineKm("co.lat", "co.lon", "cd.lat", "cd.lon")} AS dist_km
FROM t
LEFT JOIN v_centroids_norm co ON co.id = t.origin
LEFT JOIN v_centroids_norm cd ON cd.id = t.destination
ORDER BY t.trips DESC, t.origin, t.destination`;
}

/** Totals of the selection (one row): trips, cells, trip-weighted mean straight-line km. */
export function selectionStatsSql(q: PairQuery): string {
  return `SELECT SUM(t.trips) AS trips, COUNT(*) AS n_cells, COUNT(DISTINCT t.origin) AS n_origins, COUNT(DISTINCT t.destination) AS n_destinations,
       SUM(t.trips * ${haversineKm("co.lat", "co.lon", "cd.lat", "cd.lon")}) / NULLIF(SUM(CASE WHEN co.lat IS NOT NULL AND cd.lat IS NOT NULL THEN t.trips END), 0) AS mean_km
FROM (SELECT origin, destination, trips FROM ${rel(q.side)} ${pairWhere(q)}) t
LEFT JOIN v_centroids_norm co ON co.id = t.origin
LEFT JOIN v_centroids_norm cd ON cd.id = t.destination`;
}

/** Trip-weighted straight-line distance histogram of the selection. Rows: bin_idx, bin_start_km, bin_end_km, trips, share. */
export function tripLengthSql(q: PairQuery & { binKm?: number }): string {
  const bin = num(q.binKm ?? 1, "binKm");
  if (bin <= 0) throw new Error("binKm must be > 0");
  return `WITH d AS (
  SELECT t.trips, ${haversineKm("co.lat", "co.lon", "cd.lat", "cd.lon")} AS dist_km
  FROM (SELECT origin, destination, trips FROM ${rel(q.side)} ${pairWhere({ ...q, minTrips: q.minTrips ?? 0 })}) t
  JOIN v_centroids_norm co ON co.id = t.origin
  JOIN v_centroids_norm cd ON cd.id = t.destination
  WHERE co.lon IS NOT NULL AND co.lat IS NOT NULL AND cd.lon IS NOT NULL AND cd.lat IS NOT NULL AND t.trips > 0
)
SELECT CAST(floor(dist_km / ${bin}) AS INTEGER) AS bin_idx,
       CAST(floor(dist_km / ${bin}) AS INTEGER) * ${bin}::DOUBLE AS bin_start_km,
       (CAST(floor(dist_km / ${bin}) AS INTEGER) + 1) * ${bin}::DOUBLE AS bin_end_km,
       SUM(trips) AS trips,
       SUM(trips) / SUM(SUM(trips)) OVER () AS share
FROM d GROUP BY 1 ORDER BY 1`;
}

// ---------------------------------------------------------------------------------------------
// before/after (integer-keyed od_cell table)

/**
 * Materialise the union of OD cells of both matrices as TABLE od_cell(o, d, before, after).
 * Missing side = 0. ~4.5M rows x 32 bytes inside DuckDB (not JS). Build once per run.
 */
export function buildOdCellSql(rawBefore = "v_od_before_norm", rawAfter = "v_od_after_norm"): string {
  const b = ident(rawBefore, "rawBefore");
  const a = ident(rawAfter, "rawAfter");
  return `CREATE OR REPLACE TABLE od_cell AS
SELECT COALESCE(b.origin, a.origin) AS o, COALESCE(b.destination, a.destination) AS d,
       COALESCE(b.trips, 0.0) AS before, COALESCE(a.trips, 0.0) AS after
FROM ${b} b FULL OUTER JOIN ${a} a ON b.origin = a.origin AND b.destination = a.destination;`;
}

/** deviation_ratio per the documented rule (see views.sql.ts): delta/before; NULL when before = 0 and after > 0; 0 when both 0. */
export const DEVIATION_SQL = `CASE WHEN before <> 0 THEN (after - before) / before WHEN after = 0 THEN 0.0 ELSE NULL END`;

/** Group x group matrix: og, dg, before, after, delta, deviation_ratio, n_cells. Same numbers as v_od_group_agg. */
export function groupMatrixSql(): string {
  return `SELECT og, dg, b AS before, a AS after, a - b AS delta,
       CASE WHEN b <> 0 THEN (a - b) / b WHEN a = 0 THEN 0.0 ELSE NULL END AS deviation_ratio, n AS n_cells
FROM (
  SELECT COALESCE(co.grp, ${lit(NO_GROUP)}) AS og, COALESCE(cd.grp, ${lit(NO_GROUP)}) AS dg,
         SUM(c.before) AS b, SUM(c.after) AS a, COUNT(*) AS n
  FROM od_cell c
  LEFT JOIN v_centroids_norm co ON co.id = c.o
  LEFT JOIN v_centroids_norm cd ON cd.id = c.d
  GROUP BY 1, 2
) ORDER BY 1, 2`;
}

export type ScatterLevel = "group" | "zone-group" | "cell";

/**
 * Aggregated cells for the before/after scatter. Rows: label, before, after (top `limit` by max(before, after));
 * stats row from {@link scatterStatsSql} covers ALL aggregated cells of the level, not only the plotted ones.
 */
function levelSource(level: ScatterLevel, origin: Selection = ALL): { from: string } {
  const w = and(selectionPredicate(origin, "c.o"));
  if (level === "cell") {
    return { from: `SELECT c.before, c.after, CAST(c.o AS VARCHAR) || ' > ' || CAST(c.d AS VARCHAR) AS label FROM od_cell c ${w}` };
  }
  if (level === "zone-group") {
    return {
      from: `SELECT SUM(c.before) AS before, SUM(c.after) AS after,
       CAST(c.o AS VARCHAR) || ' > ' || COALESCE(cd.grp, ${lit(NO_GROUP)}) AS label
FROM od_cell c LEFT JOIN v_centroids_norm cd ON cd.id = c.d ${w} GROUP BY c.o, COALESCE(cd.grp, ${lit(NO_GROUP)})`,
    };
  }
  return {
    from: `SELECT SUM(c.before) AS before, SUM(c.after) AS after,
       COALESCE(co.grp, ${lit(NO_GROUP)}) || ' > ' || COALESCE(cd.grp, ${lit(NO_GROUP)}) AS label
FROM od_cell c LEFT JOIN v_centroids_norm co ON co.id = c.o LEFT JOIN v_centroids_norm cd ON cd.id = c.d ${w} GROUP BY COALESCE(co.grp, ${lit(NO_GROUP)}), COALESCE(cd.grp, ${lit(NO_GROUP)})`,
  };
}

export function scatterPointsSql(level: ScatterLevel, limit = 3000, origin: Selection = ALL): string {
  const n = posInt(limit, "limit", 50000);
  return `SELECT label, before, after FROM (${levelSource(level, origin).from}) ORDER BY greatest(before, after) DESC LIMIT ${n}`;
}

/** One row: n, OLS after ~ before (slope, intercept, r2) and identity-line R2 over ALL cells of the level. */
export function scatterStatsSql(level: ScatterLevel, origin: Selection = ALL): string {
  return `SELECT COUNT(*) AS n, regr_slope(after, before) AS slope, regr_intercept(after, before) AS intercept, regr_r2(after, before) AS r2,
       SUM(before) AS before, SUM(after) AS after,
       CASE WHEN var_pop(before) > 0 THEN 1.0 - SUM(pow(after - before, 2)) / (var_pop(before) * COUNT(*)) ELSE NULL END AS r2_identity
FROM (${levelSource(level, origin).from})`;
}

/** Totals (optionally for one origin selection): one row before, after, delta, pct, n_cells, n_new_flow, n_dropped. */
export function totalsSql(origin: Selection = ALL): string {
  return `SELECT SUM(before) AS before, SUM(after) AS after, SUM(after) - SUM(before) AS delta,
       CASE WHEN SUM(before) <> 0 THEN (SUM(after) - SUM(before)) / SUM(before) ELSE NULL END AS pct,
       COUNT(*) AS n_cells,
       SUM(CASE WHEN before = 0 AND after <> 0 THEN 1 ELSE 0 END) AS n_new_flow,
       SUM(CASE WHEN before <> 0 AND after = 0 THEN 1 ELSE 0 END) AS n_dropped
FROM od_cell c ${and(selectionPredicate(origin, "c.o"))}`;
}

export interface DiffQuery {
  origin?: Selection;
  destination?: Selection;
  excludeIntrazonal?: boolean;
  /** Ignore cells whose max(before, after) is below this many trips. Default 0. */
  minTrips?: number;
}

function diffWhere(q: DiffQuery): string {
  return and(
    selectionPredicate(q.origin ?? ALL, "c.o"),
    selectionPredicate(q.destination ?? ALL, "c.d"),
    q.excludeIntrazonal === false ? "" : "c.o <> c.d",
    q.minTrips && q.minTrips > 0 ? `greatest(c.before, c.after) >= ${num(q.minTrips, "minTrips")}` : "",
  );
}

/** Top gains or losses by delta, with deviation_ratio, is_new_flow, names and coordinates. */
export function topDiffSql(q: DiffQuery & { dir: "gain" | "loss"; limit?: number }): string {
  const limit = posInt(q.limit ?? 50, "limit", 20000);
  const dir = q.dir === "gain" ? "DESC" : "ASC";
  const sign = q.dir === "gain" ? "c.after - c.before > 0" : "c.after - c.before < 0";
  const w = diffWhere(q);
  const where = w ? `${w} AND ${sign}` : `WHERE ${sign}`;
  return `WITH t AS (
  SELECT c.o, c.d, c.before, c.after, c.after - c.before AS delta FROM od_cell c ${where} ORDER BY delta ${dir} LIMIT ${limit}
)
SELECT CAST(t.o AS VARCHAR) AS origin, CAST(t.d AS VARCHAR) AS destination, t.before, t.after, t.delta,
       CASE WHEN t.before <> 0 THEN t.delta / t.before WHEN t.after = 0 THEN 0.0 ELSE NULL END AS deviation_ratio,
       (t.before = 0 AND t.after <> 0) AS is_new_flow,
       co.name AS origin_name, cd.name AS destination_name, co.grp AS origin_group, cd.grp AS destination_group,
       co.lon AS o_lon, co.lat AS o_lat, cd.lon AS d_lon, cd.lat AS d_lat,
       ${haversineKm("co.lat", "co.lon", "cd.lat", "cd.lon")} AS dist_km
FROM t LEFT JOIN v_centroids_norm co ON co.id = t.o LEFT JOIN v_centroids_norm cd ON cd.id = t.d
ORDER BY t.delta ${dir}, t.o, t.d`;
}

/** Bands of |deviation_ratio| from the rendering_adjustments contract: [0,.05) [.05,.1) [.1,.2) [.2,.5) [.5,inf). */
export const DEVIATION_BANDS = [0, 0.05, 0.1, 0.2, 0.5, Infinity] as const;

/**
 * Deviation-band histogram over cells with before > 0 (cells with a zero denominator have no ratio:
 * new flows are counted apart, per zero_demand_policy = exclude_from_percentage_aggregates).
 * Rows: band (0..4), cells, before, after, n_up, n_down; plus one extra row band = -1 for new flows
 * (before = 0, after > 0) with `after` as trips.
 */
export function deviationBandsSql(q: DiffQuery = {}): string {
  const w = diffWhere(q);
  const wb = w ? `${w} AND c.before > 0` : "WHERE c.before > 0";
  const nw = w ? `${w} AND c.before = 0 AND c.after > 0` : "WHERE c.before = 0 AND c.after > 0";
  return `SELECT CASE WHEN r < 0.05 THEN 0 WHEN r < 0.1 THEN 1 WHEN r < 0.2 THEN 2 WHEN r < 0.5 THEN 3 ELSE 4 END AS band,
       COUNT(*) AS cells, SUM(before) AS before, SUM(after) AS after,
       SUM(CASE WHEN after > before THEN 1 ELSE 0 END) AS n_up, SUM(CASE WHEN after < before THEN 1 ELSE 0 END) AS n_down
FROM (SELECT c.before, c.after, abs(c.after - c.before) / c.before AS r FROM od_cell c ${wb})
GROUP BY 1
UNION ALL
SELECT -1 AS band, COUNT(*) AS cells, 0.0 AS before, COALESCE(SUM(after), 0.0) AS after, COUNT(*) AS n_up, 0 AS n_down
FROM (SELECT c.after FROM od_cell c ${nw})
ORDER BY 1`;
}

/**
 * Net production / attraction per centroid. production = sum over destinations of the row, attraction = sum over origins.
 * Rows: id, name, grp, lon, lat, prod_before, prod_after, attr_before, attr_after, prod_delta, attr_delta.
 * Intrazonal trips are included (they leave and enter the same zone, so they cancel in neither total).
 */
export function centroidNetSql(): string {
  return `WITH p AS (SELECT o AS id, SUM(before) AS b, SUM(after) AS a FROM od_cell GROUP BY o),
a AS (SELECT d AS id, SUM(before) AS b, SUM(after) AS a FROM od_cell GROUP BY d)
SELECT CAST(c.id AS VARCHAR) AS id, c.name, c.grp, c.lon, c.lat,
       COALESCE(p.b, 0.0) AS prod_before, COALESCE(p.a, 0.0) AS prod_after,
       COALESCE(a.b, 0.0) AS attr_before, COALESCE(a.a, 0.0) AS attr_after,
       COALESCE(p.a, 0.0) - COALESCE(p.b, 0.0) AS prod_delta,
       COALESCE(a.a, 0.0) - COALESCE(a.b, 0.0) AS attr_delta
FROM v_centroids_norm c LEFT JOIN p ON p.id = c.id LEFT JOIN a ON a.id = c.id
WHERE p.id IS NOT NULL OR a.id IS NOT NULL
ORDER BY c.id`;
}

/** Centroids for pickers/maps (all with coordinates): id, name, grp, lon, lat. */
export function odCentroidsSql(): string {
  return "SELECT CAST(id AS VARCHAR) AS id, name, grp, lon, lat FROM v_centroids_norm WHERE lon IS NOT NULL AND lat IS NOT NULL ORDER BY name, id";
}
