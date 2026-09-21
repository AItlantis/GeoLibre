/**
 * Vehicle shape and color catalog for the vehicle-playback plugin.
 *
 * Shape footprints and the name/length resolution order are ported from
 * Testudo's `viewer/animation/vehicle-shape-catalog.js`
 * (`BUILTIN_CATALOG.shapes` and its `match_rules`); the same constants exist
 * on the Python export side (`shared/rendering/testudo_ramps.py` in the
 * Aimsun PSP repo) and must be kept in sync with this file.
 *
 * The per-shape `VEHICLE_TYPE_COLORS` palette below is NOT a port of
 * Testudo's own coloring: Testudo's `vehicle-color.js` `getVehicleColorForType`
 * keys off the Aimsun integer vehicle type via a manifest-supplied
 * `vehicle_catalog.color_map`, falling back to a single neutral teal-slate
 * `[70,96,102]` (this file's `DEFAULT_VEHICLE_COLOR`) when no such map is
 * present — it does not have a fixed per-shape palette at all. This plugin
 * has no equivalent manifest-carried color map (VWE chunk manifests don't
 * expose one), so it colors by resolved shape key instead as a distinct
 * fallback scheme, not a faithful port.
 *
 * Resolution order mirrors Testudo's `resolveShape`: substring match on the
 * vehicle's `type_name` (first rule wins), then a length-range fallback, then
 * `car_sedan`.
 */

/** Footprint of one vehicle class, in meters. */
export interface VehicleShape {
  /** Bumper-to-bumper length. */
  lengthM: number;
  /** Across-the-body width. */
  widthM: number;
  /** Ground-to-roof height, used as the 3D extrusion elevation. */
  heightM: number;
}

/** Shape keys of the built-in catalog. */
export type VehicleShapeKey =
  | "bicycle"
  | "pedestrian"
  | "car_sedan"
  | "school_bus"
  | "lgv"
  | "hgv"
  | "tram";

/**
 * Built-in footprints (Testudo `BUILTIN_CATALOG.shapes`), plus a `heightM` for
 * extrusion that Testudo's 2D catalog does not carry. Lengths and widths here
 * are DEFAULTS: when the simulator supplies its own `Length`/`Width` fields,
 * those win (see `materialize()` in `vehicle-playback-data.ts`).
 */
export const VEHICLE_SHAPES: Record<VehicleShapeKey, VehicleShape> = {
  bicycle: { lengthM: 1.8, widthM: 0.5, heightM: 1.7 },
  pedestrian: { lengthM: 0.5, widthM: 0.4, heightM: 1.75 },
  car_sedan: { lengthM: 6.063, widthM: 1.8, heightM: 1.5 },
  school_bus: { lengthM: 8.525, widthM: 2.4, heightM: 3.2 },
  lgv: { lengthM: 5.284, widthM: 2.4, heightM: 2.6 },
  hgv: { lengthM: 9.473, widthM: 2.5, heightM: 3.8 },
  tram: { lengthM: 30, widthM: 2.6, heightM: 3.4 },
};

/**
 * Substring rules applied to a lowercased `type_name`; first match wins.
 *
 * `tram` is placed FIRST because several later rules' substrings occur inside
 * real tram type names and would otherwise shadow it: "Tram (articulated)" hits
 * the `hgv` rule's "articulated", "Light Rail Vehicle" and "Streetcar" both
 * contain "car" (the `car_sedan` rule), and "Tram-Bus" hits "bus". Matching
 * tram names ahead of everything else is the only ordering that survives all
 * of those.
 */
const TYPE_NAME_RULES: readonly (readonly [readonly string[], VehicleShapeKey])[] = [
  [["tram", "streetcar", "street car", "light rail", "lightrail"], "tram"],
  [["bicycle", "bike", "cycl", "velo"], "bicycle"],
  [["pedestrian", "ped type", "external", "walk"], "pedestrian"],
  [["car"], "car_sedan"],
  [["school", "bus"], "school_bus"],
  [["lgv", "van"], "lgv"],
  [["hgv", "truck", "heavy", "semi", "lorry", "articulated"], "hgv"],
] as const;

/**
 * Length-range fallback (meters), used when no name rule matched. Literal
 * ranges from Testudo's `BUILTIN_CATALOG.shapes[].match_rules` — note the
 * `car_sedan` bucket spans `[0, 5.5)`, the same as `pedestrian`/`bicycle`'s
 * lower bound: Testudo's own rule list is itself overlapping/order-dependent
 * here (a bare `find`-first-match, not a partition), so this must be applied
 * in this exact order to match, not sorted or de-overlapped.
 *
 * Deliberately NO tram bucket: length alone cannot disambiguate a 30 m tram
 * from a 30 m road train / multi-trailer HGV, both of which are plausible in an
 * Aimsun network, and mis-resolving an HGV to `tram` would also switch on the
 * articulation rendering for it. Trams resolve by name only — every Aimsun tram
 * vehicle type carries "tram"/"light rail"/"streetcar" in its name, which the
 * first `TYPE_NAME_RULES` entry catches. A long unnamed vehicle keeps falling
 * into `hgv` as before.
 */
const LENGTH_FALLBACK_RULES: readonly (readonly [number, number, VehicleShapeKey])[] = [
  [0, 1, "pedestrian"],
  [1, 2.5, "bicycle"],
  [0, 5.5, "car_sedan"],
  [5.5, 8, "school_bus"],
  [8, 12, "lgv"],
  [12, Number.POSITIVE_INFINITY, "hgv"],
] as const;

/** Per-shape fill colors (Testudo `getVehicleColorForType`'s fallback palette). */
export const VEHICLE_TYPE_COLORS: Record<VehicleShapeKey, string> = {
  pedestrian: "#f59e0b",
  bicycle: "#8b5cf6",
  car_sedan: "#3b82f6",
  school_bus: "#eab308",
  lgv: "#10b981",
  hgv: "#ef4444",
  // Teal: distinct from car_sedan's blue and bicycle's violet at small sizes.
  tram: "#14b8a6",
};

/** Neutral teal-slate used when a type resolves to nothing recognizable. */
export const DEFAULT_VEHICLE_COLOR = "#46606a";

/**
 * Resolve a vehicle's `type_name` / length to a catalog shape key.
 *
 * @param typeName - The simulator's vehicle type name, if any
 * @param lengthM - The vehicle's length in meters, if known
 * @returns The matching shape key, defaulting to `car_sedan`
 */
export function resolveVehicleShapeKey(
  typeName: string | null | undefined,
  lengthM: number | null | undefined,
): VehicleShapeKey {
  const name = (typeName ?? "").trim().toLowerCase();
  if (name) {
    for (const [substrings, shape] of TYPE_NAME_RULES) {
      if (substrings.some((s) => name.includes(s))) return shape;
    }
  }
  if (typeof lengthM === "number" && Number.isFinite(lengthM)) {
    for (const [lo, hi, shape] of LENGTH_FALLBACK_RULES) {
      if (lengthM >= lo && lengthM < hi) return shape;
    }
  }
  return "car_sedan";
}

/** Parsed `#rrggbb` as deck.gl's `[r, g, b]` byte triple. */
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Fill color for a vehicle, as deck.gl RGB bytes.
 *
 * @param typeName - The simulator's vehicle type name, if any
 * @param lengthM - The vehicle's length in meters, if known
 * @returns `[r, g, b]` in 0-255
 */
export function vehicleColorRgb(
  typeName: string | null | undefined,
  lengthM: number | null | undefined,
): [number, number, number] {
  const key = resolveVehicleShapeKey(typeName, lengthM);
  return hexToRgb(VEHICLE_TYPE_COLORS[key] ?? DEFAULT_VEHICLE_COLOR);
}
