import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from "geojson";

export interface MetricLabelCandidate {
  id: string | number;
  geometry: LineString | MultiLineString;
  label: string;
  value?: number | null;
  priority?: number;
  size?: number;
}

function segmentLength(a: number[], b: number[]): number {
  const latitudeScale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * latitudeScale;
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

function midpointOfLineParts(parts: number[][][]): [number, number] | null {
  const valid = parts
    .map((part) => part.filter((coordinate) => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1])))
    .filter((part) => part.length > 0);
  const total = valid.reduce(
    (sum, part) => sum + part.slice(1).reduce((length, point, index) => length + segmentLength(part[index], point), 0),
    0,
  );
  if (!Number.isFinite(total) || total <= 0) return valid[0]?.[0] ? [valid[0][0][0], valid[0][0][1]] : null;
  let remaining = total / 2;
  for (const part of valid) {
    for (let index = 1; index < part.length; index += 1) {
      const a = part[index - 1];
      const b = part[index];
      const length = segmentLength(a, b);
      if (remaining <= length) {
        const t = length === 0 ? 0 : remaining / length;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      remaining -= length;
    }
  }
  const last = valid.at(-1)?.at(-1);
  return last ? [last[0], last[1]] : null;
}

export function lineMetricLabelAnchor(geometry: LineString | MultiLineString): [number, number] | null {
  return geometry.type === "LineString"
    ? midpointOfLineParts([geometry.coordinates as number[][]])
    : midpointOfLineParts(geometry.coordinates as number[][][]);
}

/**
 * Create collision-aware point labels for line metrics. Lower sort keys win;
 * the stable value/id ordering makes the winner deterministic at shared links.
 */
export function buildMetricLabelFeatures(
  candidates: readonly MetricLabelCandidate[],
  defaultSize = 11,
): FeatureCollection<Point> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0) ||
      String(a.candidate.id).localeCompare(String(b.candidate.id)) ||
      a.index - b.index,
    );
  const features: Feature<Point>[] = [];
  ordered.forEach(({ candidate }, priority) => {
    const coordinates = lineMetricLabelAnchor(candidate.geometry);
    if (!coordinates) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: {
        label: candidate.label,
        labelId: String(candidate.id),
        labelPriority: priority,
        labelSize: candidate.size ?? defaultSize,
        metricValue: candidate.value ?? null,
      },
    });
  });
  return { type: "FeatureCollection", features };
}

export function metricLabelLayerLayout(labelSize: number): Record<string, unknown> {
  return {
    "text-field": ["get", "label"],
    "text-size": ["coalesce", ["get", "labelSize"], labelSize],
    "text-allow-overlap": false,
    "text-ignore-placement": false,
    "text-padding": 2,
    "symbol-placement": "point",
    "symbol-sort-key": ["get", "labelPriority"],
  };
}

/** Truthful compact metric labels; missing values are never presented as zero. */
export function formatMetricLabel(value: unknown, unit: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return `No data`;
  if (unit === "trips") {
    if (value === 0) return "0 trips";
    if (Math.abs(value) < 1) return "<1 trip";
    const decimals = Math.abs(value) < 10 ? 1 : 0;
    return `${value.toFixed(decimals)} trips`;
  }
  return `${value.toFixed(1)}${unit}`;
}

