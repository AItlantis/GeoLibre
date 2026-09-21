import { useAppStore } from "@geolibre/core";
import { VEHICLE_SHAPES, VEHICLE_TYPE_COLORS, type VehicleShapeKey } from "@geolibre/plugins";
import { removeLegendCustomEntry, setLegendCustomEntry } from "./auto-legend";

/**
 * Legend integration for the vehicle-playback plugin.
 *
 * The auto-legend derives its sections from the project's `layers[]` store
 * state, but vehicle playback never creates a store layer — it renders through
 * the shared deck.gl overlay directly — so nothing about it would otherwise
 * appear in the Legend panel. `LegendConfig.customEntries` supports a
 * "standalone" section keyed by a `custom:` id that is not backed by any layer,
 * which is exactly the right integration point (see `auto-legend.ts`).
 *
 * The section is registered while the panel is open with a package loaded, and
 * removed when either stops being true, so it never outlives what it describes.
 */

/**
 * Fixed id for the vehicle-type section.
 *
 * Deliberately NOT allocated through `newCustomSectionId`: that hands out the
 * next free `custom:N` slot, which would mint a second section every time a
 * package is reloaded. A fixed id keeps registration idempotent and makes
 * removal unambiguous. It still carries the `custom:` prefix, so the legend
 * renders it as a standalone section rather than trying to bind it to a layer.
 */
export const VEHICLE_PLAYBACK_LEGEND_ID = "custom:vehicle-playback-types";

/**
 * Vehicle types listed in the legend, in the order they are drawn.
 *
 * Ordered smallest to largest so the section reads as a size progression rather
 * than the catalog's declaration order.
 */
const LEGEND_SHAPE_KEYS: readonly VehicleShapeKey[] = [
  "pedestrian",
  "bicycle",
  "car_sedan",
  "school_bus",
  "lgv",
  "hgv",
  "tram",
] as const;

/** Human labels for the catalog's shape keys. */
const SHAPE_LABELS: Record<VehicleShapeKey, string> = {
  pedestrian: "Pedestrian",
  bicycle: "Bicycle",
  car_sedan: "Car",
  school_bus: "Bus",
  lgv: "Van / LGV",
  hgv: "Truck / HGV",
  tram: "Tram",
};

/**
 * Register (or refresh) the vehicle-type legend section.
 *
 * Idempotent: writing the same rows twice leaves the store's legend config
 * value-equal, and the guard below avoids a needless `setLegend` that would
 * otherwise mark the project dirty on every package load.
 *
 * @param title - Localized section heading
 */
export function registerVehiclePlaybackLegend(title: string): void {
  const { legend, setLegend } = useAppStore.getState();
  const items = LEGEND_SHAPE_KEYS.map((key) => ({
    label: SHAPE_LABELS[key],
    color: VEHICLE_TYPE_COLORS[key],
    // Footprints are drawn as filled rectangles, so a square swatch matches
    // what is actually on the map.
    shape: "square" as const,
    // Scale the swatch by real vehicle length so the legend conveys the size
    // difference that makes the footprints readable at a glance.
    size: Math.max(6, Math.min(18, Math.round(VEHICLE_SHAPES[key].lengthM))),
  }));

  const existing = legend.customEntries?.[VEHICLE_PLAYBACK_LEGEND_ID];
  if (existing && existing.title === title && sameItems(existing.items, items)) return;

  setLegend(setLegendCustomEntry(legend, VEHICLE_PLAYBACK_LEGEND_ID, { title, items }));
}

/** Remove the vehicle-type section, if it is currently registered. */
export function unregisterVehiclePlaybackLegend(): void {
  const { legend, setLegend } = useAppStore.getState();
  if (!legend.customEntries?.[VEHICLE_PLAYBACK_LEGEND_ID]) return;
  setLegend(removeLegendCustomEntry(legend, VEHICLE_PLAYBACK_LEGEND_ID));
}

/** Whether two item lists carry the same labels, colors, shapes and sizes. */
function sameItems(
  a: readonly { label: string; color: string; shape?: string; size?: number }[],
  b: readonly { label: string; color: string; shape?: string; size?: number }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.label === other.label &&
      item.color === other.color &&
      item.shape === other.shape &&
      item.size === other.size
    );
  });
}
