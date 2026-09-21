import {
  canLoadLocalNetworkKpiPackage,
  closeNetworkKpiPanel,
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
  setNetworkKpiManifestUrl,
  setNetworkKpiScenario,
  stepNetworkKpiInterval,
  toggleNetworkKpiIntervalPlaying,
  setNetworkKpiReplication,
  setNetworkKpiSettings,
  subscribeNetworkKpi,
  subscribeNetworkKpiPanel,
  subscribeNetworkKpiStatus,
  useIntervalPlayback,
  useManifestUrlDraft,
  useScenarioReplicationSelector,
  useViewModeToggle,
  type NetworkKpiMetric,
} from "@geolibre/plugins";
import { Button, Slider, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { BarChart3, Box, Eye, FolderOpen, Loader2, PanelBottomClose, PanelBottomOpen, Pause, Play, SkipBack, SkipForward, Square, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import {
  registerNetworkKpiLegend,
  unregisterNetworkKpiLegend,
} from "../../lib/network-kpi-legend";

const PANEL_WIDTH = 360;
const EDGE_MARGIN = 12;

/**
 * Floating panel driving the static network KPI view (Controls → Network KPI).
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
  return <NetworkKpiCard />;
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
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));
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
  } = status;
  const canLoadFolder = canLoadLocalNetworkKpiPackage();
  const ramp = KPI_RAMPS[metric];
  const hasPackage = manifestUrl != null && manifestUrl.length > 0;

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

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const card = handle.parentElement;
      const bounds = card?.parentElement?.getBoundingClientRect();
      // Measure the card's real height instead of guessing, so it can't be
      // dragged until only its header stays on-screen.
      const cardHeight = card?.getBoundingClientRect().height ?? 80;
      const maxX = Math.max(
        EDGE_MARGIN,
        (bounds?.width ?? window.innerWidth) - PANEL_WIDTH - EDGE_MARGIN,
      );
      const maxY = Math.max(
        EDGE_MARGIN,
        (bounds?.height ?? window.innerHeight) - cardHeight - EDGE_MARGIN,
      );
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), EDGE_MARGIN, maxX),
        y: clamp(origin.y + (move.clientY - startY), EDGE_MARGIN, maxY),
      });
    };
    const handleUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleUp);
      // Also clean up if the gesture is interrupted (e.g. pointercancel), so
      // the move listener and pointer capture don't leak.
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  const dataSourceContent = (
    <div className="space-y-1">
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
    </div>
  ) : null;

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.networkKpi.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <BarChart3 className="h-4 w-4 text-emerald-500" />
        <span className="text-sm font-medium">{t("toolbar.networkKpi.title")}</span>
        {featureCount > 0 && (
          <span className="ms-1 truncate text-xs tabular-nums text-muted-foreground">
            {detailed
              ? t("toolbar.networkKpi.laneCount", { count: featureCount })
              : t("toolbar.networkKpi.sectionCount", { count: featureCount })}
          </span>
        )}

        <Button variant="ghost" size="icon" className="h-6 w-6" title={collapsed ? t("toolbar.networkKpi.expand") : t("toolbar.networkKpi.collapse")} aria-label={collapsed ? t("toolbar.networkKpi.expand") : t("toolbar.networkKpi.collapse")} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.networkKpi.close")}
          onClick={() => closeNetworkKpiPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!collapsed && (
        <div className="p-3">
          {!hasPackage ? (
            dataSourceContent
          ) : (
            <Tabs defaultValue="data-source">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="data-source">{t("toolbar.networkKpi.tabs.dataSource")}</TabsTrigger>
                <TabsTrigger value="style">{t("toolbar.networkKpi.tabs.style")}</TabsTrigger>
                <TabsTrigger value="playback">{t("toolbar.networkKpi.tabs.playback")}</TabsTrigger>
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
          )}
        </div>
      )}
    </div>
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
