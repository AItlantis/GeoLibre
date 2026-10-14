/**
 * Transparent name matching between OBSERVED journey-time routes and MODEL subpaths.
 *
 * Rules (nothing beyond these is guessed):
 *  1. Text normalisation: Unicode NFKC, collapse whitespace, trim, lower-case.
 *  2. Direction vocabulary: In -> IB, Out -> OB (case-insensitive); IB, OB, EW, WE are kept.
 *  3. Model subpath names carry the direction as a `_<dir>` suffix ("Sheikh Rashid Bin Saeed Street_OB",
 *     "Al Ain Road_In"); the suffix is stripped to give the base name. A subpath without such a suffix
 *     (e.g. "AD01_b") has no direction and is reported as unmatched, never forced. A subpath whose base
 *     name nobody observes (e.g. "AD Mainland - Sheikh Zayed Bin Sultan Street_In") is reported too.
 *  4. Observed rows have a separate `direction_norm`; the route name is used verbatim (normalised).
 *     Only when the direction is missing is a ` IB` / `_Out` style suffix split off the route name
 *     (the subnetwork source names routes like "Al Ain Road IB").
 *  5. Match key = `<normalised base>|<direction>`. One observed key may match several subpaths
 *     (the same street exists in the 'Journey Time routes - HSMe' and 'subnetwork' groups); all are listed.
 *  6. Duplicate groups: when one observed key matches subpaths in more than one group and one of them is
 *     'Journey Time routes - HSMe' (PREFERRED_GROUP), ONLY that group is used; the others are dropped from the
 *     match (listed in MatchRow.dropped, never drawn). Keys with several groups but no preferred one keep all.
 *     The rule does not depend on the selected observed source.
 *  7. A subpath flagged as not existing in the run's scenario is excluded and listed separately.
 *  8. (C9) Identity hierarchy, applied per observed route before rules 1-7:
 *       a. a verified `subpath_oid` carried by the observation wins when that oid exists among the model subpaths;
 *       b. otherwise an EXACT full-name match (normalised text of the whole route name == subpath name);
 *          several subpaths with the same exact name are reduced by the preferred-group rule (6) and, if still
 *          more than one, the route is reported as AMBIGUOUS (never silently resolved or dropped);
 *       c. otherwise the name + direction key of rules 1-5.
 *     NB / SB are their own directions: they are NEVER equated with IB / OB (that needs a model-specific mapping).
 *     Every observed route that stays without a match is listed with a reason (MatchRow.reason).
 */
export type Direction = "IB" | "OB" | "EW" | "WE" | "NB" | "SB";

const DIRECTION_ALIASES: Record<string, Direction> = { in: "IB", ib: "IB", out: "OB", ob: "OB", ew: "EW", we: "WE", nb: "NB", sb: "SB" };

export function normText(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normDirection(d: unknown): Direction | null {
  if (d === null || d === undefined) return null;
  return DIRECTION_ALIASES[normText(d)] ?? null;
}

const SUFFIX_UNDERSCORE = /^(.*?)\s*_\s*(IB|OB|In|Out|EW|WE|NB|SB)\s*$/i;
const SUFFIX_ANY = /^(.*?)(?:\s*_\s*|\s+)(IB|OB|In|Out|EW|WE|NB|SB)\s*$/i;

export interface ParsedName {
  /** Name without the direction suffix (original case, whitespace-collapsed). */
  base: string;
  direction: Direction | null;
  /** Suffix text as found, e.g. "In", or null. */
  suffix: string | null;
}

const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** Model subpath name -> base + direction (only a `_<dir>` suffix counts). */
export function parseSubpathName(name: string): ParsedName {
  const trimmed = clean(name);
  const m = SUFFIX_UNDERSCORE.exec(trimmed);
  if (!m || !m[1].trim()) return { base: trimmed, direction: null, suffix: null };
  return { base: m[1].trim(), direction: normDirection(m[2]), suffix: m[2] };
}

/** Observed row -> base + direction. A given direction wins and the route is kept verbatim. */
export function parseObsRoute(route: string, direction: unknown): ParsedName {
  const trimmed = clean(route);
  const d = normDirection(direction);
  if (d) {
    // NB/SB only: a route that already ends in the same cardinal token ("... Jumeirah St SB" + direction SB)
    // keys like the same route given without a direction, so observed and simulated rows meet.
    if (d === "NB" || d === "SB") {
      const tail = SUFFIX_ANY.exec(trimmed);
      if (tail && tail[1].trim() && normDirection(tail[2]) === d) return { base: tail[1].trim(), direction: d, suffix: tail[2] };
    }
    return { base: trimmed, direction: d, suffix: null };
  }
  const m = SUFFIX_ANY.exec(trimmed);
  if (!m || !m[1].trim()) return { base: trimmed, direction: null, suffix: null };
  return { base: m[1].trim(), direction: normDirection(m[2]), suffix: m[2] };
}

export function matchKey(base: string, direction: Direction | null): string | null {
  return direction ? `${normText(base)}|${direction}` : null;
}

export interface ObsPair {
  route: string;
  direction: string;
  source?: string;
  /** Verified subpath identity carried by the observation (C9); null/absent = name matching only. */
  subpath_oid?: string | number | null;
  /** How the producer resolved subpath_oid ('rds-oid' | 'exact-name' | 'crosswalk' | ...). */
  match_method?: string | null;
  source_id?: string | null;
}

export interface SubpathRef {
  id: string | number;
  /** Model object id when it differs from `id` (the GeoJSON feature id); defaults to `id`. */
  oid?: string | number | null;
  name: string;
  group: string | null;
  /** false = flagged as absent from the run's scenario. null = no flag in the data. */
  exists: boolean | null;
}

export type MatchMethod = "oid" | "exact-name" | "name-direction";

export interface SubpathMatch {
  subpath: SubpathRef;
  /** Human-readable rule that produced the key, e.g. `name "Al Ain Road_In": suffix "In" -> IB`. */
  via: string;
  method?: MatchMethod;
}

export type MatchReason = "matched" | "no-subpath" | "no-direction" | "ambiguous" | "oid-not-in-model";

/** The only group kept when an observed key matches subpaths in several groups. */
export const PREFERRED_GROUP = "Journey Time routes - HSMe";

/** Key shared by observed rows, matching rows and overlay values: verified oid first, else name + direction. */
export function obsKey(route: string, direction: unknown, oid?: string | number | null): string {
  if (oid !== null && oid !== undefined && String(oid) !== "") return `oid:${String(oid)}`;
  return pairKey(route, direction) ?? `name:${normText(route)}|${normText(direction)}`;
}

export interface MatchRow {
  route: string;
  direction: string;
  key: string | null;
  /** Overlay/value key (see obsKey): always set, also for exact-name and oid matches. */
  valueKey: string;
  subpath_oid: string | number | null;
  source_id: string | null;
  matches: SubpathMatch[];
  /** Why the row has (or has not) a match; unmatched/ambiguous rows are listed, never dropped. */
  reason: MatchReason;
  /** Subpaths sharing the exact name when the row is ambiguous. */
  candidates: SubpathMatch[];
  /** Duplicates dropped from other groups by the PREFERRED_GROUP rule. */
  dropped: SubpathMatch[];
}

export interface UnmatchedSubpath {
  subpath: SubpathRef;
  reason: "not-in-scenario" | "no-direction-suffix" | "no-observed-route" | "ambiguous-observed";
  key: string | null;
}

export interface MatchResult {
  rows: MatchRow[];
  matchedObs: MatchRow[];
  unmatchedObs: MatchRow[];
  /** Subset of unmatchedObs whose reason is 'ambiguous' (several equally valid subpaths; none is drawn). */
  ambiguousObs: MatchRow[];
  unmatchedSubpaths: UnmatchedSubpath[];
  counts: {
    obsTotal: number;
    obsMatched: number;
    obsUnmatched: number;
    subpathsTotal: number;
    subpathsMatched: number;
    subpathsUnmatched: number;
    subpathsNotInScenario: number;
    /** Subpaths excluded from matches by the preferred-group rule (not counted as matched or unmatched). */
    subpathsDroppedDuplicate: number;
  };
}

const hasOid = (v: unknown): v is string | number => v !== null && v !== undefined && String(v) !== "";
const spOid = (sp: SubpathRef): string => String(sp.oid ?? sp.id);

export function buildMatching(obs: readonly ObsPair[], subpaths: readonly SubpathRef[]): MatchResult {
  // Distinct observed pairs (route, direction, source, oid, source_id); a pair without an identity can never match.
  const seen = new Set<string>();
  const obsParsed: Array<{ pair: ObsPair; key: string | null }> = [];
  for (const p of obs) {
    const parsed = parseObsRoute(p.route, p.direction);
    const key = matchKey(parsed.base, parsed.direction);
    const id = [p.route, p.direction, p.source ?? "", hasOid(p.subpath_oid) ? String(p.subpath_oid) : "", p.source_id ?? ""].join("\u0000");
    if (seen.has(id)) continue;
    seen.add(id);
    obsParsed.push({ pair: p, key });
  }

  const byKey = new Map<string, SubpathMatch[]>();
  const byExact = new Map<string, SubpathMatch[]>();
  const byOid = new Map<string, SubpathRef>();
  const spInfo: Array<{ sp: SubpathRef; key: string | null; parsed: ParsedName }> = [];
  const notInScenario: UnmatchedSubpath[] = [];
  for (const sp of subpaths) {
    const parsed = parseSubpathName(sp.name);
    const key = matchKey(parsed.base, parsed.direction);
    spInfo.push({ sp, key, parsed });
    if (sp.exists === false) {
      notInScenario.push({ subpath: sp, reason: "not-in-scenario", key });
      continue;
    }
    byOid.set(spOid(sp), sp);
    const exact = normText(sp.name);
    if (exact) {
      const ea = byExact.get(exact) ?? [];
      ea.push({ subpath: sp, via: `exact full name "${sp.name}"`, method: "exact-name" });
      byExact.set(exact, ea);
    }
    if (!key) continue;
    const via = `name "${sp.name}": suffix "${parsed.suffix}" -> ${parsed.direction}`;
    const arr = byKey.get(key) ?? [];
    arr.push({ subpath: sp, via, method: "name-direction" });
    byKey.set(key, arr);
  }

  const preferred = normText(PREFERRED_GROUP);
  /** Preferred-group rule (6): only when several groups share a key and one is the preferred group. */
  const reduce = (all: SubpathMatch[]): { matches: SubpathMatch[]; dropped: SubpathMatch[] } => {
    const groups = new Set(all.map((m) => normText(m.subpath.group)));
    const useRule = groups.size > 1 && groups.has(preferred);
    return {
      matches: useRule ? all.filter((m) => normText(m.subpath.group) === preferred) : all,
      dropped: useRule
        ? all.filter((m) => normText(m.subpath.group) !== preferred).map((m) => ({ subpath: m.subpath, via: `dropped: key also matched in group "${PREFERRED_GROUP}"; only that group is used` }))
        : [],
    };
  };

  const rows: MatchRow[] = obsParsed.map(({ pair, key }) => {
    const oid = hasOid(pair.subpath_oid) ? pair.subpath_oid : null;
    const base = { route: pair.route, direction: pair.direction, key, valueKey: obsKey(pair.route, pair.direction, oid), subpath_oid: oid, source_id: pair.source_id ?? null, dropped: [] as SubpathMatch[], candidates: [] as SubpathMatch[] };
    // (a) verified oid wins
    if (oid !== null) {
      const hit = byOid.get(String(oid));
      if (hit) {
        return { ...base, matches: [{ subpath: hit, via: `verified subpath_oid ${String(oid)}${pair.match_method ? ` (${pair.match_method})` : ""}`, method: "oid" as const }], reason: "matched" as const };
      }
    }
    // (b) exact full-name
    const exact = byExact.get(normText(pair.route)) ?? [];
    if (exact.length) {
      const { matches, dropped } = reduce(exact);
      if (matches.length === 1) return { ...base, matches, dropped, reason: "matched" as const };
      return { ...base, matches: [], dropped, candidates: matches, reason: "ambiguous" as const };
    }
    // (c) name + direction key
    const { matches, dropped } = reduce(key ? (byKey.get(key) ?? []) : []);
    if (matches.length) return { ...base, matches, dropped, reason: "matched" as const };
    return { ...base, matches: [], dropped, reason: oid !== null ? ("oid-not-in-model" as const) : key ? ("no-subpath" as const) : ("no-direction" as const) };
  });
  const keptIds = new Set(rows.flatMap((r) => r.matches.map((m) => String(m.subpath.id))));
  const droppedIds = new Set(rows.flatMap((r) => r.dropped.map((m) => String(m.subpath.id))));
  const ambiguousIds = new Set(rows.flatMap((r) => r.candidates.map((m) => String(m.subpath.id))));
  const matchedObs = rows.filter((r) => r.matches.length > 0);
  const unmatchedObs = rows.filter((r) => r.matches.length === 0);
  const ambiguousObs = rows.filter((r) => r.reason === "ambiguous");

  const unmatchedSubpaths: UnmatchedSubpath[] = [...notInScenario];
  let matchedSp = 0;
  let droppedDup = 0;
  for (const { sp, key, parsed } of spInfo) {
    if (sp.exists === false) continue;
    const id = String(sp.id);
    if (keptIds.has(id)) { matchedSp++; continue; }
    if (droppedIds.has(id)) { droppedDup++; continue; }
    if (ambiguousIds.has(id)) { unmatchedSubpaths.push({ subpath: sp, reason: "ambiguous-observed", key }); continue; }
    unmatchedSubpaths.push({ subpath: sp, reason: parsed.direction ? "no-observed-route" : "no-direction-suffix", key });
  }
  return {
    rows,
    matchedObs,
    unmatchedObs,
    ambiguousObs,
    unmatchedSubpaths,
    counts: {
      obsTotal: rows.length,
      obsMatched: matchedObs.length,
      obsUnmatched: unmatchedObs.length,
      subpathsTotal: subpaths.length,
      subpathsMatched: matchedSp,
      subpathsUnmatched: unmatchedSubpaths.length,
      subpathsNotInScenario: notInScenario.length,
      subpathsDroppedDuplicate: droppedDup,
    },
  };
}

/** Match key for an observed or simulated (route, direction_norm) pair, or null without a direction. */
export function pairKey(route: string, direction: unknown): string | null {
  const p = parseObsRoute(route, direction);
  return matchKey(p.base, p.direction);
}
