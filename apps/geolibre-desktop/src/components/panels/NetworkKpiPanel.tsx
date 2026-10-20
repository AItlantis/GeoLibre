import {
  canLoadLocalNetworkKpiPackage,
  closeNetworkKpiPanel,
  getNetworkKpiDashboardSnapshot,
  getNetworkKpiSnapshot,
  getNetworkKpiStatus,
  isNetworkKpiPanelVisible,
  KPI_RAMPS,
  loadLocalNetworkKpiFolder,
  NETWORK_KPI_MAX_HEIGHT_MAX,
  NETWORK_KPI_MAX_HEIGHT_MIN,
  NETWORK_KPI_METRICS,
  NETWORK_KPI_OPACITY_MAX,
  NETWORK_KPI_OPACITY_MIN,
  setNetworkKpiDashboardScope,
  setNetworkKpiManifestUrl,
  setNetworkKpiScenario,
  stepNetworkKpiInterval,
  toggleNetworkKpiIntervalPlaying,
  setNetworkKpiReplication,
  setNetworkKpiSettings,
  subscribeNetworkKpi,
  subscribeNetworkKpiDashboard,
  subscribeNetworkKpiPanel,
  subscribeNetworkKpiStatus,
  useIntervalPlayback,
  useManifestUrlDraft,
  useScenarioReplicationSelector,
  useViewModeToggle,
  type NetworkKpiMetric,
  type NetworkKpiDashboardSample,
  type NetworkKpiSectionSample,
} from "@geolibre/plugins";
import { Button, Slider, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { BarChart3, Box, Eye, FolderOpen, Loader2, PanelBottomClose, PanelBottomOpen, Pause, Play, SkipBack, SkipForward, Square, X } from "lucide-react";
import { PlaybackTimelineReadout, intervalCurrentSeconds } from "./PlaybackTimelineReadout";
import { ScenarioComparisonDashboardPanel } from "./ScenarioComparisonPanel";
import {
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  registerNetworkKpiLegend,
  unregisterNetworkKpiLegend,
} from "../../lib/network-kpi-legend";

/**
 * Lateral panel driving the static network KPI view (Controls → Network KPI).
 *
 * The "results mode" counterpart to the Vehicle Playback panel: the same package
 * and the same manifest, read as one aggregate value per road rather than as a
 * time series. Renders only while open and subscribes to the plugin store; all
 * map work lives in the plugin's engine, so this component only reads and writes
 * the shared settings plus it owns the manifest-URL input.
 */
export function NetworkKpiPanel() {
  const visible = useSyncExternalStore(
    subscribeNetworkKpiPanel,
    isNetworkKpiPanelVisible,
    isNetworkKpiPanelVisible,
  );
  if (!visible) return null;
  // Testudo owns a dedicated docked Results panel. Keep this plugin controls
  // dialog available in ordinary GeoLibre layouts only.
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo") return null;
  return <NetworkKpiCard />;
}

/** Testudo's lateral Results panel body, rendered by DesktopShell's right dock. */
export function NetworkKpiDashboardPanel() {
  const { t } = useTranslation();
  const [activeDashboard, setActiveDashboard] = useState("results");
  useEffect(() => {
    const onViewModeChanged = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode;
      if (mode === "results") setActiveDashboard("results");
      else if (mode === "comparison") setActiveDashboard("comparison");
    };
    window.addEventListener("testudo-view-mode-changed", onViewModeChanged);
    return () => window.removeEventListener("testudo-view-mode-changed", onViewModeChanged);
  }, []);
  return (
    <Tabs value={activeDashboard} onValueChange={setActiveDashboard}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="results">{t("toolbar.networkKpi.tabs.dashboard")}</TabsTrigger>
        <TabsTrigger value="comparison">Comparison</TabsTrigger>
      </TabsList>
      <TabsContent value="results" className="mt-3"><NetworkKpiDashboard /></TabsContent>
      <TabsContent value="comparison" className="mt-3"><ScenarioComparisonDashboardPanel /></TabsContent>
    </Tabs>
  );
}

function NetworkKpiCard() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeNetworkKpi,
    getNetworkKpiSnapshot,
    getNetworkKpiSnapshot,
  );
  const status = useSyncExternalStore(
    subscribeNetworkKpiStatus,
    getNetworkKpiStatus,
    getNetworkKpiStatus,
  );
  const [collapsed, setCollapsed] = useState(false);

  const { manifestUrl, metric, extruded, maxHeightM, opacity, interval, intervalPlaying, did, seeThroughBuildings, showNetwork, showSections, showLanes, showTurns, showNodes } =
    settings;
  const {
    loading,
    error,
    featureCount,
    detailed,
    hasResults,
    hasLanes,
    intervals,
    scenarios,
    scenarioIndex,
    replications,
    localFolderName,
    timeline,
  } = status;
  const canLoadFolder = canLoadLocalNetworkKpiPackage();
  const ramp = KPI_RAMPS[metric];
  // Local folder packages intentionally have no manifest URL; they are still
  // fully loaded packages and must expose Style/Playback just like URL loads.
  const hasPackage = (manifestUrl != null && manifestUrl.length > 0) || localFolderName != null;

  const { urlDraft, setUrlDraft, loadPackage, handleKeyDown } = useManifestUrlDraft(
    manifestUrl,
    setNetworkKpiManifestUrl,
  );

  const scenarioReplication = useScenarioReplicationSelector({
    scenarios,
    scenarioIndex,
    replications,
    selectedDid: did,
    onScenarioChange: (index) => void setNetworkKpiScenario(index),
    onReplicationChange: (nextDid) => setNetworkKpiReplication(nextDid),
  });

  const intervalPlayback = useIntervalPlayback({
    intervals,
    interval,
    onIntervalChange: (nextInterval) => setNetworkKpiSettings({ interval: nextInterval }),
    onStep: (direction) => stepNetworkKpiInterval(direction),
    onTogglePlaying: toggleNetworkKpiIntervalPlaying,
  });

  const viewMode = useViewModeToggle({
    extruded,
    maxHeightM,
    heightMin: NETWORK_KPI_MAX_HEIGHT_MIN,
    heightMax: NETWORK_KPI_MAX_HEIGHT_MAX,
    onExtrudedChange: (nextExtruded) => setNetworkKpiSettings({ extruded: nextExtruded }),
    onMaxHeightChange: (value) => setNetworkKpiSettings({ maxHeightM: value }),
  });

  // The KPI polygons render outside the layer store, so the auto-legend cannot
  // see them. Publish a standalone ramp section while results are loaded and
  // this panel is open, and withdraw it as soon as either stops holding — the
  // cleanup also covers the panel being closed, which unmounts this component.
  // `metric` is in the dependency list so switching metric rewrites the section
  // rather than leaving the previous ramp on screen. This effect is keyed off
  // panel-open/hasResults, not the active tab, so switching tabs never tears it
  // down.
  const legendTitle = t("toolbar.networkKpi.legendTitle", {
    metric: ramp.label,
    unit: ramp.unit,
  });
  useEffect(() => {
    if (!hasResults) {
      unregisterNetworkKpiLegend();
      return;
    }
    registerNetworkKpiLegend(legendTitle, metric);
    return () => unregisterNetworkKpiLegend();
  }, [hasResults, legendTitle, metric]);

  const dataSourceContent = (
    <div className="space-y-1">
      <div hidden={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo"}>
      <span className="block text-xs text-muted-foreground">
        {t("toolbar.networkKpi.manifestUrl")}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          placeholder={t("toolbar.networkKpi.manifestPlaceholder")}
          value={urlDraft}
          aria-label={t("toolbar.networkKpi.manifestUrl")}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8"
          disabled={loading || urlDraft.trim().length === 0}
          onClick={loadPackage}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t("toolbar.networkKpi.load")
          )}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1"
          disabled={loading || !canLoadFolder}
          title={
            canLoadFolder
              ? t("toolbar.networkKpi.loadFolderTooltip")
              : t("toolbar.networkKpi.loadFolderUnsupported")
          }
          onClick={() => void loadLocalNetworkKpiFolder()}
        >
          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.networkKpi.loadFolder")}
        </Button>
      </div>
      {!canLoadFolder && (
        <p className="text-xs text-muted-foreground">
          {t("toolbar.networkKpi.loadFolderUnsupported")}
        </p>
      )}
      </div>
      {localFolderName && (
        <p className="truncate text-xs text-muted-foreground">
          {t("toolbar.networkKpi.localFolder", { name: localFolderName })}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Only a genuinely multi-scenario package gets a picker; a single
          scenario auto-selects. */}
      {scenarioReplication.showScenarioPicker && (
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">
            {t("toolbar.networkKpi.scenario")}
          </span>
          <select
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            aria-label={t("toolbar.networkKpi.scenario")}
            value={scenarioReplication.scenarioIndex}
            disabled={loading}
            onChange={(e) => scenarioReplication.onScenarioChange(Number(e.currentTarget.value))}
          >
            {scenarioReplication.scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.index}>
                {scenario.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Replication depends on which scenario is selected, so it is
          offered only after the scenario picker, never ahead of it. */}
      {scenarioReplication.showReplicationPicker && (
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">
            {t("toolbar.networkKpi.replication")}
          </span>
          <select className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={scenarioReplication.effectiveDid} disabled={loading} onChange={(e) => scenarioReplication.onReplicationChange(Number(e.currentTarget.value))}>
            {scenarioReplication.replications.map((replication) => <option key={replication.did} value={replication.did}>{replication.didname ?? t("toolbar.networkKpi.replicationFallback", { did: replication.did })}</option>)}
          </select>
        </div>
      )}
    </div>
  );

  const styleContent = (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">
          {t("toolbar.networkKpi.metricLabel")}
        </span>
        <div className="flex items-center gap-1.5">
          {NETWORK_KPI_METRICS.map((key: NetworkKpiMetric) => (
            <Button
              key={key}
              variant={metric === key ? "secondary" : "ghost"}
              size="sm"
              className="h-7 flex-1 text-xs"
              aria-pressed={metric === key}
              onClick={() => setNetworkKpiSettings({ metric: key })}
            >
              {t(`toolbar.networkKpi.metric.${key}`)}
            </Button>
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" checked={seeThroughBuildings} onChange={(e) => setNetworkKpiSettings({ seeThroughBuildings: e.currentTarget.checked })} /><Eye className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-muted-foreground">{t("toolbar.networkKpi.seeThroughBuildings")}</span></label>
      <div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2"><label className="flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" checked={showNetwork} onChange={(e) => setNetworkKpiSettings({ showNetwork: e.currentTarget.checked })} /><span className="text-muted-foreground">{t("toolbar.networkKpi.showNetwork")}</span></label><div className="grid grid-cols-2 gap-1.5 text-xs">{([["showSections", showSections], ["showLanes", showLanes], ["showTurns", showTurns], ["showNodes", showNodes]] as const).map(([key, checked]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" disabled={!showNetwork} checked={checked} onChange={(e) => setNetworkKpiSettings({ [key]: e.currentTarget.checked })} />{t(`toolbar.networkKpi.${key}`)}</label>)}</div></div>

      <div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant={!viewMode.extruded ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-xs"
            aria-pressed={!viewMode.extruded}
            onClick={viewMode.setFlat}
          >
            <Square className="me-1.5 h-3.5 w-3.5" />
            {t("toolbar.networkKpi.flat")}
          </Button>
          <Button
            variant={viewMode.extruded ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-xs"
            aria-pressed={viewMode.extruded}
            onClick={viewMode.setExtruded}
          >
            <Box className="me-1.5 h-3.5 w-3.5" />
            {t("toolbar.networkKpi.extruded")}
          </Button>
        </div>
        {/* The height ceiling only means anything while extruded, so it is
            disabled rather than hidden — hiding it would make the 2D/3D
            toggle reflow the card under the pointer. */}
        <SliderRow
          label={t("toolbar.networkKpi.maxHeight")}
          min={NETWORK_KPI_MAX_HEIGHT_MIN}
          max={NETWORK_KPI_MAX_HEIGHT_MAX}
          step={1}
          value={viewMode.heightSlider.value}
          disabled={viewMode.heightSlider.disabled}
          format={(v) => `${Math.round(v)} m`}
          onChange={viewMode.setMaxHeight}
        />
      </div>

      {!hasLanes && <p className="text-xs text-muted-foreground">{t("toolbar.networkKpi.noLanes")}</p>}

      <SliderRow
        label={t("toolbar.networkKpi.opacity")}
        min={NETWORK_KPI_OPACITY_MIN}
        max={NETWORK_KPI_OPACITY_MAX}
        step={0.05}
        value={opacity}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setNetworkKpiSettings({ opacity: v })}
      />

      {/* The ramp is continuous; the five stops are its interpolation anchors,
          so the gradient bar shows the real ramp and the labels locate the
          anchors along it. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t("toolbar.networkKpi.legend")}</span>
          <span className="text-muted-foreground">{ramp.unit}</span>
        </div>
        <div
          className="h-3 w-full rounded-sm border border-border"
          style={{ background: `linear-gradient(to right, ${ramp.colors.join(", ")})` }}
        />
        <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
          {ramp.stops.map((stop) => (
            <span key={stop}>{stop}</span>
          ))}
        </div>
      </div>
    </div>
  );

  const playbackContent = intervalPlayback.hasRealIntervals ? (
    <div className="space-y-1">
      <PlaybackTimelineReadout timeline={timeline} currentSeconds={intervalCurrentSeconds(timeline, intervals, interval)} intervalSeconds={timeline?.intervalDurationSeconds} />
      <span className="block text-xs text-muted-foreground">
        {t("toolbar.networkKpi.interval")}
      </span>
      <input type="range" min={0} max={intervalPlayback.realIntervals.length - 1} value={intervalPlayback.scrubberIndex} className="h-5 w-full cursor-ew-resize accent-sky-500 disabled:opacity-50" disabled={loading || intervalPlayback.isAggregate} aria-label={t("toolbar.networkKpi.interval")} onChange={(e) => intervalPlayback.setScrubberIndex(Number(e.currentTarget.value))} />
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("toolbar.networkKpi.intervalPrevious")} onClick={() => intervalPlayback.step(-1)} disabled={loading}><SkipBack className="h-4 w-4" /></Button>
        <Button variant="secondary" size="icon" className="h-9 w-9" aria-label={intervalPlaying ? t("toolbar.networkKpi.intervalPause") : t("toolbar.networkKpi.intervalPlay")} onClick={intervalPlayback.togglePlaying} disabled={loading}>{intervalPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("toolbar.networkKpi.intervalNext")} onClick={() => intervalPlayback.step(1)} disabled={loading}><SkipForward className="h-4 w-4" /></Button>
        <label className="ms-auto flex items-center gap-2 text-xs"><input type="checkbox" checked={intervalPlayback.isAggregate} onChange={(e) => intervalPlayback.setAggregate(e.currentTarget.checked)} />{t("toolbar.networkKpi.intervalAggregateToggle")}</label>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <label className="flex-1">Speed <input className="w-20 accent-sky-500" type="range" min="0.25" max="8" step="0.25" value={settings.playbackSpeed} onChange={(e) => setNetworkKpiSettings({ playbackSpeed: Number(e.currentTarget.value) })} /></label>
        <span>{settings.playbackSpeed}×</span>
        <label className="flex items-center gap-1"><input type="checkbox" checked={settings.loop} onChange={(e) => setNetworkKpiSettings({ loop: e.currentTarget.checked })} />Loop</label>
      </div>
    </div>
  ) : null;

  return (
    <div
      className={`absolute inset-y-3 z-30 flex flex-col overflow-hidden rounded-lg border border-border map-glass shadow-lg ${collapsed ? "" : "w-[min(27rem,calc(100vw-1.5rem))]"}`}
      style={{ insetInlineEnd: 12, top: 64, bottom: 12, width: collapsed ? 48 : undefined }}
      role="dialog"
      aria-label={t("toolbar.networkKpi.title")}
    >
      <div className={`flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 py-2 ${collapsed ? "justify-center px-1" : "px-3"}`}>
        {!collapsed && <BarChart3 className="h-4 w-4 shrink-0 text-emerald-500" />}
        {!collapsed && <span className="text-sm font-medium">{t("toolbar.networkKpi.title")}</span>}
        {!collapsed && featureCount > 0 && (
          <span className="ms-1 truncate text-xs tabular-nums text-muted-foreground">
            {detailed
              ? t("toolbar.networkKpi.laneCount", { count: featureCount })
              : t("toolbar.networkKpi.sectionCount", { count: featureCount })}
          </span>
        )}

        <Button variant="ghost" size="icon" className="h-6 w-6" title={collapsed ? t("toolbar.networkKpi.expand") : t("toolbar.networkKpi.collapse")} aria-label={collapsed ? t("toolbar.networkKpi.expand") : t("toolbar.networkKpi.collapse")} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
        </Button>
        {!collapsed && <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.networkKpi.close")}
          onClick={() => closeNetworkKpiPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>}
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!hasPackage ? (
            dataSourceContent
          ) : (
            <Tabs key={hasResults ? "ready" : "empty"} defaultValue={hasResults ? "dashboard" : "data-source"}>
              <TabsList className={`grid w-full ${hasResults ? "grid-cols-4" : "grid-cols-3"}`}>
                {hasResults && <TabsTrigger value="dashboard">{t("toolbar.networkKpi.tabs.dashboard")}</TabsTrigger>}
                <TabsTrigger value="data-source">{t("toolbar.networkKpi.tabs.dataSource")}</TabsTrigger>
                <TabsTrigger value="style">{t("toolbar.networkKpi.tabs.style")}</TabsTrigger>
                <TabsTrigger value="playback">{t("toolbar.networkKpi.tabs.playback")}</TabsTrigger>
              </TabsList>
              {hasResults && <TabsContent value="dashboard" className="mt-3"><NetworkKpiDashboard /></TabsContent>}
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
          )}
        </div>
      )}
    </div>
  );
}

const DASHBOARD_METRICS = [
  { key: "flow" as const, label: "flow", unit: "veh/h", max: 2200, color: "#38bdf8" },
  { key: "density" as const, label: "density", unit: "veh/km", max: 160, color: "#f59e0b" },
  { key: "speed" as const, label: "speed", unit: "km/h", max: 120, color: "#34d399" },
] as const;

type DashboardChartSample = Pick<NetworkKpiSectionSample, "interval" | "flow" | "density" | "speed"> & Partial<Pick<NetworkKpiDashboardSample,
  "flowContributors" | "densityContributors" | "densityLengthKm" | "densityScopeLengthKm" | "speedContributors" | "speedFlowWeight"
>> & {
  flowDensity?: NetworkKpiDashboardSample["flowDensity"];
  flowSpeed?: NetworkKpiDashboardSample["flowSpeed"];
};

function dashboardNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function dashboardIntervalLabel(interval: number, timeline: ReturnType<typeof getNetworkKpiStatus>["timeline"], wholePeriodLabel = "Whole period"): string {
  if (interval === 0) return wholePeriodLabel;
  if (timeline?.initialTimeSeconds == null || timeline.intervalDurationSeconds == null) return `I${interval}`;
  const seconds = Math.max(0, Math.round(timeline.initialTimeSeconds + (interval - 1) * timeline.intervalDurationSeconds));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
}

function NetworkKpiDashboard() {
  const { t } = useTranslation();
  const dashboard = useSyncExternalStore(subscribeNetworkKpiDashboard, getNetworkKpiDashboardSnapshot, getNetworkKpiDashboardSnapshot);
  const settings = useSyncExternalStore(subscribeNetworkKpi, getNetworkKpiSnapshot, getNetworkKpiSnapshot);
  const status = useSyncExternalStore(subscribeNetworkKpiStatus, getNetworkKpiStatus, getNetworkKpiStatus);
  const series = dashboard.series;
  const selected = dashboard.scope === "selected";
  const samples: DashboardChartSample[] = selected
    ? dashboard.entitySeries ?? []
    : series?.samples ?? [];
  const current = samples.find(sample => sample.interval === settings.interval) ?? samples.at(-1) ?? null;
  const periodAggregate = selected ? samples.length === 1 && samples[0]?.interval === 0 : Boolean(series?.periodAggregate);
  const coverageGap = Boolean(series && (series.geometryMissingCount > 0 || samples.some(sample =>
    (sample.flowContributors ?? 0) < series.sectionCount || (sample.densityContributors ?? 0) < series.sectionCount || (sample.speedContributors ?? 0) < series.sectionCount,
  )));

  return (
    <section className="space-y-3" aria-label={t("toolbar.networkKpi.dashboard.title")}>
      <div className="space-y-1">
        <label htmlFor="network-kpi-dashboard-scope" className="block text-xs font-medium">{t("toolbar.networkKpi.dashboard.scope")}</label>
        <select
          id="network-kpi-dashboard-scope"
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={dashboard.scope}
          onChange={event => setNetworkKpiDashboardScope(event.currentTarget.value as "selected" | "viewport" | "network")}
        >
          <option value="selected">{t("toolbar.networkKpi.dashboard.selected")}</option>
          <option value="viewport">{t("toolbar.networkKpi.dashboard.viewport")}</option>
          <option value="network">{t("toolbar.networkKpi.dashboard.network")}</option>
        </select>
      </div>

      {selected && (
        <p className="text-xs text-muted-foreground">
          {dashboard.selectedEntity?.name ?? dashboard.selectedSectionName ?? t("toolbar.networkKpi.dashboard.selectSection")}
          {dashboard.entityStatsFallback ? ` · ${t("toolbar.networkKpi.dashboard.sectionFallback")}` : ""}
        </p>
      )}
      {dashboard.loading && <p role="status" className="text-sm text-muted-foreground">{t("toolbar.networkKpi.dashboard.loading")}</p>}
      {dashboard.error && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{t("toolbar.networkKpi.dashboard.error", { error: dashboard.error })}</p>}
      {!dashboard.loading && !dashboard.error && selected && dashboard.selectedEntity == null && dashboard.selectedSectionId == null && (
        <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("toolbar.networkKpi.dashboard.selectSection")}</p>
      )}
      {!dashboard.loading && !dashboard.error && dashboard.scope === "viewport" && dashboard.viewportSectionCount === 0 && (
        <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("toolbar.networkKpi.dashboard.emptyViewport")}</p>
      )}
      {!dashboard.loading && !dashboard.error && (selected ? samples.length > 0 : Boolean(series && series.sectionCount > 0)) && !current && (
        <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("toolbar.networkKpi.dashboard.noValues")}</p>
      )}

      {!dashboard.loading && !dashboard.error && current && (selected || series) && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {DASHBOARD_METRICS.map(metric => (
              <div key={metric.key} className="min-w-0 rounded-md border border-border p-2">
                <span className="block truncate text-xs text-muted-foreground">{t(`toolbar.networkKpi.metric.${metric.label}`)}</span>
                <strong className="block truncate text-base tabular-nums">{dashboardNumber(current[metric.key])}</strong>
                <span className="block text-[10px] text-muted-foreground">{metric.key === "flow" && selected ? "veh/h/lane" : metric.unit}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(selected ? "toolbar.networkKpi.dashboard.singleFormula" : "toolbar.networkKpi.dashboard.formula")}
          </p>
          {!selected && coverageGap && (
            <p role="status" className="rounded-md border border-amber-500/40 p-2 text-xs text-muted-foreground">
              {t("toolbar.networkKpi.dashboard.coverage", {
                sections: series?.sectionCount ?? 0,
                flow: current.flowContributors ?? 0,
                density: current.densityContributors ?? 0,
                speed: current.speedContributors ?? 0,
                lengthKm: dashboardNumber(current.densityLengthKm),
                scopeLengthKm: dashboardNumber(current.densityScopeLengthKm),
                flowWeight: dashboardNumber(current.speedFlowWeight),
                flowTotal: dashboardNumber(current.flow),
                missingGeometry: series?.geometryMissingCount ?? 0,
              })}
            </p>
          )}
          {periodAggregate ? (
            <p role="status" className="rounded-md border border-border p-2 text-sm text-muted-foreground">{t("toolbar.networkKpi.dashboard.periodAggregate")}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2">
                {DASHBOARD_METRICS.map(metric => (
                  <DashboardLineChart key={metric.key} metric={metric} samples={samples} selectedInterval={settings.interval} timeline={status.timeline} fixedDomain={selected ? [0, metric.max] : undefined} />
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                <DashboardScatterChart kind="density" samples={samples} selectedInterval={settings.interval} timeline={status.timeline} fixedFlowDomain={selected ? [0, 2200] : undefined} fixedMetricDomain={selected ? [0, 160] : undefined} />
                <DashboardScatterChart kind="speed" samples={samples} selectedInterval={settings.interval} timeline={status.timeline} fixedFlowDomain={selected ? [0, 2200] : undefined} fixedMetricDomain={selected ? [0, 120] : undefined} />
              </div>
              <details className="rounded-md border border-border p-2">
                <summary className="cursor-pointer text-xs font-medium">{t("toolbar.networkKpi.dashboard.dataTable")}</summary>
                <div className="mt-2 max-h-48 overflow-auto">
                  <table className="w-full text-start text-xs tabular-nums">
                    <caption className="sr-only">{t("toolbar.networkKpi.dashboard.dataTableCaption")}</caption>
                    <thead><tr><th scope="col">{t("toolbar.networkKpi.interval")}</th><th scope="col">{t("toolbar.networkKpi.metric.flow")}</th><th scope="col">{t("toolbar.networkKpi.metric.density")}</th><th scope="col">{t("toolbar.networkKpi.metric.speed")}</th></tr></thead>
                    <tbody>{samples.map(sample => <tr key={sample.interval} aria-current={sample.interval === settings.interval ? "true" : undefined}>
                      <th scope="row">{dashboardIntervalLabel(sample.interval, status.timeline, t("toolbar.networkKpi.intervalAggregate"))}</th>
                      <td>{dashboardNumber(sample.flow)} {selected ? "veh/h/lane" : DASHBOARD_METRICS[0].unit}</td>
                      <td>{dashboardNumber(sample.density)} {DASHBOARD_METRICS[1].unit}</td>
                      <td>{dashboardNumber(sample.speed)} {DASHBOARD_METRICS[2].unit}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

function DashboardLineChart({
  metric,
  samples,
  selectedInterval,
  timeline,
  fixedDomain,
}: {
  metric: (typeof DASHBOARD_METRICS)[number];
  samples: DashboardChartSample[];
  selectedInterval: number;
  timeline: ReturnType<typeof getNetworkKpiStatus>["timeline"];
  fixedDomain?: [number, number];
}) {
  const { t } = useTranslation();
  const usable = samples.map(sample => sample[metric.key]).filter((value): value is number => value != null && Number.isFinite(value));
  const min = fixedDomain?.[0] ?? (usable.length ? Math.min(...usable) : 0);
  const max = fixedDomain?.[1] ?? (usable.length ? Math.max(...usable) : 0);
  const spread = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const timeIntervals = samples.map(sample => sample.interval).filter(interval => interval > 0);
  const firstInterval = timeIntervals.length ? Math.min(...timeIntervals) : 0;
  const lastInterval = timeIntervals.length ? Math.max(...timeIntervals) : 0;
  const points = samples.map(sample => {
    const value = sample[metric.key];
    const normalized = value == null ? null : Math.max(0, Math.min(1, (value - min) / spread));
    const x = lastInterval > firstInterval ? 14 + (sample.interval - firstInterval) * 83 / (lastInterval - firstInterval) : 55;
    return value == null || normalized == null ? null : { sample, value, x, y: 40 - normalized * 34 };
  });
  const path = points.map((point, index) => point ? `${index === 0 || points[index - 1] == null ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}` : "").filter(Boolean).join(" ");
  const title = t("toolbar.networkKpi.dashboard.overTime", { metric: t(`toolbar.networkKpi.metric.${metric.label}`) });
  return (
    <section className="rounded-md border border-border p-2">
      <div className="flex items-center justify-between text-xs"><strong>{title}</strong><span className="text-muted-foreground">{metric.key === "flow" && fixedDomain ? "veh/h/lane" : metric.unit}</span></div>
      {usable.length ? <svg viewBox="0 0 100 54" role="img" aria-label={`${title}, scale ${dashboardNumber(min)} to ${dashboardNumber(max)} ${metric.unit}`} className="network-kpi-dashboard-chart">
        {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="14" y1={6 + fraction * 34} x2="97" y2={6 + fraction * 34} className="network-kpi-chart-axis" /><text x="12" y={8 + fraction * 34} textAnchor="end" className="network-kpi-chart-label">{dashboardNumber(max - fraction * spread)}</text></g>)}
        <path d={path} fill="none" stroke={metric.color} strokeWidth="1.5" />
        {points.map((point, index) => point && <circle key={point.sample.interval} cx={point.x} cy={point.y} r={point.sample.interval === selectedInterval ? 2.3 : 1.3} fill={metric.color}>
          <title>{dashboardIntervalLabel(point.sample.interval, timeline, t("toolbar.networkKpi.intervalAggregate"))} · {dashboardNumber(point.value)} {metric.unit}</title>
        </circle>)}
        <text x="14" y="52" className="network-kpi-chart-label">{dashboardIntervalLabel(firstInterval, timeline)}</text><text x="97" y="52" textAnchor="end" className="network-kpi-chart-label">{dashboardIntervalLabel(lastInterval, timeline)}</text>
      </svg> : <p className="py-3 text-xs text-muted-foreground">{t("toolbar.networkKpi.dashboard.noMetricValues")}</p>}
    </section>
  );
}

function DashboardScatterChart({ kind, samples, selectedInterval, timeline, fixedFlowDomain, fixedMetricDomain }: { kind: "density" | "speed"; samples: DashboardChartSample[]; selectedInterval: number; timeline: ReturnType<typeof getNetworkKpiStatus>["timeline"]; fixedFlowDomain?: [number, number]; fixedMetricDomain?: [number, number] }) {
  const { t } = useTranslation();
  const points = samples.flatMap(sample => {
    const pair = kind === "density" ? sample.flowDensity : sample.flowSpeed;
    const x = pair?.flow ?? sample.flow;
    const y = pair?.metric ?? sample[kind];
    return x == null || y == null ? [] : [{ interval: sample.interval, x, y, contributors: pair?.contributors ?? 1 }];
  });
  const xMin = fixedFlowDomain?.[0] ?? (points.length ? Math.min(...points.map(point => point.x)) : 0);
  const xMax = fixedFlowDomain?.[1] ?? (points.length ? Math.max(...points.map(point => point.x)) : 0);
  const yMin = fixedMetricDomain?.[0] ?? (points.length ? Math.min(...points.map(point => point.y)) : 0);
  const yMax = fixedMetricDomain?.[1] ?? (points.length ? Math.max(...points.map(point => point.y)) : 0);
  const xSpread = xMax - xMin || Math.max(Math.abs(xMax) * 0.1, 1);
  const ySpread = yMax - yMin || Math.max(Math.abs(yMax) * 0.1, 1);
  const metricLabel = t(`toolbar.networkKpi.metric.${kind}`);
  const title = t("toolbar.networkKpi.dashboard.flowVs", { metric: metricLabel });
  return (
    <section className="min-w-0 rounded-md border border-border p-2">
      <div className="flex items-center justify-between text-xs"><strong>{title}</strong><span className="text-muted-foreground">{fixedFlowDomain ? "veh/h/lane" : "veh/h"} · {kind === "density" ? "veh/km" : "km/h"}</span></div>
      {points.length ? <svg viewBox="0 0 100 54" role="img" aria-label={`${title}, flow scale ${dashboardNumber(xMin)} to ${dashboardNumber(xMax)}, ${kind} scale ${dashboardNumber(yMin)} to ${dashboardNumber(yMax)}`} className="network-kpi-dashboard-chart">
        <line x1="4" y1="40" x2="97" y2="40" className="network-kpi-chart-axis" /><line x1="4" y1="4" x2="4" y2="40" className="network-kpi-chart-axis" />
        {points.map(point => <circle key={point.interval} cx={4 + (point.x - xMin) * 92 / xSpread} cy={39 - (point.y - yMin) * 34 / ySpread} r={point.interval === selectedInterval ? 2.3 : 1.5} fill={kind === "density" ? "#f59e0b" : "#34d399"}>
          <title>{`${dashboardIntervalLabel(point.interval, timeline, t("toolbar.networkKpi.intervalAggregate"))}: ${dashboardNumber(point.x)} veh/h · ${dashboardNumber(point.y)} ${kind === "density" ? "veh/km" : "km/h"} · ${point.contributors} sections`}</title>
        </circle>)}
        <text x="4" y="47" className="network-kpi-chart-label">{dashboardNumber(xMin)}</text><text x="97" y="47" textAnchor="end" className="network-kpi-chart-label">{dashboardNumber(xMax)}</text>
        <text x="4" y="53" className="network-kpi-chart-label">Flow</text><text x="97" y="53" textAnchor="end" className="network-kpi-chart-label">{kind === "density" ? "Density" : "Speed"}: {dashboardNumber(yMin)}–{dashboardNumber(yMax)}</text>
      </svg> : <p className="py-3 text-xs text-muted-foreground">{t("toolbar.networkKpi.dashboard.noPairedValues")}</p>}
    </section>
  );
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  disabled,
  format,
  onChange,
}: SliderRowProps) {
  return (
    <div className={`space-y-1${disabled ? " opacity-50" : ""}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{format(value)}</span>
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        onValueChange={([v]: number[]) => onChange(v ?? value)}
      />
    </div>
  );
}
