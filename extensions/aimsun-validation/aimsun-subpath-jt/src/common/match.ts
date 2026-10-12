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
 */
export type Direction = "IB" | "OB" | "EW" | "WE";

const DIRECTION_ALIASES: Record<string, Direction> = { in: "IB", ib: "IB", out: "OB", ob: "OB", ew: "EW", we: "WE" };

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

const SUFFIX_UNDERSCORE = /^(.*?)\s*_\s*(IB|OB|In|Out|EW|WE)\s*$/i;
const SUFFIX_ANY = /^(.*?)(?:\s*_\s*|\s+)(IB|OB|In|Out|EW|WE)\s*$/i;

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
  if (d) return { base: trimmed, direction: d, suffix: null };
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
}

export interface SubpathRef {
  id: string | number;
  name: string;
  group: string | null;
  /** false = flagged as absent from the run's scenario. null = no flag in the data. */
  exists: boolean | null;
}

export interface SubpathMatch {
  subpath: SubpathRef;
  /** Human-readable rule that produced the key, e.g. `name "Al Ain Road_In": suffix "In" -> IB`. */
  via: string;
}

/** The only group kept when an observed key matches subpaths in several groups. */
export const PREFERRED_GROUP = "Journey Time routes - HSMe";

export interface MatchRow {
  route: string;
  direction: string;
  key: string | null;
  matches: SubpathMatch[];
  /** Duplicates dropped from other groups by the PREFERRED_GROUP rule. */
  dropped: SubpathMatch[];
}

export interface UnmatchedSubpath {
  subpath: SubpathRef;
  reason: "not-in-scenario" | "no-direction-suffix" | "no-observed-route";
  key: string | null;
}

export interface MatchResult {
  rows: MatchRow[];
  matchedObs: MatchRow[];
  unmatchedObs: MatchRow[];
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

export function buildMatching(obs: readonly ObsPair[], subpaths: readonly SubpathRef[]): MatchResult {
  // Distinct observed pairs; a pair without a recognisable direction can never match.
  const seen = new Set<string>();
  const obsParsed: Array<{ pair: ObsPair; key: string | null }> = [];
  for (const p of obs) {
    const parsed = parseObsRoute(p.route, p.direction);
    const key = matchKey(parsed.base, parsed.direction);
    const id = `${p.route}\u0000${p.direction}\u0000${p.source ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    obsParsed.push({ pair: p, key });
  }

  const byKey = new Map<string, SubpathMatch[]>();
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
    if (!key) continue;
    const via = `name "${sp.name}": suffix "${parsed.suffix}" -> ${parsed.direction}`;
    const arr = byKey.get(key) ?? [];
    arr.push({ subpath: sp, via });
    byKey.set(key, arr);
  }

  const preferred = normText(PREFERRED_GROUP);
  const rows: MatchRow[] = obsParsed.map(({ pair, key }) => {
    const all = key ? (byKey.get(key) ?? []) : [];
    const groups = new Set(all.map((m) => normText(m.subpath.group)));
    const useRule = groups.size > 1 && groups.has(preferred);
    const matches = useRule ? all.filter((m) => normText(m.subpath.group) === preferred) : all;
    const dropped = useRule
      ? all.filter((m) => normText(m.subpath.group) !== preferred).map((m) => ({ subpath: m.subpath, via: `dropped: key also matched in group "${PREFERRED_GROUP}"; only that group is used` }))
      : [];
    return { route: pair.route, direction: pair.direction, key, matches, dropped };
  });
  const keptIds = new Set(rows.flatMap((r) => r.matches.map((m) => String(m.subpath.id))));
  const droppedIds = new Set(rows.flatMap((r) => r.dropped.map((m) => String(m.subpath.id))));
  const matchedObs = rows.filter((r) => r.matches.length > 0);
  const unmatchedObs = rows.filter((r) => r.matches.length === 0);
  const obsKeys = new Set(obsParsed.map((o) => o.key).filter((k): k is string => k !== null));

  const unmatchedSubpaths: UnmatchedSubpath[] = [...notInScenario];
  let matchedSp = 0;
  let droppedDup = 0;
  for (const { sp, key, parsed } of spInfo) {
    if (sp.exists === false) continue;
    if (key && obsKeys.has(key)) {
      if (keptIds.has(String(sp.id))) matchedSp++;
      else if (droppedIds.has(String(sp.id))) droppedDup++;
      continue;
    }
    unmatchedSubpaths.push({ subpath: sp, reason: parsed.direction ? "no-observed-route" : "no-direction-suffix", key });
  }
  return {
    rows,
    matchedObs,
    unmatchedObs,
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
