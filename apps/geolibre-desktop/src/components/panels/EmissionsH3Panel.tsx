import {
  closeEmissionsH3Panel,
  EMISSIONS_H3_METRICS,
  EMISSIONS_H3_RAMPS,
  EMISSIONS_H3_RESOLUTION_MAX,
  EMISSIONS_H3_RESOLUTION_MIN,
  getEmissionsH3Snapshot,
  getEmissionsH3Status,
  isEmissionsH3PanelVisible,
  loadLocalEmissionsH3Folder,
  setEmissionsH3ManifestUrl,
  setEmissionsH3Scenario,
  setEmissionsH3Settings,
  stepEmissionsH3Interval,
  subscribeEmissionsH3,
  subscribeEmissionsH3Panel,
  subscribeEmissionsH3Status,
  toggleEmissionsH3IntervalPlaying,
  useIntervalPlayback,
  useManifestUrlDraft,
  useScenarioReplicationSelector,
  useViewModeToggle,
  type EmissionsH3Metric,
} from "@geolibre/plugins";
import { Button, Slider, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import {
  Box,
  Eye,
  FolderOpen,
  Loader2,
  PanelBottomClose,
  PanelBottomOpen,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Wind,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { PlaybackTimelineReadout, intervalCurrentSeconds } from "./PlaybackTimelineReadout";

const PANEL_WIDTH = 360;
const EDGE_MARGIN = 12;

/** One button per metric, `noise` first since it needs no results columns. */
const METRIC_ORDER: EmissionsH3Metric[] = ["noise", "co2", "nox"];

/**
 * Floating panel driving the H3 emissions/noise grid (Controls → Emissions H3).
 *
 * Same manifest/scenario/replication shape as Network KPI, aggregated onto an
 * H3 hex grid instead of drawn per-road. Renders only while open and
 * subscribes to the plugin store; all map work lives in the plugin's engine,
 * so this component only reads and writes the shared settings plus it owns
 * the manifest-URL input.
 */
export function EmissionsH3Panel() {
  const visible = useSyncExternalStore(
    subscribeEmissionsH3Panel,
    isEmissionsH3PanelVisible,
    isEmissionsH3PanelVisible,
  );
  if (!visible) return null;
  return <EmissionsH3Card />;
}

function EmissionsH3Card() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeEmissionsH3,
    getEmissionsH3Snapshot,
    getEmissionsH3Snapshot,
  );
  const status = useSyncExternalStore(
    subscribeEmissionsH3Status,
    getEmissionsH3Status,
    getEmissionsH3Status,
  );
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));
  const [collapsed, setCollapsed] = useState(false);

  const {
    manifestUrl,
    metric,
    resolution,
    extruded,
    maxHeightM,
    opacity,
    interval,
    intervalPlaying,
    seeThroughBuildings,
  } =
    settings;
  const { loading, error, intervals, scenarios, scenarioIndex, replications, did, localFolderName, hasResults, hasEmissions, timeline } =
    status;
  const ramp = EMISSIONS_H3_RAMPS[metric];
  // A local folder has no URL, and a valid manifest can still have no
  // microscopic emissions columns. Both cases are loaded package states: keep
  // the Style/Playback tabs visible while the Data Source tab reports the
  // package limitation.
  const hasPackage =
    (manifestUrl != null && manifestUrl.length > 0) || localFolderName != null;

  const { urlDraft, setUrlDraft, loadPackage, handleKeyDown } = useManifestUrlDraft(
    manifestUrl,
    setEmissionsH3ManifestUrl,
  );

  const scenarioReplication = useScenarioReplicationSelector({
    scenarios,
    scenarioIndex,
    replications,
    selectedDid: did,
    onScenarioChange: (index) => void setEmissionsH3Scenario(index),
    onReplicationChange: (nextDid) => setEmissionsH3Settings({ did: nextDid }),
  });

  const intervalPlayback = useIntervalPlayback({
    intervals,
    interval,
    onIntervalChange: (nextInterval) => setEmissionsH3Settings({ interval: nextInterval }),
    onStep: (direction) => stepEmissionsH3Interval(direction),
    onTogglePlaying: toggleEmissionsH3IntervalPlaying,
  });

  const viewMode = useViewModeToggle({
    extruded,
    maxHeightM,
    heightMin: 10,
    heightMax: 500,
    onExtrudedChange: (nextExtruded) => setEmissionsH3Settings({ extruded: nextExtruded }),
    onMaxHeightChange: (value) => setEmissionsH3Settings({ maxHeightM: value }),
  });

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
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  const dataSourceContent = (
    <div className="space-y-2">
      <div hidden={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo"} className="space-y-1">
        <span className="block text-xs text-muted-foreground">
          {t("toolbar.emissionsH3.manifestUrl")}
        </span>
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
            placeholder={t("toolbar.emissionsH3.manifestPlaceholder")}
            value={urlDraft}
            aria-label={t("toolbar.emissionsH3.manifestUrl")}
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
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("toolbar.emissionsH3.load")}
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full"
          disabled={loading}
          title={t("toolbar.emissionsH3.loadFolderTooltip")}
          onClick={() => void loadLocalEmissionsH3Folder()}
        >
          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.emissionsH3.loadFolder")}
        </Button>
        {localFolderName && (
          <p className="truncate text-xs text-muted-foreground">
            {t("toolbar.emissionsH3.localFolder", { name: localFolderName })}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {/* Only a genuinely multi-scenario package gets a picker; a
          single scenario auto-selects. */}
      {scenarioReplication.showScenarioPicker && (
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">
            {t("toolbar.emissionsH3.scenario")}
          </span>
          <select
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            aria-label={t("toolbar.emissionsH3.scenario")}
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
            {t("toolbar.emissionsH3.replication")}
          </span>
          <select
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            aria-label={t("toolbar.emissionsH3.replication")}
            value={scenarioReplication.effectiveDid}
            disabled={loading}
            onChange={(e) => scenarioReplication.onReplicationChange(Number(e.currentTarget.value))}
          >
            {scenarioReplication.replications.map((replication) => (
              <option key={replication.did} value={replication.did}>
                {replication.didname ?? t("toolbar.emissionsH3.replicationFallback", { did: replication.did })}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );

  const styleContent = (
    <div className="space-y-2">
      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">
          {t("toolbar.emissionsH3.metricLabel")}
        </span>
        <div className="flex items-center gap-1.5">
          {METRIC_ORDER.filter((key) => EMISSIONS_H3_METRICS.includes(key)).map((key) => (
            <Button
              key={key}
              variant={metric === key ? "secondary" : "ghost"}
              size="sm"
              className="h-7 flex-1 text-xs"
              aria-pressed={metric === key}
              onClick={() => setEmissionsH3Settings({ metric: key })}
            >
              {t(`toolbar.emissionsH3.metric.${key}`)}
            </Button>
          ))}
        </div>
        {hasResults && !hasEmissions && (metric === "co2" || metric === "nox") && (
          <p className="text-xs text-amber-600">{t("toolbar.emissionsH3.noEmissionsColumns")}</p>
        )}
      </div>

      {/* Free-form resolution input: any valid H3 resolution in the
          plugin's supported band, not just a fixed preset list. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t("toolbar.emissionsH3.resolution")}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={EMISSIONS_H3_RESOLUTION_MIN}
            max={EMISSIONS_H3_RESOLUTION_MAX}
            step={1}
            value={resolution}
            aria-label={t("toolbar.emissionsH3.resolution")}
            className="h-7 w-16 rounded-md border border-input bg-transparent px-2 text-right text-xs tabular-nums"
            onChange={(e) => {
              const parsed = Number(e.currentTarget.value);
              if (Number.isFinite(parsed)) setEmissionsH3Settings({ resolution: parsed });
            }}
          />
        </div>
        <Slider
          aria-label={t("toolbar.emissionsH3.resolution")}
          min={EMISSIONS_H3_RESOLUTION_MIN}
          max={EMISSIONS_H3_RESOLUTION_MAX}
          step={1}
          value={[resolution]}
          onValueChange={([v]: number[]) => {
            if (v !== undefined) setEmissionsH3Settings({ resolution: v });
          }}
        />
        <p className="text-[11px] text-muted-foreground">{t("toolbar.emissionsH3.resolutionHelp")}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant={!viewMode.extruded ? "secondary" : "ghost"}
          size="sm"
          className="h-7 flex-1 text-xs"
          aria-pressed={!viewMode.extruded}
          onClick={viewMode.setFlat}
        >
          <Square className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.emissionsH3.flat")}
        </Button>
        <Button
          variant={viewMode.extruded ? "secondary" : "ghost"}
          size="sm"
          className="h-7 flex-1 text-xs"
          aria-pressed={viewMode.extruded}
          onClick={viewMode.setExtruded}
        >
          <Box className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.emissionsH3.extruded")}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><label className="flex-1">Speed <input className="w-20 accent-sky-500" type="range" min="0.25" max="8" step="0.25" value={settings.playbackSpeed} onChange={(e) => setEmissionsH3Settings({ playbackSpeed: Number(e.currentTarget.value) })} /></label><span>{settings.playbackSpeed}×</span><label className="flex items-center gap-1"><input type="checkbox" checked={settings.loop} onChange={(e) => setEmissionsH3Settings({ loop: e.currentTarget.checked })} />Loop</label></div>
      {/* The height ceiling only means anything while extruded, so it
          is disabled rather than hidden — hiding it would make the
          flat/extruded toggle reflow the card under the pointer. */}
      <SliderRow
        label={t("toolbar.emissionsH3.maxHeight")}
        min={10}
        max={500}
        step={10}
        value={viewMode.heightSlider.value}
        disabled={viewMode.heightSlider.disabled}
        format={(v) => `${Math.round(v)} m`}
        onChange={viewMode.setMaxHeight}
      />
      <SliderRow
        label={t("toolbar.emissionsH3.opacity")}
        min={0.1}
        max={1}
        step={0.05}
        value={opacity}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setEmissionsH3Settings({ opacity: v })}
      />

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={seeThroughBuildings}
          onChange={(e) =>
            setEmissionsH3Settings({ seeThroughBuildings: e.currentTarget.checked })
          }
        />
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t("toolbar.emissionsH3.seeThroughBuildings")}
        </span>
      </label>

      {/* The ramp is continuous; the four stops are its interpolation
          anchors, so the gradient bar shows the real ramp and the
          labels locate the anchors along it. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t("toolbar.emissionsH3.legend")}</span>
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
        {t("toolbar.emissionsH3.interval")}
      </span>
      <input
        type="range"
        min={0}
        max={intervalPlayback.realIntervals.length - 1}
        value={intervalPlayback.scrubberIndex}
        className="h-5 w-full cursor-ew-resize accent-sky-500 disabled:opacity-50"
        disabled={loading || intervalPlayback.isAggregate}
        aria-label={t("toolbar.emissionsH3.interval")}
        onChange={(e) => intervalPlayback.setScrubberIndex(Number(e.currentTarget.value))}
      />
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("toolbar.emissionsH3.intervalPrevious")}
          onClick={() => intervalPlayback.step(-1)}
          disabled={loading}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="h-9 w-9"
          aria-label={
            intervalPlaying ? t("toolbar.emissionsH3.intervalPause") : t("toolbar.emissionsH3.intervalPlay")
          }
          onClick={intervalPlayback.togglePlaying}
          disabled={loading}
        >
          {intervalPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("toolbar.emissionsH3.intervalNext")}
          onClick={() => intervalPlayback.step(1)}
          disabled={loading}
        >
          <SkipForward className="h-4 w-4" />
        </Button>
        <label className="ms-auto flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={intervalPlayback.isAggregate}
            onChange={(e) => intervalPlayback.setAggregate(e.currentTarget.checked)}
          />
          {t("toolbar.emissionsH3.intervalAggregateToggle")}
        </label>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.emissionsH3.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Wind className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.emissionsH3.title")}</span>

        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          title={collapsed ? t("toolbar.emissionsH3.expand") : t("toolbar.emissionsH3.collapse")}
          aria-label={collapsed ? t("toolbar.emissionsH3.expand") : t("toolbar.emissionsH3.collapse")}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.emissionsH3.close")}
          onClick={() => closeEmissionsH3Panel()}
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
                <TabsTrigger value="data-source">{t("toolbar.emissionsH3.tabs.dataSource")}</TabsTrigger>
                <TabsTrigger value="style">{t("toolbar.emissionsH3.tabs.styleAndMetric")}</TabsTrigger>
                <TabsTrigger value="playback">{t("toolbar.emissionsH3.tabs.playback")}</TabsTrigger>
              </TabsList>
              <TabsContent value="data-source" className="space-y-2">
                {dataSourceContent}
              </TabsContent>
              <TabsContent value="style" className="space-y-2">
                {styleContent}
              </TabsContent>
              <TabsContent value="playback" className="space-y-2">
                {playbackContent}
              </TabsContent>
            </Tabs>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t("toolbar.emissionsH3.help")}</p>
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

function SliderRow({ label, min, max, step, value, disabled, format, onChange }: SliderRowProps) {
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
