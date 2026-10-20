import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Box, Eye, FolderOpen, PanelBottomClose, PanelBottomOpen, Pause, Play, SkipBack, SkipForward, Square, X } from "lucide-react";
import {
  canLoadLocalScenarioComparisonPackage,
  closeScenarioComparisonPanel,
  comparisonCategoricalRamp,
  comparisonDifferenceLegend,
  sideBySideLegend,
  comparisonThresholdOptions,
  isComparisonDifferenceMetric,
  getScenarioComparisonSnapshot,
  getScenarioComparisonDashboardSnapshot,
  getScenarioComparisonStatus,
  isScenarioComparisonPanelVisible,
  loadLocalScenarioComparisonFolder,
  setScenarioComparisonManifestUrl,
  setScenarioComparisonSettings,
  setScenarioComparisonDashboardScope,
  swapScenarioComparisonSides,
  stepScenarioComparisonInterval,
  subscribeScenarioComparison,
  subscribeScenarioComparisonDashboard,
  subscribeScenarioComparisonStatus,
  toggleScenarioComparisonIntervalPlaying,
  useIntervalPlayback,
  useManifestUrlDraft,
  useScenarioReplicationSelector,
  useViewModeToggle,
  type ScenarioComparisonDashboardSample,
} from "@geolibre/plugins";
import { PlaybackTimelineReadout } from "./PlaybackTimelineReadout";

const COMPARISON_DASHBOARD_METRICS = [
  { key: "flow", label: "Flow", unit: "veh/h", laneUnit: "veh/h/lane", max: 2200, color: "#38bdf8" },
  { key: "density", label: "Density", unit: "veh/km", max: 160, color: "#f59e0b" },
  { key: "speed", label: "Speed", unit: "km/h", max: 120, color: "#34d399" },
] as const;

function comparisonDashboardNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function comparisonTimeLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Testudo's lateral Comparison dashboard body, separate from the floating plugin controls. */
export function ScenarioComparisonDashboardPanel() {
  const dashboard = useSyncExternalStore(subscribeScenarioComparisonDashboard, getScenarioComparisonDashboardSnapshot, getScenarioComparisonDashboardSnapshot);
  const samples = dashboard.samples;
  const current = samples.find(sample => Math.abs(sample.timeSeconds - (dashboard.currentTimeSeconds ?? Number.NaN)) < 1e-6) ?? samples.at(-1) ?? null;
  const selected = dashboard.scope === "selected";
  const fixedSelectedScale = selected;

  return (
    <section className="space-y-3" aria-label="Comparison dashboard">
      <div className="space-y-1">
        <label htmlFor="scenario-comparison-dashboard-scope" className="block text-xs font-medium">Scope</label>
        <select
          id="scenario-comparison-dashboard-scope"
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={dashboard.scope}
          onChange={event => setScenarioComparisonDashboardScope(event.currentTarget.value as "selected" | "viewport" | "network")}
        >
          <option value="selected">Selected section or lane</option>
          <option value="viewport">All sections in viewport</option>
          <option value="network">Whole network</option>
        </select>
      </div>

      {selected && dashboard.selectedEntity && (
        <p className="text-xs text-muted-foreground">{dashboard.selectedEntity.name} · Section {dashboard.selectedEntity.sectionId}</p>
      )}
      {dashboard.loading && <p role="status" className="text-sm text-muted-foreground">Loading comparison statistics…</p>}
      {dashboard.error && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{dashboard.error}</p>}
      {!dashboard.loading && !dashboard.error && selected && !dashboard.selectedEntity && (
        <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">Click a section, lane, or turn to compare its statistics.</p>
      )}
      {!dashboard.loading && !dashboard.error && !selected && !samples.length && (
        <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">No matched simulation samples are available for this scope.</p>
      )}

      {!dashboard.loading && !dashboard.error && current && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {COMPARISON_DASHBOARD_METRICS.map(metric => {
              const a = current.scenarioA[metric.key];
              const b = current.scenarioB[metric.key];
              const delta = current.delta[metric.key];
              return (
                <div key={metric.key} className="min-w-0 rounded-md border border-border p-2">
                  <span className="block truncate text-xs text-muted-foreground">{metric.label}</span>
                  <strong className="block truncate text-xs tabular-nums">A {comparisonDashboardNumber(a)}</strong>
                  <strong className="block truncate text-xs tabular-nums">B {comparisonDashboardNumber(b)}</strong>
                  <span className="block truncate text-[10px] tabular-nums text-muted-foreground">Δ {comparisonDashboardNumber(delta)} {metric.key === "flow" && fixedSelectedScale ? metric.laneUnit : metric.unit}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {dashboard.scenarioA.label} ({dashboard.scenarioA.replicationLabel ?? "no replication"}) · {dashboard.scenarioB.label} ({dashboard.scenarioB.replicationLabel ?? "no replication"})
          </p>
          <div className="grid grid-cols-1 gap-2">
            {COMPARISON_DASHBOARD_METRICS.map(metric => (
              <ComparisonDashboardLineChart key={metric.key} metric={metric} samples={samples} nameA={dashboard.scenarioA.label} nameB={dashboard.scenarioB.label} fixedDomain={fixedSelectedScale ? [0, metric.max] : undefined} />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <ComparisonDashboardScatterChart kind="density" samples={samples} nameA={dashboard.scenarioA.label} nameB={dashboard.scenarioB.label} fixedFlowDomain={fixedSelectedScale ? [0, 2200] : undefined} fixedMetricDomain={fixedSelectedScale ? [0, 160] : undefined} />
            <ComparisonDashboardScatterChart kind="speed" samples={samples} nameA={dashboard.scenarioA.label} nameB={dashboard.scenarioB.label} fixedFlowDomain={fixedSelectedScale ? [0, 2200] : undefined} fixedMetricDomain={fixedSelectedScale ? [0, 120] : undefined} />
          </div>
          <details className="rounded-md border border-border p-2">
            <summary className="cursor-pointer text-xs font-medium">Matched sample values</summary>
            <div className="mt-2 max-h-56 overflow-auto">
              <table className="w-full text-start text-xs tabular-nums">
                <thead><tr><th>Time</th><th>Side</th><th>Flow</th><th>Density</th><th>Speed</th></tr></thead>
                <tbody>{samples.flatMap(sample => ([
                  <tr key={`${sample.timeSeconds}-a`}><th rowSpan={2}>{comparisonTimeLabel(sample.timeSeconds)}</th><th>{dashboard.scenarioA.label}</th><td>{comparisonDashboardNumber(sample.scenarioA.flow)}</td><td>{comparisonDashboardNumber(sample.scenarioA.density)}</td><td>{comparisonDashboardNumber(sample.scenarioA.speed)}</td></tr>,
                  <tr key={`${sample.timeSeconds}-b`}><th>{dashboard.scenarioB.label}</th><td>{comparisonDashboardNumber(sample.scenarioB.flow)}</td><td>{comparisonDashboardNumber(sample.scenarioB.density)}</td><td>{comparisonDashboardNumber(sample.scenarioB.speed)}</td></tr>,
                ]))}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function ComparisonDashboardLineChart({ metric, samples, nameA, nameB, fixedDomain }: { metric: (typeof COMPARISON_DASHBOARD_METRICS)[number]; samples: ScenarioComparisonDashboardSample[]; nameA: string; nameB: string; fixedDomain?: [number, number] }) {
  const values = samples.flatMap(sample => [sample.scenarioA[metric.key], sample.scenarioB[metric.key]]).filter((value): value is number => value !== null && Number.isFinite(value));
  const min = fixedDomain?.[0] ?? (values.length ? Math.min(...values) : 0);
  const max = fixedDomain?.[1] ?? (values.length ? Math.max(...values) : 0);
  const spread = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const line = (side: "scenarioA" | "scenarioB") => samples.map((sample, index) => {
    const value = sample[side][metric.key];
    if (value === null || !Number.isFinite(value)) return null;
    const x = samples.length < 2 ? 55 : 14 + index * 83 / (samples.length - 1);
    const y = 40 - Math.max(0, Math.min(1, (value - min) / spread)) * 34;
    return { sample, value, x, y };
  });
  const path = (points: ReturnType<typeof line>) => points.map((point, index) => point ? `${index === 0 || points[index - 1] == null ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}` : "").filter(Boolean).join(" ");
  const unit = metric.key === "flow" && fixedDomain ? metric.laneUnit : metric.unit;
  const title = `${metric.label} over time`;
  return (
    <section className="rounded-md border border-border p-2">
      <div className="flex items-center justify-between text-xs"><strong>{title}</strong><span className="text-muted-foreground">{unit}</span></div>
      {values.length ? <svg viewBox="0 0 100 54" role="img" aria-label={`${title}, common scale ${comparisonDashboardNumber(min)} to ${comparisonDashboardNumber(max)} ${unit}`} className="network-kpi-dashboard-chart">
        {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="14" y1={6 + fraction * 34} x2="97" y2={6 + fraction * 34} className="network-kpi-chart-axis" /><text x="12" y={8 + fraction * 34} textAnchor="end" className="network-kpi-chart-label">{comparisonDashboardNumber(max - fraction * spread)}</text></g>)}
        <path d={path(line("scenarioA"))} fill="none" stroke="#2563eb" strokeWidth="1.5" />
        <path d={path(line("scenarioB"))} fill="none" stroke="#f97316" strokeWidth="1.5" strokeDasharray="2 1" />
        <text x="14" y="52" className="network-kpi-chart-label">{comparisonTimeLabel(samples[0]!.timeSeconds)}</text><text x="97" y="52" textAnchor="end" className="network-kpi-chart-label">{comparisonTimeLabel(samples.at(-1)!.timeSeconds)}</text>
      </svg> : <p className="py-3 text-xs text-muted-foreground">No values are available.</p>}
      <div className="flex gap-3 text-[10px]"><span className="text-blue-600">● {`A · ${nameA}`}</span><span className="text-orange-600">● {`B · ${nameB}`}</span></div>
    </section>
  );
}

function ComparisonDashboardScatterChart({ kind, samples, nameA, nameB, fixedFlowDomain, fixedMetricDomain }: { kind: "density" | "speed"; samples: ScenarioComparisonDashboardSample[]; nameA: string; nameB: string; fixedFlowDomain?: [number, number]; fixedMetricDomain?: [number, number] }) {
  const points = samples.flatMap(sample => ([
    { interval: sample.intervalA, timeSeconds: sample.timeSeconds, side: "A" as const, flow: sample.scenarioA.flow, metric: sample.scenarioA[kind] },
    { interval: sample.intervalB, timeSeconds: sample.timeSeconds, side: "B" as const, flow: sample.scenarioB.flow, metric: sample.scenarioB[kind] },
  ])).filter(point => point.flow !== null && point.metric !== null && Number.isFinite(point.flow) && Number.isFinite(point.metric));
  const xMin = fixedFlowDomain?.[0] ?? (points.length ? Math.min(...points.map(point => point.flow!)) : 0);
  const xMax = fixedFlowDomain?.[1] ?? (points.length ? Math.max(...points.map(point => point.flow!)) : 0);
  const yMin = fixedMetricDomain?.[0] ?? (points.length ? Math.min(...points.map(point => point.metric!)) : 0);
  const yMax = fixedMetricDomain?.[1] ?? (points.length ? Math.max(...points.map(point => point.metric!)) : 0);
  const xSpread = xMax - xMin || Math.max(Math.abs(xMax) * 0.1, 1);const ySpread = yMax - yMin || Math.max(Math.abs(yMax) * 0.1, 1);
  const unit = kind === "density" ? "veh/km" : "km/h";
  return (
    <section className="min-w-0 rounded-md border border-border p-2">
      <div className="flex items-center justify-between text-xs"><strong>Flow vs {kind}</strong><span className="text-muted-foreground">{fixedFlowDomain ? "veh/h/lane" : "veh/h"} · {unit}</span></div>
      {points.length ? <svg viewBox="0 0 100 54" role="img" aria-label={`Flow vs ${kind}; flow scale ${comparisonDashboardNumber(xMin)} to ${comparisonDashboardNumber(xMax)}, ${kind} scale ${comparisonDashboardNumber(yMin)} to ${comparisonDashboardNumber(yMax)}`} className="network-kpi-dashboard-chart">
        <line x1="4" y1="40" x2="97" y2="40" className="network-kpi-chart-axis" /><line x1="4" y1="4" x2="4" y2="40" className="network-kpi-chart-axis" />
        {points.map(point => <circle key={`${point.timeSeconds}-${point.side}`} cx={4 + Math.max(0, Math.min(1, (point.flow! - xMin) / xSpread)) * 92} cy={39 - Math.max(0, Math.min(1, (point.metric! - yMin) / ySpread)) * 34} r="1.7" fill={point.side === "A" ? "#2563eb" : "#f97316"}><title>{`${comparisonTimeLabel(point.timeSeconds)} · ${point.side} · ${comparisonDashboardNumber(point.flow)} ${fixedFlowDomain ? "veh/h/lane" : "veh/h"} · ${comparisonDashboardNumber(point.metric)} ${unit}`}</title></circle>)}
        <text x="4" y="47" className="network-kpi-chart-label">{comparisonDashboardNumber(xMin)}</text><text x="97" y="47" textAnchor="end" className="network-kpi-chart-label">{comparisonDashboardNumber(xMax)}</text>
        <text x="4" y="53" className="network-kpi-chart-label">Flow</text><text x="97" y="53" textAnchor="end" className="network-kpi-chart-label">{kind}: {comparisonDashboardNumber(yMin)}–{comparisonDashboardNumber(yMax)}</text>
      </svg> : <p className="py-3 text-xs text-muted-foreground">No paired values are available.</p>}
      <div className="flex gap-3 text-[10px]"><span className="text-blue-600">● {`A · ${nameA}`}</span><span className="text-orange-600">● {`B · ${nameB}`}</span></div>
    </section>
  );
}

export function ScenarioComparisonPanel() {
  const { t } = useTranslation();
  const open = useSyncExternalStore(subscribeScenarioComparison, isScenarioComparisonPanelVisible, isScenarioComparisonPanelVisible);
  const s = useSyncExternalStore(subscribeScenarioComparison, getScenarioComparisonSnapshot, getScenarioComparisonSnapshot);
  const status = useSyncExternalStore(subscribeScenarioComparisonStatus, getScenarioComparisonStatus, getScenarioComparisonStatus);
  const [collapsed, setCollapsed] = useState(false);

  const hasPackage = (s.manifestUrl != null && s.manifestUrl.length > 0) || status.scenarios.length > 0;

  const { urlDraft, setUrlDraft, loadPackage, handleKeyDown } = useManifestUrlDraft(
    s.manifestUrl,
    setScenarioComparisonManifestUrl,
  );

  // Stateless hook, called once per side — side A and side B never share or
  // collide over hidden state, so two independent calls in the same component
  // are safe.
  const sideA = useScenarioReplicationSelector({
    scenarios: status.scenarios,
    scenarioIndex: s.scenarioA,
    replications: status.replicationsA,
    selectedDid: s.didA,
    onScenarioChange: (index) => {
      setScenarioComparisonSettings({ scenarioA: index, didA: null });
    },
    onReplicationChange: (did) => setScenarioComparisonSettings({ didA: did }),
  });
  const sideB = useScenarioReplicationSelector({
    scenarios: status.scenarios,
    scenarioIndex: s.scenarioB,
    replications: status.replicationsB,
    selectedDid: s.didB,
    onScenarioChange: (index) => {
      setScenarioComparisonSettings({ scenarioB: index, didB: null });
    },
    onReplicationChange: (did) => setScenarioComparisonSettings({ didB: did }),
  });

  const intervalPlayback = useIntervalPlayback({
    intervals: status.intervals,
    interval: s.interval,
    onIntervalChange: (interval) => setScenarioComparisonSettings({ interval }),
    onStep: (direction) => stepScenarioComparisonInterval(direction),
    onTogglePlaying: toggleScenarioComparisonIntervalPlaying,
  });

  const viewMode = useViewModeToggle({
    extruded: s.extruded,
    maxHeightM: s.maxHeightM,
    heightMin: 1,
    heightMax: 200,
    onExtrudedChange: (extruded) => setScenarioComparisonSettings({ extruded }),
    onMaxHeightChange: (maxHeightM) => setScenarioComparisonSettings({ maxHeightM }),
  });

  const ramp = comparisonCategoricalRamp(s.metric);
  const continuous = isComparisonDifferenceMetric(s.metric) ? comparisonDifferenceLegend(s.metric, s.flowDifferenceScale) : undefined;

  if (!open) return null;

  const sideSelectors = (["A", "B"] as const).map((side) => {
    const sel = side === "A" ? sideA : sideB;
    return (
      <div key={side} className="space-y-2">
        <label className="block text-xs">
          {side === "A" ? "Reference" : "Compared"}
          <select
            className="h-8 w-full rounded border bg-transparent text-foreground"
            value={sel.scenarioIndex}
            onChange={(e) => sel.onScenarioChange(Number(e.currentTarget.value))}
          >
            {sel.scenarios.map((x) => (
              <option className="bg-background text-foreground" key={x.index} value={x.index}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          {side === "A" ? "Reference replication" : "Compared replication"}
          <select
            className="h-8 w-full rounded border bg-transparent text-foreground"
            value={sel.effectiveDid ?? ""}
            onChange={(e) => sel.onReplicationChange(Number(e.currentTarget.value))}
          >
            {sel.replications.map((x) => (
              <option className="bg-background text-foreground" key={x.did} value={x.did}>
                {x.xname ?? x.didname ?? String(x.did)}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  });

  const dataSourceContent = (
    <div className="space-y-3">
      {hasPackage && !status.loading && (
        <div className="grid grid-cols-2 gap-2 rounded border px-2 py-1.5 text-[11px] text-muted-foreground">
          <div><span className="font-medium text-foreground">Reference</span>: {status.sectionsA.toLocaleString()} sections · {status.lanesA.toLocaleString()} lanes · {status.turnsA.toLocaleString()} turns</div>
          <div><span className="font-medium text-foreground">Compared</span>: {status.sectionsB.toLocaleString()} sections · {status.lanesB.toLocaleString()} lanes · {status.turnsB.toLocaleString()} turns</div>
        </div>
      )}
      <div hidden={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo"} className="flex gap-2">
        <input
          className="h-8 min-w-0 flex-1 rounded border bg-transparent px-2 text-sm"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("toolbar.scenarioComparison.manifestPlaceholder")}
          aria-label={t("toolbar.scenarioComparison.manifestUrl")}
        />
        <Button size="sm" onClick={loadPackage}>{t("toolbar.scenarioComparison.load")}</Button>
        <Button variant="outline" size="sm" onClick={() => void loadLocalScenarioComparisonFolder()} disabled={!canLoadLocalScenarioComparisonPackage()}>
          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.scenarioComparison.loadFolder")}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">{sideSelectors}</div>
      <Button variant="outline" size="sm" className="w-full" onClick={swapScenarioComparisonSides} disabled={status.loading || !hasPackage}>
        <ArrowLeftRight className="me-1.5 h-3.5 w-3.5" />
        Swap Reference / Compared
      </Button>
    </div>
  );

  const styleContent = (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-xs">{t("toolbar.scenarioComparison.mode")}</span>
        <div className="flex items-center gap-1.5">
          <Button variant={s.mode === "diff" ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={s.mode === "diff"} onClick={() => setScenarioComparisonSettings({ mode: "diff", metric: s.metric === "flow" || s.metric === "density" || s.metric === "speed" ? "flow_delta" : s.metric })}>{t("toolbar.scenarioComparison.diff")}</Button>
          <Button variant={s.mode === "side-by-side" ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={s.mode === "side-by-side"} onClick={() => setScenarioComparisonSettings({ mode: "side-by-side", metric: s.metric.endsWith("_delta") || s.metric.startsWith("cmp_") ? "flow" : s.metric })}>{t("toolbar.scenarioComparison.sideBySide")}</Button>
        </div>
      </div>
      <label className="block text-xs">
        Metric
        <select className="h-8 w-full rounded border bg-transparent text-foreground" value={s.metric} onChange={(e) => setScenarioComparisonSettings({ metric: e.currentTarget.value as typeof s.metric })}>
          {(s.mode === "side-by-side" ? (["flow", "speed", "density"] as const) : (["flow_delta", "density_delta", "speed_delta", "delay_delta", "cmp_flow_sign", "cmp_flow_density_quadrant"] as const)).map((m) => <option className="bg-background text-foreground" key={m} value={m}>{{flow:"Flow",speed:"Speed",density:"Density",flow_delta:"Flow difference",density_delta:"Density difference",speed_delta:"Speed difference",delay_delta:"Delay difference",cmp_flow_sign:"Flow sign",cmp_flow_density_quadrant:"Flow-density quadrant"}[m]}</option>)}
        </select>
      </label>
      {s.mode === "diff" && (
        <>
          {isComparisonDifferenceMetric(s.metric) && <label className="block text-xs">
            {t("toolbar.scenarioComparison.minimumDifference")}
            <select className="mt-1 h-8 w-full rounded border bg-transparent text-foreground" value={s.differenceThreshold} onChange={(e) => setScenarioComparisonSettings({ differenceThreshold: Number(e.currentTarget.value) })}>
              {comparisonThresholdOptions(s.metric).map((value) => <option className="bg-background text-foreground" key={value} value={value}>{value === 0 ? t("toolbar.scenarioComparison.showAllDifferences") : `\u00b1${value} ${continuous?.unit ?? ""}`}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-muted-foreground">{t("toolbar.scenarioComparison.minimumDifferenceHint")}</span>
          </label>}
          {s.metric === "flow_delta" && <label className="block text-xs">
            {t("toolbar.scenarioComparison.flowDifferenceScale", { value: s.flowDifferenceScale })}
            <input className="w-full" type="range" min={10} max={2000} step={10} value={s.flowDifferenceScale} onChange={(e) => setScenarioComparisonSettings({ flowDifferenceScale: Number(e.currentTarget.value) })} />
          </label>}
        </>
      )}
      <div className="flex items-center gap-1.5">
        <Button variant={!viewMode.extruded ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={!viewMode.extruded} onClick={viewMode.setFlat}>
          <Square className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.scenarioComparison.flat")}
        </Button>
        <Button variant={viewMode.extruded ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={viewMode.extruded} onClick={viewMode.setExtruded}>
          <Box className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.scenarioComparison.extruded")}
        </Button>
      </div>
      {viewMode.extruded && <label className="block text-xs">
        {t("toolbar.scenarioComparison.height")}
        <input
          className="w-full"
          type="range"
          min={1}
          max={200}
          value={viewMode.heightSlider.value}
          onChange={(e) => viewMode.setMaxHeight(Number(e.currentTarget.value))}
        />
      </label>}
      <label className="block text-xs">
        {t("toolbar.scenarioComparison.opacity")}
        <input className="w-full" type="range" min="0.1" max="1" step="0.05" value={s.opacity} onChange={(e) => setScenarioComparisonSettings({ opacity: Number(e.currentTarget.value) })} />
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={s.seeThroughBuildings}
          onChange={(e) =>
            setScenarioComparisonSettings({ seeThroughBuildings: e.currentTarget.checked })
          }
        />
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t("toolbar.scenarioComparison.seeThroughBuildings")}
        </span>
      </label>
      {s.mode === "side-by-side" && (s.metric === "flow" || s.metric === "density" || s.metric === "speed") && (() => {
        const sideRamp = sideBySideLegend(s.metric);
        return <div><div className="flex justify-between text-xs"><span>{sideRamp.label}</span><span>{sideRamp.unit}</span></div><div className="h-4 rounded" style={{ background: `linear-gradient(to right, ${sideRamp.colors.join(", ")})` }} /><div className="flex justify-between text-xs">{sideRamp.stops.map(x=><span key={x}>{x}</span>)}</div></div>;
      })()}
      {s.mode === "diff" && (s.metric.startsWith("cmp_") && ramp ? (
        <div>
          {ramp.categories.map((c) => (
            <div key={c.key} className="flex items-center gap-2 text-xs">
              <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: c.color }} />
              {c.label}
            </div>
          ))}
        </div>
      ) : (
        continuous && (
          <div>
            <div className="flex justify-between text-xs">
              <span>{continuous.label}</span>
              <span>{continuous.unit}</span>
            </div>
            <div className="h-4 rounded" style={{ background: `linear-gradient(to right, ${continuous.colors.join(", ")})` }} />
            <div className="flex justify-between text-xs">
              {continuous.stops.map((x) => <span key={x}>{x}</span>)}
            </div>
          </div>
        )
      ))}
    </div>
  );

  const playbackContent = intervalPlayback.hasRealIntervals || status.aggregateAvailable ? (
    <div className="space-y-1">
      <PlaybackTimelineReadout timeline={status.timelineA} currentSeconds={status.currentTimeSeconds ?? Number.NaN} intervalSeconds={status.timelineA?.intervalDurationSeconds} />
      {intervalPlayback.isAggregate && <span className="block text-xs text-muted-foreground">Whole period</span>}
      <span className="block text-xs text-muted-foreground">{t("toolbar.scenarioComparison.interval")}</span>
      {intervalPlayback.hasRealIntervals && <input
        className="h-5 w-full cursor-ew-resize accent-sky-500 disabled:opacity-50"
        type="range"
        min={0}
        max={intervalPlayback.realIntervals.length - 1}
        value={intervalPlayback.scrubberIndex}
        disabled={status.loading || intervalPlayback.isAggregate}
        onChange={(e) => intervalPlayback.setScrubberIndex(Number(e.currentTarget.value))}
      />}
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("toolbar.scenarioComparison.previous")} onClick={() => intervalPlayback.step(-1)} disabled={status.loading || !status.intervals.length}><SkipBack className="h-4 w-4" /></Button>
        <Button variant="secondary" size="icon" className="h-9 w-9" aria-label={s.intervalPlaying ? t("toolbar.scenarioComparison.pause") : t("toolbar.scenarioComparison.play")} onClick={intervalPlayback.togglePlaying} disabled={status.loading || !status.intervals.length}>{s.intervalPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("toolbar.scenarioComparison.next")} onClick={() => intervalPlayback.step(1)} disabled={status.loading || !status.intervals.length}><SkipForward className="h-4 w-4" /></Button>
        <label className="ms-auto flex items-center gap-2 text-xs"><input type="checkbox" checked={intervalPlayback.isAggregate} disabled={!status.aggregateAvailable} onChange={(e) => intervalPlayback.setAggregate(e.currentTarget.checked)} />Whole period</label>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><label className="flex-1">Speed <input className="w-20 accent-sky-500" type="range" min="0.25" max="8" step="0.25" value={s.playbackSpeed} onChange={(e) => setScenarioComparisonSettings({ playbackSpeed: Number(e.currentTarget.value) })} /></label><span>{s.playbackSpeed}×</span><label className="flex items-center gap-1"><input type="checkbox" checked={s.loop} onChange={(e) => setScenarioComparisonSettings({ loop: e.currentTarget.checked })} />Loop</label></div>
    </div>
  ) : (
    <div className="rounded border px-2 py-3 text-xs text-muted-foreground">
      {hasPackage
        ? (status.loading ? "Loading playback intervals…"
          : status.timeMatchReason === "missing-timeline" ? "Playback comparison is disabled because one or both scenarios are missing timing metadata."
          : status.timeMatchReason === "period-mismatch" ? "Playback comparison is disabled because the scenarios cover different simulation periods."
          : status.timeMatchReason === "no-matching-times" ? "Playback comparison is disabled because the scenarios have no matching simulation times."
          : "No playback intervals are available for this comparison.")
        : "Load a comparison package to enable playback."}
    </div>
  );

  return (
    <div className="absolute left-3 top-24 z-20 w-80 rounded-md border bg-background shadow-lg">
      <div className="flex items-center justify-between p-3">
        <h2 className="font-semibold">{t("toolbar.scenarioComparison.title")}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" title={collapsed ? t("toolbar.scenarioComparison.expand") : t("toolbar.scenarioComparison.collapse")} aria-label={collapsed ? t("toolbar.scenarioComparison.expand") : t("toolbar.scenarioComparison.collapse")} onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => closeScenarioComparisonPanel()} aria-label={t("toolbar.scenarioComparison.close")}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {!collapsed && (
        <div className="p-3">
          <Tabs defaultValue="data-source">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="data-source">{t("toolbar.scenarioComparison.tabs.dataSource")}</TabsTrigger>
              <TabsTrigger value="style">{t("toolbar.scenarioComparison.tabs.style")}</TabsTrigger>
              <TabsTrigger value="playback">{t("toolbar.scenarioComparison.tabs.playback")}</TabsTrigger>
            </TabsList>
            <TabsContent value="data-source" className="space-y-3">
              {dataSourceContent}
            </TabsContent>
            <TabsContent value="style" className="space-y-3">
              {styleContent}
            </TabsContent>
            <TabsContent value="playback" className="space-y-3">
              {playbackContent}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}
