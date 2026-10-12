/**
 * Hand-written SVG chart helpers (scatter + identity line + OLS trendline, histogram, bar).
 * Plugins render plain DOM (they cannot share the host's React), so these return SVG
 * strings; use {@link mountChart} to put one in a container. Styling follows
 * apps/geolibre-desktop/src/components/panels/charts/chart-view.tsx: theme CSS variables
 * (hsl(var(--border)) etc.), self-scaling viewBox. Text uses start/middle/end anchors (which
 * follow the writing direction); wrapper CSS uses logical properties only.
 */

export const CHART_W = 560;
export const CHART_H = 300;
/** Shared traffic-validation status ramp: pass, warning and fail. */
export const STATUS_COLORS = Object.freeze({ pass: "#2e7d32", warn: "#f9a825", fail: "#c62828" });
const M = { top: 16, right: 16, bottom: 52, left: 52 };
const IW = CHART_W - M.left - M.right;
const IH = CHART_H - M.top - M.bottom;
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
const SERIES = "hsl(var(--primary))";
const ACCENT = "hsl(var(--destructive, 0 70% 50%))";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

export function formatTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${f(v / 1e6)}M`;
  if (a >= 1e3) return `${f(v / 1e3)}k`;
  if (a !== 0 && a < 0.01) return v.toExponential(1);
  return f(v);
}

/** "Nice" ticks across [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const frac = (v: number, lo: number, hi: number): number => (hi === lo ? 0.5 : (v - lo) / (hi - lo));

function frame(label: string, body: string, xTitle?: string, yTitle?: string): string {
  return (
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" role="img" aria-label="${esc(label)}" ` +
    `style="height:auto;inline-size:100%" preserveAspectRatio="xMidYMid meet">` +
    `<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + IH}" stroke="${AXIS}"/>` +
    `<line x1="${M.left}" y1="${M.top + IH}" x2="${M.left + IW}" y2="${M.top + IH}" stroke="${AXIS}"/>` +
    body +
    (xTitle ? `<text x="${M.left + IW / 2}" y="${CHART_H - 6}" text-anchor="middle" font-size="11" fill="${TICK}">${esc(xTitle)}</text>` : "") +
    (yTitle
      ? `<text transform="translate(12 ${M.top + IH / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${TICK}">${esc(yTitle)}</text>`
      : "") +
    `</svg>`
  );
}

function xAxis(ticks: number[], lo: number, hi: number): string {
  return ticks
    .map((t) => {
      const x = M.left + frac(t, lo, hi) * IW;
      return (
        `<line x1="${f(x)}" y1="${M.top + IH}" x2="${f(x)}" y2="${M.top + IH + 4}" stroke="${AXIS}"/>` +
        `<text x="${f(x)}" y="${M.top + IH + 16}" text-anchor="middle" font-size="10" fill="${TICK}">${esc(formatTick(t))}</text>`
      );
    })
    .join("");
}

function yAxis(ticks: number[], lo: number, hi: number): string {
  return ticks
    .map((t) => {
      const y = M.top + IH - frac(t, lo, hi) * IH;
      return (
        `<line x1="${M.left - 4}" y1="${f(y)}" x2="${M.left}" y2="${f(y)}" stroke="${AXIS}"/>` +
        `<line x1="${M.left}" y1="${f(y)}" x2="${M.left + IW}" y2="${f(y)}" stroke="${AXIS}" stroke-opacity="0.25"/>` +
        `<text x="${M.left - 7}" y="${f(y)}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="${TICK}">${esc(formatTick(t))}</text>`
      );
    })
    .join("");
}

export interface ScatterOptions {
  xTitle?: string;
  yTitle?: string;
  label?: string;
  identityLine?: boolean;
  /** OLS trendline y = slope * x + intercept; omit to hide. */
  trend?: { slope: number; intercept: number } | null;
  color?: string;
  radius?: number;
  /** Optional per-point colour (e.g. by GEH status). */
  pointColor?: (i: number) => string | undefined;
}

/** Scatter of y vs x on a common square-ish domain (so the identity line is meaningful). */
export function scatterSvg(x: readonly number[], y: readonly number[], o: ScatterOptions = {}): string {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) pts.push([x[i], y[i], i]);
  if (!pts.length) return emptySvg(o.label ?? "scatter");
  const all = pts.flatMap((p) => [p[0], p[1]]);
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const px = (v: number) => M.left + frac(v, lo, hi) * IW;
  const py = (v: number) => M.top + IH - frac(v, lo, hi) * IH;
  const clip = `<clipPath id="plot-clip"><rect x="${M.left}" y="${M.top}" width="${IW}" height="${IH}"/></clipPath>`;
  let body = clip + xAxis(ticks, lo, hi) + yAxis(ticks, lo, hi);
  if (o.identityLine ?? true) {
    body += `<line x1="${f(px(lo))}" y1="${f(py(lo))}" x2="${f(px(hi))}" y2="${f(py(hi))}" stroke="${TICK}" stroke-dasharray="4 3" clip-path="url(#plot-clip)"/>`;
  }
  if (o.trend) {
    const { slope, intercept } = o.trend;
    body += `<line x1="${f(px(lo))}" y1="${f(py(slope * lo + intercept))}" x2="${f(px(hi))}" y2="${f(py(slope * hi + intercept))}" stroke="${ACCENT}" stroke-width="1.5" clip-path="url(#plot-clip)"/>`;
  }
  const r = o.radius ?? 2.5;
  body += pts
    .map(([a, b, i]) => `<circle cx="${f(px(a))}" cy="${f(py(b))}" r="${r}" fill="${o.pointColor?.(i) ?? o.color ?? SERIES}" fill-opacity="0.6"/>`)
    .join("");
  return frame(o.label ?? "scatter", body, o.xTitle, o.yTitle);
}

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
}

export interface BarOptions {
  xTitle?: string;
  yTitle?: string;
  label?: string;
  color?: string;
  maxLabelChars?: number;
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Vertical bar chart; negative values hang below a zero line. */
export function barSvg(data: readonly BarDatum[], o: BarOptions = {}): string {
  if (!data.length) return emptySvg(o.label ?? "bar");
  const lo = Math.min(0, ...data.map((d) => d.value));
  let hi = Math.max(0, ...data.map((d) => d.value));
  if (hi === lo) hi = lo + 1;
  const ticks = niceTicks(lo, hi);
  const dlo = Math.min(lo, ticks[0]);
  const dhi = Math.max(hi, ticks[ticks.length - 1]);
  const py = (v: number) => M.top + IH - frac(v, dlo, dhi) * IH;
  const slot = IW / data.length;
  const bw = Math.max(2, slot * 0.7);
  const maxChars = o.maxLabelChars ?? 14;
  let body = yAxis(ticks, dlo, dhi);
  data.forEach((d, i) => {
    const x = M.left + i * slot + (slot - bw) / 2;
    const y0 = py(0);
    const y1 = py(d.value);
    body += `<rect x="${f(x)}" y="${f(Math.min(y0, y1))}" width="${f(bw)}" height="${f(Math.abs(y1 - y0))}" fill="${d.color ?? o.color ?? SERIES}"><title>${esc(d.label)}: ${esc(formatTick(d.value))}</title></rect>`;
    if (data.length <= 24) {
      const cx = x + bw / 2;
      body += `<text transform="translate(${f(cx)} ${M.top + IH + 12}) rotate(-35)" text-anchor="end" font-size="9" fill="${TICK}">${esc(trunc(d.label, maxChars))}</text>`;
    }
  });
  body += `<line x1="${M.left}" y1="${f(py(0))}" x2="${M.left + IW}" y2="${f(py(0))}" stroke="${AXIS}"/>`;
  return frame(o.label ?? "bar", body, o.xTitle, o.yTitle);
}

export interface HistBin {
  start: number;
  end: number;
  value: number;
}

export interface HistogramOptions {
  xTitle?: string;
  yTitle?: string;
  label?: string;
  color?: string;
  binColor?: (bin: HistBin, index: number) => string | undefined;
  guides?: readonly { value: number; label?: string; color?: string }[];
}

/** Histogram over contiguous bins. */
export function histogramSvg(bins: readonly HistBin[], o: HistogramOptions = {}): string {
  if (!bins.length) return emptySvg(o.label ?? "histogram");
  const xlo = Math.min(...bins.map((b) => b.start));
  const xhi = Math.max(...bins.map((b) => b.end));
  const yhi0 = Math.max(...bins.map((b) => b.value), 0) || 1;
  const yt = niceTicks(0, yhi0);
  const yhi = Math.max(yhi0, yt[yt.length - 1]);
  const px = (v: number) => M.left + frac(v, xlo, xhi) * IW;
  const py = (v: number) => M.top + IH - frac(v, 0, yhi) * IH;
  let body = xAxis(niceTicks(xlo, xhi), xlo, xhi) + yAxis(yt, 0, yhi);
  bins.forEach((b, i) => {
    const x0 = px(b.start);
    const x1 = px(b.end);
    body += `<rect x="${f(x0)}" y="${f(py(b.value))}" width="${f(Math.max(1, x1 - x0 - 1))}" height="${f(M.top + IH - py(b.value))}" fill="${esc(o.binColor?.(b, i) ?? o.color ?? SERIES)}"><title>${esc(`${formatTick(b.start)}-${formatTick(b.end)}: ${formatTick(b.value)}`)}</title></rect>`;
  });
  for (const g of o.guides ?? []) {
    const x = px(g.value);
    body += `<line x1="${f(x)}" y1="${M.top}" x2="${f(x)}" y2="${M.top + IH}" stroke="${esc(g.color ?? ACCENT)}" stroke-width="1.5" stroke-dasharray="4 3"><title>${esc(g.label ?? formatTick(g.value))}</title></line>`;
  }
  return frame(o.label ?? "histogram", body, o.xTitle, o.yTitle);
}

function emptySvg(label: string): string {
  return (
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" role="img" aria-label="${esc(label)}" style="height:auto;inline-size:100%">` +
    `<text x="${CHART_W / 2}" y="${CHART_H / 2}" text-anchor="middle" font-size="12" fill="${TICK}">No data</text></svg>`
  );
}

/** Put a chart (from the *Svg helpers) into a container element. Content is generated + escaped here. */
export function mountChart(container: HTMLElement, svg: string): void {
  container.innerHTML = svg;
}


export interface TimeSeriesPoint { minute: number; value: number }
export interface SimulatedSegment { value: number; startMin: number; endMin: number }
export interface DayProfileSeries { observed: TimeSeriesPoint[]; simulated: SimulatedSegment[]; simStartMin: number | null; simEndMin: number | null; observedWindowMean: number | null }

/** Assemble a day profile from an arbitrary simulated interval series. */
export function assembleDayProfile(observed: readonly TimeSeriesPoint[], simulated: readonly SimulatedSegment[] | null): DayProfileSeries {
  const series = observed.filter((p) => Number.isFinite(p.minute) && Number.isFinite(p.value) && p.minute >= 0 && p.minute < 1440)
    .map((p) => ({ minute: p.minute, value: p.value })).sort((a, b) => a.minute - b.minute);
  const sims = (simulated ?? []).filter((p) => Number.isFinite(p.value) && Number.isFinite(p.startMin) && Number.isFinite(p.endMin) && p.startMin >= 0 && p.endMin > p.startMin && p.startMin < 1440)
    .map((p) => ({ ...p, endMin: Math.min(1440, p.endMin) })).sort((a, b) => a.startMin - b.startMin);
  const start = sims.length ? Math.min(...sims.map((p) => p.startMin)) : null;
  const end = sims.length ? Math.max(...sims.map((p) => p.endMin)) : null;
  const inWindow = start === null || end === null ? [] : series.filter((p) => p.minute >= start && p.minute < end);
  return { observed: series, simulated: sims,
    simStartMin: start, simEndMin: end,
    observedWindowMean: inWindow.length ? inWindow.reduce((sum, p) => sum + p.value, 0) / inWindow.length : null };
}

export interface TimeSeriesOptions { label?: string; xTitle?: string; yTitle?: string; observedLabel?: string; simulatedLabel?: string; color?: string; simColor?: string }

/** Observed day curve with a simulated-window band and horizontal simulated segment. */
export function timeSeriesSvg(series: DayProfileSeries, o: TimeSeriesOptions = {}): string {
  const values = [...series.observed.map((p) => p.value), ...series.simulated.map((p) => p.value)].filter(Number.isFinite);
  if (!values.length) return emptySvg(o.label ?? "Day profile");
  const ymax = Math.max(1, ...values) * 1.1;
  const px = (min: number) => M.left + min / 1440 * IW;
  const py = (v: number) => M.top + IH - v / ymax * IH;
  const hourTicks = [0, 360, 720, 1080, 1440];
  let body = hourTicks.map((minute) => {
    const x = px(minute);
    return "<line x1=\"" + f(x) + "\" y1=\"" + (M.top + IH) + "\" x2=\"" + f(x) + "\" y2=\"" + (M.top + IH + 4) + "\" stroke=\"" + AXIS + "\"/><text x=\"" + f(x) + "\" y=\"" + (M.top + IH + 16) + "\" text-anchor=\"middle\" font-size=\"10\" fill=\"" + TICK + "\">" + (minute / 60) + "</text>";
  }).join("") + yAxis(niceTicks(0, ymax), 0, ymax);
  if (series.simStartMin !== null && series.simEndMin !== null) body += `<rect x="${f(px(series.simStartMin))}" y="${M.top}" width="${f(Math.max(1, px(series.simEndMin) - px(series.simStartMin)))}" height="${IH}" fill="${esc(o.simColor ?? ACCENT)}" fill-opacity="0.12"><title>${esc(o.simulatedLabel ?? "Simulated window")}: ${formatTick(series.simStartMin / 60)}-${formatTick(series.simEndMin / 60)} h</title></rect>`;
  if (series.observed.length) {
    const points = series.observed.map((p) => `${f(px(p.minute))},${f(py(p.value))}`).join(" ");
    body += `<polyline points="${points}" fill="none" stroke="${esc(o.color ?? SERIES)}" stroke-width="1.7"><title>${esc(o.observedLabel ?? "Observed flow")}</title></polyline>`;
    for (const p of series.observed) body += `<circle cx="${f(px(p.minute))}" cy="${f(py(p.value))}" r="1.5" fill="${esc(o.color ?? SERIES)}"><title>${esc(`${String(Math.floor(p.minute / 60)).padStart(2, "0")}:${String(p.minute % 60).padStart(2, "0")} - ${formatTick(p.value)} veh/h`)}</title></circle>`;
  }
  let previous: SimulatedSegment | null = null;
  for (const segment of series.simulated) {
    const step = previous && Math.abs(previous.endMin - segment.startMin) < 1e-9
      ? `M${f(px(segment.startMin))},${f(py(previous.value))} V${f(py(segment.value))} H${f(px(segment.endMin))}`
      : `M${f(px(segment.startMin))},${f(py(segment.value))} H${f(px(segment.endMin))}`;
    body += `<path d="${step}" fill="none" stroke="${esc(o.simColor ?? ACCENT)}" stroke-width="3"><title>${esc(o.simulatedLabel ?? "Simulated flow")}: ${formatTick(segment.startMin / 60)}-${formatTick(segment.endMin / 60)} h, ${formatTick(segment.value)} veh/h</title></path>`;
    previous = segment;
  }
  return frame(o.label ?? "Day profile", body, o.xTitle ?? "Hour of day", o.yTitle ?? "Flow (veh/h)");
}

export interface ShareDatum { label: string; value: number; color: string }
/** Stacked horizontal share bar with a percent target marker. */
export function stackedBarSvg(data: readonly ShareDatum[], target = 85, label = "Compliance shares"): string {
  const y = 34, x = M.left, w = IW;
  let offset = 0, body = "";
  for (const d of data) {
    const width = Math.max(0, Math.min(100 - offset, d.value)) / 100 * w;
    body += `<rect x="${f(x + offset / 100 * w)}" y="${y}" width="${f(width)}" height="24" fill="${esc(d.color)}"><title>${esc(`${d.label}: ${formatTick(d.value)}%`)}</title></rect>`;
    offset += d.value;
  }
  const tx = x + Math.max(0, Math.min(100, target)) / 100 * w;
  body += `<line x1="${f(tx)}" y1="${y - 8}" x2="${f(tx)}" y2="${y + 32}" stroke="${ACCENT}" stroke-width="2"><title>${esc(`${formatTick(target)}% target`)}</title></line>`;
  body += `<text x="${x}" y="${y + 45}" font-size="10" fill="${TICK}">0%</text><text x="${x + w}" y="${y + 45}" text-anchor="end" font-size="10" fill="${TICK}">100%</text>`;
  return frame(label, body, "Share (%)");
}

export interface GroupedBarDatum { label: string; value: number; n?: number; color: string }
/** Compact vertical bars by category. */
export function groupedBarSvg(data: readonly GroupedBarDatum[], o: BarOptions = {}): string {
  return barSvg(data.map((d) => ({ label: d.n === undefined ? d.label : `${d.label} (n=${d.n})`, value: d.value, color: d.color })), o);
}
