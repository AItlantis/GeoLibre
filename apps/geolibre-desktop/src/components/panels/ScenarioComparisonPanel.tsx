import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Box, Eye, FolderOpen, PanelBottomClose, PanelBottomOpen, Square, X } from "lucide-react";
import {
  canLoadLocalScenarioComparisonPackage,
  closeScenarioComparisonPanel,
  comparisonCategoricalRamp,
  SCENARIO_COMPARISON_CONTINUOUS_RAMPS,
  getScenarioComparisonSnapshot,
  getScenarioComparisonStatus,
  isScenarioComparisonPanelVisible,
  loadLocalScenarioComparisonFolder,
  setScenarioComparisonManifestUrl,
  setScenarioComparisonSettings,
  stepScenarioComparisonInterval,
  subscribeScenarioComparison,
  subscribeScenarioComparisonStatus,
  toggleScenarioComparisonIntervalPlaying,
  useIntervalPlayback,
  useManifestUrlDraft,
  useScenarioReplicationSelector,
  useViewModeToggle,
} from "@geolibre/plugins";

export function ScenarioComparisonPanel() {
  const { t } = useTranslation();
  const open = useSyncExternalStore(subscribeScenarioComparison, isScenarioComparisonPanelVisible, isScenarioComparisonPanelVisible);
  const s = useSyncExternalStore(subscribeScenarioComparison, getScenarioComparisonSnapshot, getScenarioComparisonSnapshot);
  const status = useSyncExternalStore(subscribeScenarioComparisonStatus, getScenarioComparisonStatus, getScenarioComparisonStatus);
  const [collapsed, setCollapsed] = useState(false);
  if (!open) return null;

  const hasPackage = s.manifestUrl != null && s.manifestUrl.length > 0;

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
      if (s.manifestUrl) void setScenarioComparisonManifestUrl(s.manifestUrl);
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
      if (s.manifestUrl) void setScenarioComparisonManifestUrl(s.manifestUrl);
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
  const continuous = SCENARIO_COMPARISON_CONTINUOUS_RAMPS[s.metric as "flow_delta" | "flow_density_product_delta"];

  const sideSelectors = (["A", "B"] as const).map((side) => {
    const sel = side === "A" ? sideA : sideB;
    return (
      <div key={side} className="space-y-2">
        <label className="block text-xs">
          {t(`toolbar.scenarioComparison.scenario${side}`)}
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
          {t(`toolbar.scenarioComparison.replication${side}`)}
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
      <div className="flex gap-2">
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
    </div>
  );

  const styleContent = (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-xs">{t("toolbar.scenarioComparison.mode")}</span>
        <div className="flex items-center gap-1.5">
          <Button variant={s.mode === "diff" ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={s.mode === "diff"} onClick={() => setScenarioComparisonSettings({ mode: "diff" })}>{t("toolbar.scenarioComparison.diff")}</Button>
          <Button variant={s.mode === "side-by-side" ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 text-xs" aria-pressed={s.mode === "side-by-side"} onClick={() => setScenarioComparisonSettings({ mode: "side-by-side" })}>{t("toolbar.scenarioComparison.sideBySide")}</Button>
        </div>
      </div>
      {s.mode === "diff" && (
        <>
          <label className="block text-xs">
            {t("toolbar.scenarioComparison.metric")}
            <select className="h-8 w-full rounded border bg-transparent text-foreground" value={s.metric} onChange={(e) => setScenarioComparisonSettings({ metric: e.currentTarget.value as typeof s.metric })}>
              {(["flow_delta", "flow_density_product_delta", "cmp_flow_sign", "cmp_flow_density_quadrant"] as const).map((m) => (
                <option className="bg-background text-foreground" key={m} value={m}>
                  {t(`toolbar.scenarioComparison.metrics.${m}`)}
                </option>
              ))}
            </select>
          </label>
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
          {/* The height ceiling only means anything while extruded, so it is
              disabled rather than hidden, matching Network KPI / Emissions H3. */}
          <label className="block text-xs">
            {t("toolbar.scenarioComparison.height")}
            <input
              className="w-full"
              type="range"
              min={1}
              max={200}
              value={viewMode.heightSlider.value}
              disabled={viewMode.heightSlider.disabled}
              onChange={(e) => viewMode.setMaxHeight(Number(e.currentTarget.value))}
            />
          </label>
        </>
      )}
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

  const playbackContent = (
    <div className="space-y-1">
      <span className="text-xs">{t("toolbar.scenarioComparison.interval")}</span>
      <input
        className="w-full"
        type="range"
        min={0}
        max={Math.max(0, intervalPlayback.realIntervals.length - 1)}
        value={intervalPlayback.scrubberIndex}
        onChange={(e) => intervalPlayback.setScrubberIndex(Number(e.currentTarget.value))}
      />
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => intervalPlayback.step(-1)}>{t("toolbar.scenarioComparison.previous")}</Button>
        <Button variant="secondary" onClick={intervalPlayback.togglePlaying}>{s.intervalPlaying ? t("toolbar.scenarioComparison.pause") : t("toolbar.scenarioComparison.play")}</Button>
        <Button variant="ghost" onClick={() => intervalPlayback.step(1)}>{t("toolbar.scenarioComparison.next")}</Button>
      </div>
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
          {!hasPackage ? (
            dataSourceContent
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
