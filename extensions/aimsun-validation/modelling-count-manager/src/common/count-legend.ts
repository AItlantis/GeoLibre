/**
 * Map legend for the detector layer (contract C14): colour ramp AND size ramp of the metric the
 * map is drawn with (min/max values with units), plus the direction note for arrow glyphs. The
 * model is pure (unit-tested); the DOM is built with the same `el` helper as the rest of the panel
 * and lives in the panel's legend area (.av-legend / .av-legend-block).
 */
import { DIVERGING_STOPS, glyphHeightPx, SEQUENTIAL_STOPS, SIZE_MAX_R, SIZE_MIN_R } from "./map-layer.ts";
import type { Translate } from "./ui.ts";
import { el } from "./ui.ts";

export type CountMetric = "sim" | "obs" | "diff";

export interface CountLegendSpec {
  /** Property that drives the colour ramp. */
  colorBy: CountMetric;
  /** Property that drives the size ramp ("sim" | "obs"). */
  sizeBy: "sim" | "obs";
  maxSize: number;
  maxColor: number;
  /** True when the package has coverage glyphs (arrows / diamonds) instead of plain dots only. */
  glyphs: boolean;
}

export interface CountLegendModel {
  colorTitle: { key: string; en: string };
  colorStops: string[];
  colorMin: number;
  colorMax: number;
  diverging: boolean;
  sizeTitle: { key: string; en: string };
  sizeMin: number;
  sizeMax: number;
  /** Rendered size (CSS px) of the smallest / largest symbol: glyph height, or circle diameter for dots. */
  sizeMinPx: number;
  sizeMaxPx: number;
  glyphs: boolean;
}

const METRIC_LABEL: Record<CountMetric, { key: string; en: string }> = {
  sim: { key: "legend.colorSim", en: "Colour: simulated flow (veh/h)" },
  obs: { key: "legend.colorObs", en: "Colour: observed flow (veh/h)" },
  diff: { key: "legend.colorDiff", en: "Colour: difference sim - obs (veh/h)" },
};
const SIZE_LABEL: Record<"sim" | "obs", { key: string; en: string }> = {
  sim: { key: "legend.sizeSim", en: "Size: simulated flow (veh/h)" },
  obs: { key: "legend.sizeObs", en: "Size: observed flow (veh/h)" },
};

export function countLegendModel(spec: CountLegendSpec): CountLegendModel {
  const diverging = spec.colorBy === "diff";
  const maxColor = Math.max(1, spec.maxColor);
  const maxSize = Math.max(1, spec.maxSize);
  return {
    colorTitle: METRIC_LABEL[spec.colorBy],
    colorStops: [...(diverging ? DIVERGING_STOPS : SEQUENTIAL_STOPS)],
    colorMin: diverging ? -maxColor : 0,
    colorMax: maxColor,
    diverging,
    sizeTitle: SIZE_LABEL[spec.sizeBy],
    sizeMin: 0,
    sizeMax: maxSize,
    sizeMinPx: spec.glyphs ? glyphHeightPx(SIZE_MIN_R) : SIZE_MIN_R * 2,
    sizeMaxPx: spec.glyphs ? glyphHeightPx(SIZE_MAX_R) : SIZE_MAX_R * 2,
    glyphs: spec.glyphs,
  };
}

export interface LegendCtx {
  t: Translate;
  fmt: { int: (v: number | null | undefined) => string };
}

/** "Arrows point along the detector's travel direction..." (shown for count and validation modes). */
export function directionNote(ctx: Pick<LegendCtx, "t">): HTMLElement {
  return el("p", {
    class: "av-hint",
    attrs: { "data-testid": "legend-direction" },
    text: ctx.t("legend.direction", "Arrows point in the detector's direction of travel (bearing, clockwise from north). Diamonds: both directions or direction unknown. Grey: no external id."),
  });
}

export function countLegend(ctx: LegendCtx, spec: CountLegendSpec): HTMLElement {
  const { t, fmt } = ctx;
  const m = countLegendModel(spec);
  const gradient = `linear-gradient(to right, ${m.colorStops.join(", ")})`;
  const symbol = (px: number): HTMLElement =>
    m.glyphs
      ? el("span", { class: "av-glyph", text: "▲", attrs: { style: `font-size:${Math.round(px)}px`, "aria-hidden": "true" } })
      : el("span", { class: "av-dot", attrs: { style: `inline-size:${Math.round(px)}px;block-size:${Math.round(px)}px;background:#41ab5d`, "aria-hidden": "true" } });
  const root = el("div", { class: "av-legend-block", attrs: { "data-testid": "count-legend" } }, [
    el("p", { class: "av-legend-title", text: t(m.colorTitle.key, m.colorTitle.en) }),
    el("div", { class: "av-ramp", attrs: { "data-testid": "legend-colour-ramp", style: `background:${gradient}`, role: "img", "aria-label": t(m.colorTitle.key, m.colorTitle.en) } }),
    el("div", { class: "av-ramp-scale", attrs: { "data-testid": "legend-colour-scale" } }, [
      el("span", { text: fmt.int(m.colorMin) }),
      m.diverging ? el("span", { text: "0" }) : null,
      el("span", { text: fmt.int(m.colorMax) }),
    ]),
    m.diverging ? el("p", { class: "av-hint", text: t("legend.diverging", "Blue: simulated below observed. Red: above.") }) : null,
    el("p", { class: "av-legend-title", text: t(m.sizeTitle.key, m.sizeTitle.en) }),
    el("div", { class: "av-size-ramp", attrs: { "data-testid": "legend-size-ramp" } }, [
      symbol(m.sizeMinPx),
      el("span", { text: fmt.int(m.sizeMin) }),
      el("span", { class: "av-size-sep", text: "→" }),
      symbol(m.sizeMaxPx),
      el("span", { text: fmt.int(m.sizeMax) }),
    ]),
    m.glyphs ? directionNote(ctx) : null,
  ]);
  return root;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export function cardinal(deg: number): string {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Tooltip line for the detector direction (bearing), or none when the direction is unknown. */
export function directionTip(t: Translate, p: Record<string, unknown>): string[] {
  const b = p.bearing_deg;
  if (p.glyph === "arrow" && typeof b === "number" && Number.isFinite(b)) {
    return [t("tip.dir", "Direction: {{deg}}° ({{card}})", { deg: Math.round(((b % 360) + 360) % 360), card: cardinal(b) })];
  }
  if (p.direction === "bidirectional" || p.direction === "mixed") return [t("tip.dirBoth", "Direction: both ways")];
  return [];
}
