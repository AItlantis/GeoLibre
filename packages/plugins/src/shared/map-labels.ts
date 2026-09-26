export interface MapLabelPoint {
  position: readonly [number, number];
  priority?: number;
  text?: string;
  widthPx?: number;
  heightPx?: number;
}

export const MAPLIBRE_LABEL_LAYOUT = {
  "text-allow-overlap": false,
  "text-ignore-placement": false,
  "text-padding": 6,
  "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
  "text-radial-offset": 0.35,
} as const;

export const MAPLIBRE_LABEL_PAINT = {
  "text-color": "#10243a",
  "text-halo-color": "rgba(255,255,255,0.98)",
  "text-halo-width": 2,
  "text-halo-blur": 0.25,
} as const;

/** Keep a delta visible at the cutoff; suppress values strictly inside it. */
export function passesDifferenceThreshold(value: unknown, threshold: number): boolean {
  if (value === null || value === undefined || value === "") return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.abs(numeric) >= Math.max(0, Number(threshold) || 0);
}

export function passesComparisonDifferenceFilter(
  metric: string,
  value: unknown,
  flowDelta: unknown,
  densityDelta: unknown,
  threshold: number,
): boolean {
  if (metric === "cmp_flow_sign") return passesDifferenceThreshold(flowDelta, threshold);
  if (metric === "cmp_flow_density_quadrant") {
    const flow = flowDelta === null || flowDelta === undefined ? Number.NaN : Number(flowDelta);
    const density = densityDelta === null || densityDelta === undefined ? Number.NaN : Number(densityDelta);
    const magnitudes = [flow, density].filter(Number.isFinite).map(Math.abs);
    return passesDifferenceThreshold(magnitudes.length ? Math.max(...magnitudes) : null, threshold);
  }
  return passesDifferenceThreshold(value, threshold);
}

/** Compact signed difference text, rounded to tens or hundreds by magnitude. */
export function formatRoundedDifference(value: number): string {
  if (!Number.isFinite(value)) return "";
  const step = Math.abs(value) >= 1000 ? 100 : 10;
  const rounded = Math.sign(value) * Math.round(Math.abs(value) / step) * step;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toLocaleString()}`;
}

export function formatTripVolume(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.05) return "<0.1";
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Midpoint by cumulative planar segment length for a geographic line. */
export function lineMidpoint(coordinates: readonly (readonly [number, number])[]): [number, number] | null {
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return [coordinates[0][0], coordinates[0][1]];
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [lon1, lat1] = coordinates[index - 1];
    const [lon2, lat2] = coordinates[index];
    const meanLat = (lat1 + lat2) * Math.PI / 360;
    const length = Math.hypot((lon2 - lon1) * Math.cos(meanLat), lat2 - lat1);
    lengths.push(length);
    total += length;
  }
  if (!Number.isFinite(total)) return null;
  const target = total / 2;
  let traversed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (traversed + length >= target && length > 0) {
      const ratio = (target - traversed) / length;
      const a = coordinates[index], b = coordinates[index + 1];
      return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
    }
    traversed += length;
  }
  const last = coordinates[coordinates.length - 1];
  return [last[0], last[1]];
}

/** Screen-space decluttering for renderers (such as deck.gl TextLayer) without built-in collision placement. */
export function declutterMapLabels<T extends MapLabelPoint>(
  labels: readonly T[],
  project: (position: readonly [number, number]) => { x: number; y: number },
  minDistancePx = 48,
): T[] {
  const distance = Math.max(1, minDistancePx);
  const accepted: Array<{ label: T; x: number; y: number }> = [];
  const buckets = new Map<string, Set<number>>();
  const cellSize = Math.max(16, Math.min(48, distance));
  const sorted = [...labels].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const label of sorted) {
    const point = project(label.position);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const width = Math.max(distance, label.widthPx ?? ((label.text?.length ?? 6) * 8 + 12));
    const height = Math.max(18, label.heightPx ?? 22);
    const box = { left: point.x - width / 2, right: point.x + width / 2, top: point.y - height / 2, bottom: point.y + height / 2 };
    const minX = Math.floor(box.left / cellSize), maxX = Math.floor(box.right / cellSize);
    const minY = Math.floor(box.top / cellSize), maxY = Math.floor(box.bottom / cellSize);
    let collides = false;
    const candidates = new Set<number>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (const index of buckets.get(`${x}:${y}`) ?? []) candidates.add(index);
      }
    }
    for (const index of candidates) {
      const other = accepted[index];
      const otherWidth = Math.max(distance, other.label.widthPx ?? ((other.label.text?.length ?? 6) * 8 + 12));
      const otherHeight = Math.max(18, other.label.heightPx ?? 22);
      if (Math.abs(other.x - point.x) < (otherWidth + width) / 2 && Math.abs(other.y - point.y) < (otherHeight + height) / 2) {
        collides = true;
        break;
      }
    }
    if (!collides) {
      const index = accepted.push({ label, x: point.x, y: point.y }) - 1;
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x}:${y}`;
          const bucket = buckets.get(key) ?? new Set<number>();
          bucket.add(index);
          buckets.set(key, bucket);
        }
      }
    }
  }
  return accepted.map((entry) => entry.label);
}
