/**
 * Hand-written SVG line chart (time-of-day profiles): optional min-max band, several lines,
 * a vertical marker. Same geometry and theme variables as _shared/src/charts.ts so it looks like the
 * other plots; returns an SVG string (escape-safe) for mountChart().
 * Gaps: a line/band is broken where a value is null or the x step exceeds `gapFactor` x the smallest step.
 */
import { CHART_H, CHART_W, esc, formatTick, niceTicks } from "../../_shared/src/charts";

const M = { top: 22, right: 16, bottom: 40, left: 52 };
const IW = CHART_W - M.left - M.right;
const IH = CHART_H - M.top - M.bottom;
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
const PRIMARY = "hsl(var(--primary))";
const ACCENT = "hsl(var(--destructive, 0 70% 50%))";

export interface LinePoint {
  x: number;
  y: number | null;
}
export interface LineSeries {
  label: string;
  points: LinePoint[];
  color?: string;
  dash?: string;
  width?: number;
  /** Draw a post-step curve (one flat duration per interval). */
  step?: boolean;
}
export interface BandPoint {
  x: number;
  lo: number | null;
  hi: number | null;
}
export interface LineOptions {
  series: readonly LineSeries[];
  band?: { label: string; points: readonly BandPoint[] } | null;
  /** x position of a vertical marker (e.g. the selected time bucket). */
  vline?: number | null;
  xTitle?: string;
  yTitle?: string;
  label?: string;
  xMin?: number;
  xMax?: number;
  xTicks?: readonly number[];
  xFormat?: (x: number) => string;
  gapFactor?: number;
  simWindow?: { start: number; end: number } | null;
}

export const minutesToHHMM = (m: number): string => {
  const mm = Math.round(m);
  return `${String(Math.floor(mm / 60) % 24).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
};

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Split into runs of consecutive valid points. */
function runs<T extends { x: number }>(pts: readonly T[], valid: (p: T) => boolean, gap: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let lastX = -Infinity;
  for (const p of pts) {
    if (!valid(p)) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    if (cur.length && p.x - lastX > gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
    lastX = p.x;
  }
  if (cur.length) out.push(cur);
  return out;
}

function emptySvg(label: string, msg: string): string {
  return (
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" role="img" aria-label="${esc(label)}" style="height:auto;inline-size:100%">` +
    `<text x="${CHART_W / 2}" y="${CHART_H / 2}" text-anchor="middle" font-size="12" fill="${TICK}">${esc(msg)}</text></svg>`
  );
}

export function lineSvg(o: LineOptions): string {
  const label = o.label ?? "line chart";
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of o.series) for (const p of s.points) if (p.y !== null && Number.isFinite(p.y) && Number.isFinite(p.x)) (xs.push(p.x), ys.push(p.y));
  for (const p of o.band?.points ?? []) {
    if (p.hi !== null && Number.isFinite(p.hi)) (xs.push(p.x), ys.push(p.hi));
    if (p.lo !== null && Number.isFinite(p.lo)) ys.push(p.lo);
  }
  if (!xs.length) return emptySvg(label, "No data");

  const steps: number[] = [];
  const allX = [...new Set(xs)].sort((a, b) => a - b);
  for (let i = 1; i < allX.length; i++) steps.push(allX[i] - allX[i - 1]);
  const gap = (o.gapFactor ?? 1.5) * (steps.length ? Math.min(...steps) : 1);

  const xlo = o.xMin ?? Math.min(...xs);
  let xhi = o.xMax ?? Math.max(...xs);
  if (xhi === xlo) xhi = xlo + 1;
  const ymax0 = Math.max(...ys, 0);
  const yt = niceTicks(0, ymax0 || 1);
  const ylo = 0;
  const yhi = Math.max(ymax0, yt[yt.length - 1]) || 1;
  const px = (x: number) => M.left + ((x - xlo) / (xhi - xlo)) * IW;
  const py = (y: number) => M.top + IH - ((y - ylo) / (yhi - ylo)) * IH;
  const fmt = o.xFormat ?? minutesToHHMM;
  const xticks = o.xTicks ?? (xhi - xlo >= 360 ? Array.from({ length: Math.floor((xhi - xlo) / 180) + 1 }, (_, i) => xlo + i * 180) : niceTicks(xlo, xhi));

  let body =
    `<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + IH}" stroke="${AXIS}"/>` +
    `<line x1="${M.left}" y1="${M.top + IH}" x2="${M.left + IW}" y2="${M.top + IH}" stroke="${AXIS}"/>`;
  body += yt
    .map(
      (t) =>
        `<line x1="${M.left - 4}" y1="${f(py(t))}" x2="${M.left}" y2="${f(py(t))}" stroke="${AXIS}"/>` +
        `<line x1="${M.left}" y1="${f(py(t))}" x2="${M.left + IW}" y2="${f(py(t))}" stroke="${AXIS}" stroke-opacity="0.25"/>` +
        `<text x="${M.left - 7}" y="${f(py(t))}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="${TICK}">${esc(formatTick(t))}</text>`,
    )
    .join("");
  body += xticks
    .filter((t) => t >= xlo - 1e-9 && t <= xhi + 1e-9)
    .map(
      (t) =>
        `<line x1="${f(px(t))}" y1="${M.top + IH}" x2="${f(px(t))}" y2="${M.top + IH + 4}" stroke="${AXIS}"/>` +
        `<text x="${f(px(t))}" y="${M.top + IH + 16}" text-anchor="middle" font-size="10" fill="${TICK}">${esc(fmt(t))}</text>`,
    )
    .join("");

  if (o.simWindow && Number.isFinite(o.simWindow.start) && Number.isFinite(o.simWindow.end) && o.simWindow.end > o.simWindow.start) {
    const lo = Math.max(xlo, o.simWindow.start), hi = Math.min(xhi, o.simWindow.end);
    if (hi > lo) body += `<rect data-sim-window="1" x="${f(px(lo))}" y="${M.top}" width="${f(px(hi) - px(lo))}" height="${IH}" fill="${ACCENT}" fill-opacity="0.08"><title>Simulated window ${esc(fmt(lo))}-${esc(fmt(hi))} min</title></rect>`;
  }

  // Band: one polygon per run.
  if (o.band) {
    for (const run of runs(o.band.points, (p) => p.lo !== null && p.hi !== null, gap)) {
      if (run.length < 2) {
        const p = run[0];
        body += `<line x1="${f(px(p.x))}" y1="${f(py(p.hi as number))}" x2="${f(px(p.x))}" y2="${f(py(p.lo as number))}" stroke="${PRIMARY}" stroke-opacity="0.3" stroke-width="3"><title>${esc(o.band.label)}</title></line>`;
        continue;
      }
      const top = run.map((p) => `${f(px(p.x))},${f(py(p.hi as number))}`);
      const bot = run.map((p) => `${f(px(p.x))},${f(py(p.lo as number))}`).reverse();
      body += `<polygon points="${[...top, ...bot].join(" ")}" fill="${PRIMARY}" fill-opacity="0.15" stroke="none"><title>${esc(o.band.label)}</title></polygon>`;
    }
  }
  if (o.vline !== null && o.vline !== undefined && o.vline >= xlo && o.vline <= xhi) {
    body += `<line data-marker="1" x1="${f(px(o.vline))}" y1="${M.top}" x2="${f(px(o.vline))}" y2="${M.top + IH}" stroke="${ACCENT}" stroke-dasharray="3 3"/>`;
  }
  const palette = [PRIMARY, ACCENT, TICK];
  o.series.forEach((s, i) => {
    const color = s.color ?? palette[i % palette.length];
    for (const run of runs(s.points, (p) => p.y !== null && Number.isFinite(p.y), gap)) {
      const d = run.map((p, k) => {
        const x = f(px(p.x)), y = f(py(p.y as number));
        if (!k) return `M${x} ${y}`;
        return s.step ? `H${x}V${y}` : `L${x} ${y}`;
      }).join("");
      body += `<path data-series="${esc(s.label)}" d="${d}" fill="none" stroke="${color}" stroke-width="${s.width ?? 1.75}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
      for (const p of run) body += `<circle cx="${f(px(p.x))}" cy="${f(py(p.y as number))}" r="2" fill="${color}"><title>${esc(`${minutesToHHMM(p.x)}: ${fmt(p.y as number)} s — ${s.label}`)}</title></circle>`;
    }
  });
  // Legend (start-aligned along the top margin).
  const items: Array<{ label: string; color: string; dash?: string; swatch?: boolean }> = [
    ...(o.band ? [{ label: o.band.label, color: PRIMARY, swatch: true }] : []),
    ...o.series.map((s, i) => ({ label: s.label, color: s.color ?? palette[i % palette.length], dash: s.dash })),
  ];
  let lx = M.left;
  for (const it of items) {
    body += it.swatch
      ? `<rect x="${lx}" y="6" width="12" height="8" fill="${it.color}" fill-opacity="0.25"/>`
      : `<line x1="${lx}" y1="10" x2="${lx + 14}" y2="10" stroke="${it.color}" stroke-width="2"${it.dash ? ` stroke-dasharray="${it.dash}"` : ""}/>`;
    body += `<text x="${lx + 18}" y="13" font-size="10" fill="${TICK}">${esc(it.label)}</text>`;
    lx += 26 + it.label.length * 5.6;
  }
  body += o.xTitle ? `<text x="${M.left + IW / 2}" y="${CHART_H - 4}" text-anchor="middle" font-size="11" fill="${TICK}">${esc(o.xTitle)}</text>` : "";
  body += o.yTitle ? `<text transform="translate(12 ${M.top + IH / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${TICK}">${esc(o.yTitle)}</text>` : "";
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" role="img" aria-label="${esc(label)}" style="height:auto;inline-size:100%" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}
