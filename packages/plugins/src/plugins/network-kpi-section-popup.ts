import type { SimulationTimeline } from "../shared/simulation-timeline";
import type { NetworkKpiMetric } from "./network-kpi-ramps";
import type { KpiRow, NetworkKpiSectionSample } from "./network-kpi-data";

const METRICS: { key: Exclude<NetworkKpiMetric, "delay">; label: string; color: string; unit: string }[] = [
  { key: "flow", label: "Flow", color: "#38bdf8", unit: "veh/h" },
  { key: "density", label: "Density", color: "#f59e0b", unit: "veh/km" },
  { key: "speed", label: "Speed", color: "#34d399", unit: "km/h" },
];

const numberText = (value: number | null): string => value == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);

function intervalLabel(interval: number, timeline: SimulationTimeline | null): string {
  if (interval <= 0) return "Whole period";
  if (timeline?.initialTimeSeconds == null || timeline.intervalDurationSeconds == null) return `I${interval}`;
  const seconds = timeline.initialTimeSeconds + (interval - 1) * timeline.intervalDurationSeconds;
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}`;
}

function svgElement<T extends keyof SVGElementTagNameMap>(tag: T, attrs: Record<string, string> = {}): SVGElementTagNameMap[T] {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function chartFrame(title: string, subtitle: string): { root: HTMLElement; plot: SVGSVGElement } {
  const root = document.createElement("section");
  root.className = "network-kpi-section-chart";
  const heading = document.createElement("div");
  heading.className = "network-kpi-section-chart-heading";
  const name = document.createElement("strong");
  name.textContent = title;
  const units = document.createElement("span");
  units.textContent = subtitle;
  heading.append(name, units);
  root.appendChild(heading);
  const plot = svgElement("svg", { viewBox: "0 0 360 82", role: "img", "aria-label": title });
  plot.classList.add("network-kpi-section-plot");
  root.appendChild(plot);
  return { root, plot };
}

function appendLineChart(
  parent: HTMLElement,
  series: NetworkKpiSectionSample[],
  metric: (typeof METRICS)[number],
  timeline: SimulationTimeline | null,
  selectedInterval: number,
): void {
  const { root, plot } = chartFrame(`${metric.label} over time`, metric.unit);
  const values = series.map((sample) => sample[metric.key]);
  const usable = values.filter((value): value is number => value != null);
  if (!usable.length) {
    const empty = document.createElement("div");
    empty.className = "network-kpi-section-empty";
    empty.textContent = "No interval data";
    root.appendChild(empty);
    parent.appendChild(root);
    return;
  }
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const spread = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const point = (index: number, value: number) => ({
    x: series.length < 2 ? 180 : 12 + index * 336 / (series.length - 1),
    y: 66 - (value - min) * 48 / spread,
  });
  plot.appendChild(svgElement("line", { x1: "10", y1: "66", x2: "350", y2: "66", class: "network-kpi-chart-axis" }));
  // Path data is assembled from trusted finite numeric coordinates only.
  const d = series.flatMap((sample, index) => {
    const value = sample[metric.key];
    if (value == null) return [];
    const p = point(index, value);
    return [`${index === 0 || series[index - 1]?.[metric.key] == null ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`];
  }).join(" ");
  if (d) plot.appendChild(svgElement("path", { d, fill: "none", stroke: metric.color, "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  series.forEach((sample, index) => {
    const value = sample[metric.key];
    if (value == null) return;
    const p = point(index, value);
    const circle = svgElement("circle", { cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: sample.interval === selectedInterval ? "4.5" : series.length > 50 ? "1.6" : "2.4", fill: metric.color, class: sample.interval === selectedInterval ? "network-kpi-chart-current" : "" });
    const title = svgElement("title");
    title.textContent = `${intervalLabel(sample.interval, timeline)} · ${metric.label}: ${numberText(value)} ${metric.unit}`;
    circle.appendChild(title);
    plot.appendChild(circle);
  });
  const low = document.createElement("span"); low.textContent = numberText(min);
  const high = document.createElement("span"); high.textContent = numberText(max);
  const range = document.createElement("div"); range.className = "network-kpi-chart-range"; range.append(low, high);
  root.appendChild(range);
  const timeRange = document.createElement("div"); timeRange.className = "network-kpi-chart-time-range";
  const firstTime = document.createElement("span"); firstTime.textContent = intervalLabel(series[0]!.interval, timeline);
  const lastTime = document.createElement("span"); lastTime.textContent = intervalLabel(series.at(-1)!.interval, timeline);
  timeRange.append(firstTime, lastTime);
  root.appendChild(timeRange);
  parent.appendChild(root);
}

function appendScatterChart(
  parent: HTMLElement,
  series: NetworkKpiSectionSample[],
  xMetric: (typeof METRICS)[number],
  yMetric: (typeof METRICS)[number],
): void {
  const { root, plot } = chartFrame(`${yMetric.label} vs ${xMetric.label}`, `${xMetric.unit} · ${yMetric.unit}`);
  const pairs = series.flatMap((sample) => {
    const x = sample[xMetric.key]; const y = sample[yMetric.key];
    return x == null || y == null ? [] : [{ sample, x, y }];
  });
  if (!pairs.length) {
    const empty = document.createElement("div");
    empty.className = "network-kpi-section-empty";
    empty.textContent = "No paired interval data";
    root.appendChild(empty);
    parent.appendChild(root);
    return;
  }
  const xMin = Math.min(...pairs.map((pair) => pair.x)); const xMax = Math.max(...pairs.map((pair) => pair.x));
  const yMin = Math.min(...pairs.map((pair) => pair.y)); const yMax = Math.max(...pairs.map((pair) => pair.y));
  const xSpread = xMax - xMin || Math.max(Math.abs(xMax) * 0.1, 1);
  const ySpread = yMax - yMin || Math.max(Math.abs(yMax) * 0.1, 1);
  plot.appendChild(svgElement("line", { x1: "12", y1: "66", x2: "350", y2: "66", class: "network-kpi-chart-axis" }));
  plot.appendChild(svgElement("line", { x1: "12", y1: "12", x2: "12", y2: "66", class: "network-kpi-chart-axis" }));
  for (const { sample, x, y } of pairs) {
    const cx = 14 + (x - xMin) * 332 / xSpread;
    const cy = 64 - (y - yMin) * 48 / ySpread;
    const circle = svgElement("circle", { cx: cx.toFixed(2), cy: cy.toFixed(2), r: "3", fill: yMetric.color, opacity: "0.78" });
    const title = svgElement("title");
    title.textContent = `I${sample.interval} · ${xMetric.label}: ${numberText(x)} · ${yMetric.label}: ${numberText(y)}`;
    circle.appendChild(title);
    plot.appendChild(circle);
  }
  const range = document.createElement("div"); range.className = "network-kpi-chart-range";
  const low = document.createElement("span"); low.textContent = numberText(xMin);
  const high = document.createElement("span"); high.textContent = numberText(xMax);
  range.append(low, high); root.appendChild(range); parent.appendChild(root);
}

/** Build the section-selection popup with KPI time series and paired diagrams. */
export function createNetworkKpiSectionPopup(args: {
  sectionId: number;
  sectionName?: string;
  series: NetworkKpiSectionSample[];
  currentStats?: KpiRow | null;
  timeline: SimulationTimeline | null;
  selectedInterval: number;
}): HTMLElement {
  const { sectionId, series, timeline, selectedInterval } = args;
  const root = document.createElement("div");
  root.className = "geolibre-network-kpi-section-popup";
  const heading = document.createElement("div"); heading.className = "network-kpi-section-title";
  const title = document.createElement("strong"); title.textContent = args.sectionName || `Section ${sectionId}`;
  const context = document.createElement("span"); context.textContent = `ID ${sectionId} · ${intervalLabel(selectedInterval, timeline)} · ${series.length} ${series.length === 1 ? "interval" : "intervals"}`;
  heading.append(title, context); root.appendChild(heading);

  const current = args.currentStats ?? series.find((sample) => sample.interval === selectedInterval) ?? series.at(-1);
  const summary = document.createElement("div"); summary.className = "network-kpi-section-summary";
  for (const metric of METRICS) {
    const card = document.createElement("div"); card.className = "network-kpi-section-metric";
    const label = document.createElement("span"); label.textContent = metric.label;
    const value = document.createElement("strong"); value.textContent = numberText(current?.[metric.key] ?? null);
    const unit = document.createElement("small"); unit.textContent = metric.unit;
    card.append(label, value, unit); summary.appendChild(card);
  }
  root.appendChild(summary);
  if (!series.length) {
    const empty = document.createElement("p"); empty.className = "network-kpi-section-empty";
    empty.textContent = "No time-series values are available for this section and replication.";
    root.appendChild(empty);
    return root;
  }
  const grid = document.createElement("div"); grid.className = "network-kpi-section-timeseries";
  for (const metric of METRICS) appendLineChart(grid, series, metric, timeline, selectedInterval);
  root.appendChild(grid);
  const scatter = document.createElement("div"); scatter.className = "network-kpi-section-scatter";
  appendScatterChart(scatter, series, METRICS[0]!, METRICS[1]!);
  appendScatterChart(scatter, series, METRICS[0]!, METRICS[2]!);
  root.appendChild(scatter);
  return root;
}
