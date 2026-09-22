import type { FeatureCollection } from "geojson";
import {
  loadNetworkKpiGeometry,
  type NetworkKpiGeometrySources,
  type NetworkKpiPackageSource,
} from "./network-kpi-data";

/**
 * Load only the section centerlines required by the H3 renderer.
 *
 * Network KPI also needs lanes, turns, and nodes, but H3 does not consume
 * those layers. Keeping this read separate prevents a large package from
 * waiting on unrelated network assets before emissions can render.
 */
export async function loadEmissionsH3Geometry(
  source: NetworkKpiPackageSource,
  sources: NetworkKpiGeometrySources | string | null,
): Promise<{ sections: FeatureCollection }> {
  const normalized: NetworkKpiGeometrySources = typeof sources === "string" || sources === null
    ? { sections: sources, lanes: null, turns: null, nodes: null }
    : sources;
  const geometry = await loadNetworkKpiGeometry(source, normalized);
  const value = geometry.sections as FeatureCollection | null;
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("The package section geometry is not a valid GeoJSON FeatureCollection.");
  }
  return { sections: value };
}
