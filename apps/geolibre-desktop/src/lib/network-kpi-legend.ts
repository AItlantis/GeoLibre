import { useAppStore } from "@geolibre/core";
import { KPI_RAMPS, type NetworkKpiMetric } from "@geolibre/plugins";
import { removeLegendCustomEntry, setLegendCustomEntry } from "./auto-legend";

/**
 * Legend integration for the network-kpi plugin.
 *
 * Like vehicle-playback, this plugin renders through the shared deck.gl overlay
 * rather than through the project's `layers[]` store, so the auto-legend has
 * nothing to derive a section from. `LegendConfig.customEntries` supports a
 * standalone section keyed by a `custom:` id that is not backed by any layer,
 * which is the right integration point (see `auto-legend.ts`).
 *
 * The section is registered while the panel is open with results loaded, and
 * removed when either stops being true, so it never outlives what it describes.
 * Unlike the vehicle-type legend, its CONTENT changes with the active metric —
 * switching Flow → Speed rewrites the rows in place rather than adding a second
 * section, because the id below is fixed.
 */

/**
 * Fixed id for the KPI ramp section.
 *
 * Deliberately NOT allocated through `newCustomSectionId`: that hands out the
 * next free `custom:N` slot, which would mint a second section on every package
 * reload AND on every metric switch. A fixed id keeps registration idempotent
 * and makes removal unambiguous.
 */
export const NETWORK_KPI_LEGEND_ID = "custom:network-kpi-ramp";

/**
 * Register (or refresh) the KPI ramp legend section for one metric.
 *
 * Idempotent: re-registering the same metric leaves the store's legend config
 * value-equal, and the guard below avoids a needless `setLegend` that would
 * otherwise mark the project dirty on every render.
 *
 * @param title - Localized section heading, e.g. "Flow (veh/h)"
 * @param metric - Which ramp's five stops to list
 */
export function registerNetworkKpiLegend(title: string, metric: NetworkKpiMetric): void {
  const { legend, setLegend } = useAppStore.getState();
  const ramp = KPI_RAMPS[metric];
  // The ramp is continuous, but a legend needs discrete rows; the five stops are
  // exactly the interpolation anchors, so listing them describes the whole ramp
  // without inventing intermediate classes.
  const items = ramp.stops.map((value, index) => ({
    label: `${value} ${ramp.unit}`,
    color: ramp.colors[index],
    // Polygons are filled, so a square swatch matches what is on the map.
    shape: "square" as const,
  }));

  const existing = legend.customEntries?.[NETWORK_KPI_LEGEND_ID];
  if (existing && existing.title === title && sameItems(existing.items, items)) return;

  setLegend(setLegendCustomEntry(legend, NETWORK_KPI_LEGEND_ID, { title, items }));
}

/** Remove the KPI ramp section, if it is currently registered. */
export function unregisterNetworkKpiLegend(): void {
  const { legend, setLegend } = useAppStore.getState();
  if (!legend.customEntries?.[NETWORK_KPI_LEGEND_ID]) return;
  setLegend(removeLegendCustomEntry(legend, NETWORK_KPI_LEGEND_ID));
}

/** Whether two item lists carry the same labels, colors and shapes. */
function sameItems(
  a: readonly { label: string; color: string; shape?: string }[],
  b: readonly { label: string; color: string; shape?: string }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return item.label === other.label && item.color === other.color && item.shape === other.shape;
  });
}
