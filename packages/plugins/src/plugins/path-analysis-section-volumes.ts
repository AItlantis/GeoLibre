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
  const volumes = new Map<number, number>();
  const sideVolumes = new Map<number, { upstream: number; downstream: number }>();
  for (const [routeId, match] of uniqueMatches) {
    const routeDemand = Number(match.demand);
    const demand = Number.isFinite(routeDemand) && routeDemand > 0 ? routeDemand : 0;
    const ordered = (linksByRoute.get(routeId) ?? []).sort((a, b) => a.pos - b.pos);
    const referenceIndexes = ordered.flatMap((link, index) => link.section_id === reference ? [index] : []);
    if (!referenceIndexes.length) continue; // Anchor every contribution to the selected section.
    selectedVolume += demand;
    const firstReference = referenceIndexes[0];
    const lastReference = referenceIndexes[referenceIndexes.length - 1];

    // Collapse repeated route_links occurrences before accumulating demand.
    const perRoute = new Map<number, "upstream" | "downstream" | "selected">();
    for (let index = 0; index < ordered.length; index += 1) {
      const sectionId = ordered[index].section_id;
      let role: "upstream" | "downstream" | "selected";
      if (sectionId === reference) role = "selected";
      else if (index < firstReference) role = "upstream";
      else if (index > lastReference) role = "downstream";
      else {
        // A loop may revisit the reference between occurrences. Attribute a
        // section between them to its nearest reference occurrence.
        const before = index - firstReference;
        const after = lastReference - index;
        role = before <= after ? "upstream" : "downstream";
      }
      const existing = perRoute.get(sectionId);
      if (!existing || role === "selected") perRoute.set(sectionId, role);
      else if (existing !== role) perRoute.set(sectionId, "upstream");
    }

    for (const [sectionId, role] of perRoute) {
      volumes.set(sectionId, (volumes.get(sectionId) ?? 0) + demand);
      if (role === "selected") continue;
      const sides = sideVolumes.get(sectionId) ?? { upstream: 0, downstream: 0 };
      sides[role] += demand;
      sideVolumes.set(sectionId, sides);
    }
  }

  if (!(selectedVolume > 0)) return { selectedVolume: 0, sections: [] };
  const sections: PathSectionVolume[] = [...volumes.entries()].map(([section_id, volume]) => {
    const role = section_id === reference
      ? "selected"
      : (sideVolumes.get(section_id)?.upstream ?? 0) >= (sideVolumes.get(section_id)?.downstream ?? 0)
        ? "upstream"
        : "downstream";
    return { section_id, volume, percentage: role === "selected" ? 100 : volume / selectedVolume * 100, role };
  });
  sections.sort((a, b) => a.section_id - b.section_id);
  return { selectedVolume, sections };
}
