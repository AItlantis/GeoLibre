import {
  VEHICLE_PLAYBACK_OPACITY_MAX,
  VEHICLE_PLAYBACK_OPACITY_MIN,
  VEHICLE_PLAYBACK_SPEED_MAX,
  VEHICLE_PLAYBACK_SPEED_MIN,
  canLoadLocalVehiclePackage,
  closeVehiclePlaybackPanel,
  getVehiclePlaybackSnapshot,
  getVehiclePlaybackStatus,
  isVehiclePlaybackPanelVisible,
  loadLocalVehiclePlaybackFolder,
  setVehiclePlaybackManifestUrl,
  setVehiclePlaybackScenario,
  setVehiclePlaybackSettings,
  setVehiclePlaybackTick,
  subscribeVehiclePlayback,
  subscribeVehiclePlaybackPanel,
  subscribeVehiclePlaybackStatus,
  toggleVehiclePlaybackPlaying,
  useManifestUrlDraft,
  useTickPlayback,
} from "@geolibre/plugins";
import { Button, Slider, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { Car, Eye, FolderOpen, Loader2, PanelBottomClose, PanelBottomOpen, Pause, Play, Repeat, SkipBack, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import {
  registerVehiclePlaybackLegend,
  unregisterVehiclePlaybackLegend,
} from "../../lib/vehicle-playback-legend";

const PANEL_WIDTH = 360;
const EDGE_MARGIN = 12;

/**
 * Floating panel driving the multi-vehicle traffic playback (Controls → Vehicle
 * Playback). Renders only while open; subscribes to the plugin store so the
 * timeline tracks playback as it runs. All map work lives in the plugin's engine
 * — this component only reads and writes the shared settings, plus it owns the
 * manifest-URL input, since this plugin (unlike Sun or Route Animation) needs an
 * external data package to play.
 */
export function VehiclePlaybackPanel() {
  const visible = useSyncExternalStore(
    subscribeVehiclePlaybackPanel,
    isVehiclePlaybackPanelVisible,
    isVehiclePlaybackPanelVisible,
  );
  if (!visible) return null;
  return <VehiclePlaybackCard />;
}

function VehiclePlaybackCard() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeVehiclePlayback,
    getVehiclePlaybackSnapshot,
    getVehiclePlaybackSnapshot,
  );
  const status = useSyncExternalStore(
    subscribeVehiclePlaybackStatus,
    getVehiclePlaybackStatus,
    getVehiclePlaybackStatus,
  );
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));
  const [collapsed, setCollapsed] = useState(false);

  const {
    playing,
    speed,
    loop,
    tick,
    opacity,
    manifestUrl,
    seeThroughBuildings,
    showNetwork,
    showSections, showLanes, showTurns, showNodes,
  } = settings;
  const {
    loading,
    error,
    maxTick,
    dt,
    vehicleCount,
    loadedFraction,
    scenarios,
    scenarioIndex,
    hasSections,
    hasLanes,
    hasTurns,
    localFolderName,
  } = status;
  const hasPackage = maxTick > 0;
  const canLoadFolder = canLoadLocalVehiclePackage();
  const hasNetwork = hasSections || hasLanes || hasTurns;

  const { urlDraft, setUrlDraft, loadPackage, handleKeyDown } = useManifestUrlDraft(
    manifestUrl,
    setVehiclePlaybackManifestUrl,
  );

  const { clock, timeline } = useTickPlayback({ tick, dt, maxTick, hasPackage });

  // Vehicle playback renders outside the layer store, so the auto-legend cannot
  // see it. Publish a standalone legend section while a package is loaded and
  // this panel is open, and withdraw it as soon as either stops holding — the
  // cleanup also covers the panel being closed, which unmounts this component.
  const legendTitle = t("toolbar.vehiclePlayback.legendTitle");
  useEffect(() => {
    if (!hasPackage) {
      unregisterVehiclePlaybackLegend();
      return;
    }
    registerVehiclePlaybackLegend(legendTitle);
    return () => unregisterVehiclePlaybackLegend();
  }, [hasPackage, legendTitle]);

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input")) return;
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
        {t("toolbar.vehiclePlayback.manifestUrl")}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          placeholder={t("toolbar.vehiclePlayback.manifestPlaceholder")}
          value={urlDraft}
          aria-label={t("toolbar.vehiclePlayback.manifestUrl")}
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
            t("toolbar.vehiclePlayback.load")
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
              ? t("toolbar.vehiclePlayback.loadFolderTooltip")
              : t("toolbar.vehiclePlayback.loadFolderUnsupported")
          }
          onClick={() => void loadLocalVehiclePlaybackFolder()}
        >
          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
          {t("toolbar.vehiclePlayback.loadFolder")}
        </Button>
      </div>
      {!canLoadFolder && (
        <p className="text-xs text-muted-foreground">
          {t("toolbar.vehiclePlayback.loadFolderUnsupported")}
        </p>
      )}
      {localFolderName && (
        <p className="truncate text-xs text-muted-foreground">
          {t("toolbar.vehiclePlayback.localFolder", { name: localFolderName })}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hasPackage && loadedFraction < 1 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t("toolbar.vehiclePlayback.streaming", {
            percent: Math.round(loadedFraction * 100),
          })}
        </p>
      )}

      {/* Only a genuinely multi-scenario package gets a picker; a single
          scenario auto-selects, exactly as before. */}
      {scenarios.length > 1 && (
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">
            {t("toolbar.vehiclePlayback.scenario")}
          </span>
          <select
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            aria-label={t("toolbar.vehiclePlayback.scenario")}
            value={scenarioIndex}
            disabled={loading}
            onChange={(e) => void setVehiclePlaybackScenario(Number(e.currentTarget.value))}
          >
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.index}>
                {scenario.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );

  const styleContent = (
    <div className="space-y-3">
      <SliderRow
        label={t("toolbar.vehiclePlayback.opacity")}
        min={VEHICLE_PLAYBACK_OPACITY_MIN}
        max={VEHICLE_PLAYBACK_OPACITY_MAX}
        step={0.05}
        value={opacity}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setVehiclePlaybackSettings({ opacity: v })}
      />

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-sky-500"
          checked={seeThroughBuildings}
          onChange={(e) =>
            setVehiclePlaybackSettings({ seeThroughBuildings: e.currentTarget.checked })
          }
        />
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t("toolbar.vehiclePlayback.seeThroughBuildings")}
        </span>
      </label>

      {hasNetwork && (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-sky-500"
              checked={showNetwork}
              onChange={(e) =>
                setVehiclePlaybackSettings({ showNetwork: e.currentTarget.checked })
              }
            />
            <span className="text-muted-foreground">
              {t("toolbar.vehiclePlayback.showNetwork")}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            {([["showSections", showSections], ["showLanes", showLanes], ["showTurns", showTurns], ["showNodes", showNodes]] as const).map(([key, checked]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" disabled={!showNetwork} checked={checked} onChange={(e) => setVehiclePlaybackSettings({ [key]: e.currentTarget.checked })} />{t(`toolbar.vehiclePlayback.${key}`)}</label>)}
          </div>
          {/* Nodes ship with the COARSE ("Sections + Nodes") view, so the
              "no nodes layer, turns stand in as junctions" caveat belongs
              here rather than on the detailed lanes view. */}
        </div>
      )}
    </div>
  );

  const playbackContent = (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-lg font-semibold tabular-nums">{clock}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("toolbar.vehiclePlayback.tickOf", {
              tick: Math.round(tick),
              total: maxTick,
            })}
          </span>
        </div>
        <input
          aria-label={t("toolbar.vehiclePlayback.timeline")}
          type="range"
          min={timeline.min}
          max={timeline.max}
          step={timeline.step}
          value={timeline.value}
          disabled={timeline.disabled}
          onChange={(e) => setVehiclePlaybackTick(Number(e.currentTarget.value))}
          className="h-5 w-full cursor-ew-resize accent-sky-500 disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("toolbar.vehiclePlayback.restart")}
          disabled={!hasPackage}
          onClick={() => setVehiclePlaybackTick(0)}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="h-9 w-9"
          aria-label={
            playing ? t("toolbar.vehiclePlayback.pause") : t("toolbar.vehiclePlayback.play")
          }
          disabled={!hasPackage}
          onClick={() => toggleVehiclePlaybackPlaying()}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <span className="min-w-0 flex-1 px-2 text-xs text-muted-foreground">
          {t("toolbar.vehiclePlayback.simTimeNote")}
        </span>
        <Button
          variant={loop ? "secondary" : "ghost"}
          size="icon"
          className="h-8 w-8"
          aria-pressed={loop}
          aria-label={t("toolbar.vehiclePlayback.loop")}
          title={t("toolbar.vehiclePlayback.loop")}
          onClick={() => setVehiclePlaybackSettings({ loop: !loop })}
        >
          <Repeat className="h-4 w-4" />
        </Button>
      </div>

      <SliderRow
        label={t("toolbar.vehiclePlayback.speed")}
        min={VEHICLE_PLAYBACK_SPEED_MIN}
        max={VEHICLE_PLAYBACK_SPEED_MAX}
        step={0.25}
        value={speed}
        format={(v) => `${v}×`}
        onChange={(v) => setVehiclePlaybackSettings({ speed: v })}
      />
    </div>
  );

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.vehiclePlayback.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Car className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.vehiclePlayback.title")}</span>
        {hasPackage && (
          <span className="ms-1 truncate text-xs tabular-nums text-muted-foreground">
            {t("toolbar.vehiclePlayback.vehicleCount", { count: vehicleCount })}
          </span>
        )}
        <Button variant="ghost" size="icon" className="ms-auto h-6 w-6" title={collapsed ? t("toolbar.vehiclePlayback.expand") : t("toolbar.vehiclePlayback.collapse")} aria-label={collapsed ? t("toolbar.vehiclePlayback.expand") : t("toolbar.vehiclePlayback.collapse")} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.vehiclePlayback.close")}
          onClick={() => closeVehiclePlaybackPanel()}
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
                <TabsTrigger value="data-source">{t("toolbar.vehiclePlayback.tabs.dataSource")}</TabsTrigger>
                <TabsTrigger value="style">{t("toolbar.vehiclePlayback.tabs.style")}</TabsTrigger>
                <TabsTrigger value="playback">{t("toolbar.vehiclePlayback.tabs.playback")}</TabsTrigger>
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
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderRow({ label, min, max, step, value, format, onChange }: SliderRowProps) {
  return (
    <div className="space-y-1">
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
        onValueChange={([v]: number[]) => onChange(v ?? value)}
      />
    </div>
  );
}
