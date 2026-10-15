/**
 * Line paint shared by the route overlay and the section layer. On a pitched (tilted) map a constant pixel
 * width thins out towards the horizon and, with a thin line, can vanish entirely; so the widths are
 * interpolated on zoom (map-aligned: they grow as the camera comes closer), never drop under a minimum pixel
 * width, and every line is drawn over a wider casing that keeps it readable on any basemap.
 */

/** [zoom, multiplier of the base width]. */
export const WIDTH_ZOOM_STOPS: ReadonlyArray<readonly [number, number]> = [[8, 0.5], [12, 1], [16, 2], [20, 4]];
/** Never thinner than this many pixels, at any zoom. */
export const MIN_LINE_PX = 2;
/** Casing is this many pixels wider than the line it sits under. */
export const CASING_EXTRA_PX = 3;

type Expr = number | unknown[];

/** MapLibre `line-width` expression: zoom interpolation of `base` (a number or a feature expression), floored at `minPx`. */
export function zoomLineWidth(base: Expr, minPx = MIN_LINE_PX): unknown[] {
  const out: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, k] of WIDTH_ZOOM_STOPS) out.push(z, ["max", minPx, ["*", base, k]]);
  return out;
}

/** Numeric width of `basePx` at a zoom stop (what the expression evaluates to for a constant base). */
export function lineWidthAt(basePx: number, zoom: number, minPx = MIN_LINE_PX): number {
  const s = WIDTH_ZOOM_STOPS;
  const w = (i: number): number => Math.max(minPx, basePx * s[i][1]);
  if (zoom <= s[0][0]) return w(0);
  for (let i = 1; i < s.length; i++) {
    if (zoom <= s[i][0]) {
      const f = (zoom - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      return w(i - 1) + (w(i) - w(i - 1)) * f;
    }
  }
  return w(s.length - 1);
}

/** Casing width expression: the line width plus CASING_EXTRA_PX. */
export function zoomCasingWidth(base: Expr, minPx = MIN_LINE_PX): unknown[] {
  return zoomLineWidth(["+", base, CASING_EXTRA_PX], minPx + CASING_EXTRA_PX);
}
