export interface NumericColorRamp {
  readonly stops: readonly number[];
  readonly colors: readonly string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.replace(/^#/, ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Build the same MapLibre interpolation expression used by metric layers. */
export function metricRampExpression(
  property: string,
  ramp: NumericColorRamp,
): unknown[] {
  const expression: unknown[] = ["interpolate", ["linear"], ["get", property]];
  ramp.stops.forEach((stop, index) => {
    expression.push(stop, ramp.colors[index]);
  });
  return expression;
}

/** Sample a numeric ramp for deck.gl and other non-MapLibre renderers. */
export function sampleMetricRamp(
  value: number,
  ramp: NumericColorRamp,
): [number, number, number] {
  const stops = ramp.stops;
  const x = clamp(value, stops[0], stops[stops.length - 1]);
  let index = stops.findIndex((stop) => stop >= x);
  if (index <= 0) return rgb(ramp.colors[0]);
  if (index < 0) index = stops.length - 1;
  const lower = stops[index - 1];
  const upper = stops[index];
  const from = rgb(ramp.colors[index - 1]);
  const to = rgb(ramp.colors[index]);
  const t = upper === lower ? 0 : (x - lower) / (upper - lower);
  return [0, 1, 2].map((channel) =>
    Math.round(from[channel] + (to[channel] - from[channel]) * t),
  ) as [number, number, number];
}

/** Keep legend stop positions faithful to the numeric domain. */
export function metricRampCssGradient(ramp: NumericColorRamp): string {
  const first = ramp.stops[0];
  const last = ramp.stops[ramp.stops.length - 1];
  const span = last - first || 1;
  return `linear-gradient(to right, ${ramp.colors
    .map((color, index) => `${color} ${((ramp.stops[index] - first) / span) * 100}%`)
    .join(", ")})`;
}

