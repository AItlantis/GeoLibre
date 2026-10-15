/**
 * SDF glyphs for the detector direction symbols, generated in pure code (no canvas, so they
 * work in tests and workers). MapLibre recolours an SDF image with `icon-color`, so the glyphs
 * take the same metric colour as the dots. The arrow points NORTH; the symbol layer rotates it
 * with `icon-rotate` = bearing_deg.
 */

export interface SdfImage {
  width: number;
  height: number;
  /** RGBA; only the alpha channel (signed distance) matters for SDF images. */
  data: Uint8Array;
}

export const GLYPH_SIZE = 64;
export const GLYPH_PIXEL_RATIO = 2;
const RADIUS = 8; // SDF radius in px (the empty border around the shape)
const CUTOFF = 0.25; // alpha 191 sits on the outline, like tiny-sdf

type Pt = readonly [number, number];

/** North-pointing arrow in a 64 x 64 box (tip at the top). */
export const ARROW_POLYGON: readonly Pt[] = [
  [32, 8],
  [52, 32],
  [39, 32],
  [39, 56],
  [25, 56],
  [25, 32],
  [12, 32],
];

/** Rotation-neutral diamond (bidirectional / mixed / unknown direction, or no bearing). */
export const NEUTRAL_POLYGON: readonly Pt[] = [
  [32, 12],
  [52, 32],
  [32, 52],
  [12, 32],
];

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function inside(px: number, py: number, poly: readonly Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Rasterise a polygon (in glyph pixel coordinates) into an SDF image. */
export function makeSdfImage(poly: readonly Pt[], size = GLYPH_SIZE): SdfImage {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let d = Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(px, py, poly[j], poly[i]));
      const signed = inside(px, py, poly) ? -d : d; // negative inside
      const a = Math.round(Math.max(0, Math.min(255, 255 - 255 * (signed / RADIUS + CUTOFF))));
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = a;
    }
  }
  return { width: size, height: size, data };
}

export const makeArrowImage = (): SdfImage => makeSdfImage(ARROW_POLYGON);
export const makeNeutralImage = (): SdfImage => makeSdfImage(NEUTRAL_POLYGON);
