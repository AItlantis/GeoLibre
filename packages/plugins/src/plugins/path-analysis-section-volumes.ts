import type { PathMatch, PathSectionVolume } from "./path-analysis-data";

export interface PositionalRouteLink {
  route_id: number;
  section_id: number;
  pos: number;
}

/**
 * Aggregate one contribution per route/section. Repeated occurrences of a
 * section on one route intentionally do not multiply that route's demand.
 * For looping routes that place a section both before and after the reference,
 * its nearest occurrence determines that route's side; ties use upstream.
 */
export function aggregatePathSectionVolumes(
  matches: readonly PathMatch[],
  routeLinks: readonly PositionalRouteLink[],
  selectedSection: number,
): { selectedVolume: number; sections: PathSectionVolume[] } {
  const reference = Math.trunc(Number(selectedSection));
  if (!Number.isFinite(reference)) return { selectedVolume: 0, sections: [] };

  const uniqueMatches = new Map<number, PathMatch>();
  for (const match of matches) {
    const routeId = Math.trunc(Number(match.route_id));
    if (Number.isFinite(routeId) && !uniqueMatches.has(routeId)) uniqueMatches.set(routeId, match);
  }

  const linksByRoute = new Map<number, PositionalRouteLink[]>();
  for (const link of routeLinks) {
    const routeId = Math.trunc(Number(link.route_id));
    const sectionId = Math.trunc(Number(link.section_id));
    const pos = Number(link.pos);
    if (!uniqueMatches.has(routeId) || !Number.isFinite(sectionId) || !Number.isFinite(pos)) continue;
    const list = linksByRoute.get(routeId) ?? [];
    list.push({ route_id: routeId, section_id: sectionId, pos });
    linksByRoute.set(routeId, list);
  }

  let selectedVolume = 0;
  const volumes = new Map<number, { total: number; upstream: number; selected: number; downstream: number }>();
  for (const [routeId, match] of uniqueMatches) {
    const routeDemand = Number(match.demand);
    const demand = Number.isFinite(routeDemand) && routeDemand > 0 ? routeDemand : 0;
    const ordered = (linksByRoute.get(routeId) ?? []).sort((a, b) => a.pos - b.pos);
    const referenceIndexes = ordered.flatMap((link, index) => link.section_id === reference ? [index] : []);
    if (!referenceIndexes.length) continue; // Anchor every contribution to the selected section.
    selectedVolume += demand;
    // Collapse repeated route_links occurrences before accumulating demand.
    // For loops, classify each section by its nearest occurrence of the
    // selected link; ties are resolved upstream for stable results.
    const perRoute = new Map<number, Set<"upstream" | "downstream" | "selected">>();
    for (let index = 0; index < ordered.length; index += 1) {
      const sectionId = ordered[index].section_id;
      const distances = referenceIndexes.map((referenceIndex) => ({ distance: Math.abs(index - referenceIndex), role: index < referenceIndex ? "upstream" as const : index > referenceIndex ? "downstream" as const : "selected" as const }));
      distances.sort((a, b) => a.distance - b.distance || (a.role === b.role ? 0 : a.role === "upstream" ? -1 : b.role === "upstream" ? 1 : a.role === "selected" ? -1 : 1));
      const roles = perRoute.get(sectionId) ?? new Set<"upstream" | "downstream" | "selected">();
      roles.add(distances[0].role);
      perRoute.set(sectionId, roles);
    }

    for (const [sectionId, roles] of perRoute) {
      const entry = volumes.get(sectionId) ?? { total: 0, upstream: 0, selected: 0, downstream: 0 };
      entry.total += demand;
      for (const role of roles) entry[role] += demand;
      volumes.set(sectionId, entry);
    }
  }

  if (!(selectedVolume > 0)) return { selectedVolume: 0, sections: [] };
  const sections: PathSectionVolume[] = [];
  for (const [section_id, entry] of volumes) {
    if (section_id === reference) sections.push({ section_id, volume: entry.total, totalVolume: entry.total, percentage: 100, role: "selected" });
    else {
      if (entry.upstream > 0) sections.push({ section_id, volume: entry.upstream, totalVolume: entry.total, percentage: entry.upstream / selectedVolume * 100, role: "upstream" });
      if (entry.downstream > 0) sections.push({ section_id, volume: entry.downstream, totalVolume: entry.total, percentage: entry.downstream / selectedVolume * 100, role: "downstream" });
    }
  }
  sections.sort((a, b) => a.section_id - b.section_id);
  return { selectedVolume, sections };
}
