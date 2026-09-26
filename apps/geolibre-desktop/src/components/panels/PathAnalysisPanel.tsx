import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@geolibre/ui";
import { FolderOpen, Loader2, X, Square, Box, Eye, PanelBottomClose, PanelBottomOpen, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  PATH_RAMPS,
  canLoadLocalPathAnalysisPackage,
  clearPathAnalysisSelection,
  closePathAnalysisPanel,
  getPathAnalysisSnapshot,
  isPathAnalysisPanelVisible,
  loadLocalPathAnalysisFolder,
  removePathAnalysisSection,
  setPathAnalysisManifestUrl,
  setPathAnalysisSettings,
  stepPathAnalysisInterval,
  togglePathAnalysisIntervalPlaying,
  applyPathAnalysisVisualSettings,
  subscribePathAnalysis,
  subscribePathAnalysisPanel,
  useManifestUrlDraft,
  useViewModeToggle,
  useIntervalPlayback,
} from "@geolibre/plugins";
export function PathAnalysisPanel() {
  const v = useSyncExternalStore(subscribePathAnalysisPanel, isPathAnalysisPanelVisible, isPathAnalysisPanelVisible);
  return v ? <Card /> : null;
}
function Card() {
  const { t } = useTranslation();
  const s = useSyncExternalStore(subscribePathAnalysis, getPathAnalysisSnapshot, getPathAnalysisSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const ramp = PATH_RAMPS[s.settings.metric];
  // Local folder loads intentionally keep manifestUrl null; a populated path
  // summary still means the package is loaded and should expose Style.
  const hasPackage = (s.settings.manifestUrl != null && s.settings.manifestUrl.length > 0) || s.summary != null;

  const { urlDraft, setUrlDraft, loadPackage, handleKeyDown } = useManifestUrlDraft(
    s.settings.manifestUrl,
    setPathAnalysisManifestUrl,
  );

  // Path Analysis renders no height slider (it never has, unlike Network KPI
  // / Emissions H3) — the hook is still used for the flat/extruded toggle
  // itself so the convention (and its `disabled not hidden` height-slider
  // props, unused here) stays consistent across panels.
  const viewMode = useViewModeToggle({
    extruded: s.settings.extruded,
    maxHeightM: 20,
    heightMin: 1,
    heightMax: 200,
    onExtrudedChange: (extruded) => setPathAnalysisSettings({ extruded }),
    onMaxHeightChange: () => {},
  });

  // The matched-path LIST used to render one row per route here — unusable once
  // an APA carries thousands of paths through a busy section. Selection results
  // now live entirely on the map (color/height/labels via the same ramp shown
  // below), and this panel only ever shows an aggregate count/total, matching
  // how network-kpi keeps its per-feature values off-panel too.
  const matchCount = s.matches.length;
  const intervalPlayback = useIntervalPlayback({ intervals: s.intervals ?? [], interval: s.settings.interval ?? 0, onIntervalChange: (interval) => setPathAnalysisSettings({ interval }), onStep: stepPathAnalysisInterval, onTogglePlaying: togglePathAnalysisIntervalPlaying });
  const playbackContent = intervalPlayback.hasRealIntervals ? <div className="space-y-2"><span className="block text-xs text-muted-foreground">Interval playback</span><input className="h-5 w-full accent-sky-500" type="range" min={0} max={intervalPlayback.realIntervals.length - 1} value={intervalPlayback.scrubberIndex} disabled={intervalPlayback.isAggregate} onChange={(e) => intervalPlayback.setScrubberIndex(Number(e.currentTarget.value))} /><div className="flex items-center gap-1.5"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => intervalPlayback.step(-1)}><SkipBack className="h-4 w-4" /></Button><Button variant="secondary" size="icon" className="h-9 w-9" onClick={intervalPlayback.togglePlaying}>{s.settings.intervalPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => intervalPlayback.step(1)}><SkipForward className="h-4 w-4" /></Button><label className="ms-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={intervalPlayback.isAggregate} onChange={(e) => { intervalPlayback.setAggregate(e.currentTarget.checked); if (e.currentTarget.checked) setPathAnalysisSettings({ intervalPlaying: false }); }} />Whole period</label></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><label className="flex-1">Speed <input className="w-20 accent-sky-500" type="range" min="0.25" max="8" step="0.25" value={s.settings.playbackSpeed ?? 1} onChange={(e) => setPathAnalysisSettings({ playbackSpeed: Number(e.currentTarget.value) })} /></label><span>{s.settings.playbackSpeed ?? 1}×</span><label className="flex items-center gap-1"><input type="checkbox" checked={s.settings.loop ?? true} onChange={(e) => setPathAnalysisSettings({ loop: e.currentTarget.checked })} />Loop</label></div></div> : null;

  const dataSourceContent = (
    <div className="space-y-3">
      <div hidden={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo"} className="flex gap-2">
        <input className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm" placeholder={t("toolbar.pathAnalysis.manifestPlaceholder")} value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} onKeyDown={handleKeyDown} />
        <Button size="sm" className="h-8" disabled={!urlDraft.trim() || s.loading} onClick={loadPackage}>{s.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("toolbar.pathAnalysis.load")}</Button>
      </div>
      {s.loading && <p className="text-xs text-muted-foreground">{t("toolbar.pathAnalysis.loading")}</p>}
      <p className="text-xs text-muted-foreground">{t("toolbar.pathAnalysis.clickHint")}</p>
      <Button hidden={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo"} variant="outline" size="sm" className="w-full" disabled={!canLoadLocalPathAnalysisPackage()} onClick={() => void loadLocalPathAnalysisFolder()}><FolderOpen className="me-1.5 h-3.5 w-3.5" />{t("toolbar.pathAnalysis.loadFolder")}</Button>
      {s.error && <p className="text-xs text-red-600">{s.error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {s.selectedSections.map((id) => (
          <span key={id} className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs">
            {id}
            <button type="button" className="opacity-60 hover:opacity-100" aria-label={t("toolbar.pathAnalysis.removeSection", { id })} onClick={() => removePathAnalysisSection(id)}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {s.selectedSections.length > 0 && <Button variant="ghost" size="sm" onClick={clearPathAnalysisSelection}>{t("toolbar.pathAnalysis.clear")}</Button>}
      </div>
      {s.summary && <div className="text-xs text-muted-foreground">{t("toolbar.pathAnalysis.summary", { paths: s.summary.path_count ?? 0, sections: s.summary.unique_sections_count ?? 0, demand: Number(s.summary.total_demand ?? 0).toFixed(0) })}</div>}
    </div>
  );

  const styleContent = (
    <div className="space-y-3">
      <div className="rounded-md border border-border p-2 text-xs">
        <div className="mb-1 font-medium">Selected sections</div>
        {s.selectedSections.length === 0 ? (
          <span className="text-muted-foreground">Click a section on the map to select it.</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {s.selectedSections.map((id) => (
              <button key={id} type="button" className="rounded bg-muted px-2 py-1 hover:bg-accent" onClick={() => removePathAnalysisSection(id)}>
                {id === s.selectedSection && s.selectedSectionName ? `${s.selectedSectionName} (${id})` : id} ×
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant={s.settings.rule === "or" ? "secondary" : "ghost"} onClick={() => setPathAnalysisSettings({ rule: "or" })}>{t("toolbar.pathAnalysis.or")}</Button>
        <Button size="sm" variant={s.settings.rule === "and" ? "secondary" : "ghost"} onClick={() => setPathAnalysisSettings({ rule: "and" })}>{t("toolbar.pathAnalysis.and")}</Button>
        <Button size="sm" variant={!viewMode.extruded ? "secondary" : "ghost"} onClick={viewMode.setFlat}><Square className="me-1 h-3 w-3" />{t("toolbar.pathAnalysis.flat")}</Button>
        <Button size="sm" variant={viewMode.extruded ? "secondary" : "ghost"} onClick={viewMode.setExtruded}><Box className="me-1 h-3 w-3" />{t("toolbar.pathAnalysis.extruded")}</Button>
      </div>
      <div className="flex gap-1.5">
        {(["percentage", "trips"] as const).map((m) => (
          <Button key={m} size="sm" variant={s.settings.metric === m ? "secondary" : "ghost"} onClick={() => setPathAnalysisSettings({ metric: m })}>{t(`toolbar.pathAnalysis.metric.${m}`)}</Button>
        ))}
      </div>
      <div className="space-y-1.5">
        <span className="block text-xs text-muted-foreground">{t("toolbar.pathAnalysis.viewMode", { defaultValue: "View mode" })}</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant={s.settings.displayMode === "section-volumes" ? "secondary" : "ghost"} onClick={() => setPathAnalysisSettings({ displayMode: "section-volumes" })}>{t("toolbar.pathAnalysis.sectionVolumes", { defaultValue: "Section volumes" })}</Button>
          <Button size="sm" variant={s.settings.displayMode === "origin-destination" ? "secondary" : "ghost"} onClick={() => setPathAnalysisSettings({ displayMode: "origin-destination" })}>{t("toolbar.pathAnalysis.originDestination", { defaultValue: "Origin–Destination" })}</Button>
        </div>
      </div>
      <label className="grid gap-1 text-xs">
        <span className="flex justify-between"><span>Label size</span><span>{s.settings.labelSize}px</span></span>
        <input type="range" min="8" max="24" step="1" value={s.settings.labelSize} onChange={(e) => { const labelSize = Number(e.currentTarget.value); setPathAnalysisSettings({ labelSize }); applyPathAnalysisVisualSettings({ labelSize, visible: s.settings.visible }); }} />
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" checked={s.settings.visible} onChange={(e) => { const visible = e.currentTarget.checked; setPathAnalysisSettings({ visible }); applyPathAnalysisVisualSettings({ labelSize: s.settings.labelSize, visible }); }} />
        <span>Show path analysis layer</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={s.settings.seeThroughBuildings}
          onChange={(e) =>
            setPathAnalysisSettings({ seeThroughBuildings: e.currentTarget.checked })
          }
        />
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t("toolbar.pathAnalysis.seeThroughBuildings")}
        </span>
      </label>
      {s.settings.displayMode === "origin-destination" ? (
        <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-blue-600" />Upstream</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-red-500" />Selected</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-green-600" />Downstream</span>
          <span className="col-span-3">Color strength represents each section’s share of the selected volume.</span>
        </div>
      ) : <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t("toolbar.pathAnalysis.legend")}</span>
          <span className="text-muted-foreground">{ramp.unit}</span>
        </div>
        <div className="h-3 w-full rounded-sm border border-border" style={{ background: `linear-gradient(to right, ${ramp.colors.join(", ")})` }} />
        <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
          {ramp.stops.map((stop) => <span key={stop}>{stop}</span>)}
        </div>
      </div>}
    </div>
  );

  return (
    <div className="absolute left-3 top-3 z-30 w-[360px] rounded-lg border border-border map-glass shadow-lg" role="dialog">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{t("toolbar.pathAnalysis.title")}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" title={collapsed ? t("toolbar.pathAnalysis.expand") : t("toolbar.pathAnalysis.collapse")} aria-label={collapsed ? t("toolbar.pathAnalysis.expand") : t("toolbar.pathAnalysis.collapse")} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <PanelBottomOpen className="h-3.5 w-3.5" /> : <PanelBottomClose className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="ms-auto h-6 w-6" onClick={() => closePathAnalysisPanel()}><X className="h-3.5 w-3.5" /></Button>
      </div>
      {!collapsed && (
        <div className="p-3">
          {s.selectionLoading && <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("toolbar.pathAnalysis.loadingSelection", { defaultValue: "Loading paths through selected section…" })}</div>}
          {s.selectionError && <p className="mb-2 text-xs text-red-600">{s.selectionError}</p>}
          {s.selectedSection != null && !s.selectionLoading && (s.sectionVolumes.length > 0
            ? <div className="mb-2 text-xs text-muted-foreground">{s.selectedSectionName ? `${s.selectedSectionName} (${s.selectedSection})` : `Section ${s.selectedSection}`} · {t("toolbar.pathAnalysis.matchSummary", { count: matchCount, trips: s.selectedVolume.toFixed(0) })} · {new Set(s.sectionVolumes.map((item) => item.section_id)).size} sections · selected section 100%</div>
            : <div className="mb-2 text-xs text-muted-foreground">No paths found through {s.selectedSectionName ? `${s.selectedSectionName} (${s.selectedSection})` : `section ${s.selectedSection}`} for this interval and selection.</div>)}
          {!hasPackage ? (
            dataSourceContent
          ) : (
            <Tabs defaultValue="data-source">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="data-source">{t("toolbar.pathAnalysis.tabs.dataSource")}</TabsTrigger>
                <TabsTrigger value="style">{t("toolbar.pathAnalysis.tabs.style")}</TabsTrigger>
                <TabsTrigger value="playback">Playback</TabsTrigger>
              </TabsList>
              <TabsContent value="data-source" className="space-y-3">
                {dataSourceContent}
              </TabsContent>
              <TabsContent value="style" className="space-y-3">
                {styleContent}
              </TabsContent>
              <TabsContent value="playback" className="space-y-3">
                {playbackContent ?? <p className="text-xs text-muted-foreground">No interval data is available.</p>}
              </TabsContent>
            </Tabs>
          )}
        </div>
      )}
    </div>
  );
}
