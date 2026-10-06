/*
 * Port of GeoLibre modelling-plugins/geolibre-plugin rendering-outputs.
 * Origin: base commit 92f105dfd0484f6ca69c7edce098b1be080d8cc4, validated
 * against GeoLibre v2.5.0. The source classic-script window bridge is replaced
 * here by an ESM package-generation service. Network rendering stays package
 * scoped and is intentionally independent from simulation mode providers.
 */
import type { Feature, FeatureCollection, Position } from "geojson";
import type { TestudoFeatureContext, TestudoPackageProgress, TestudoMapHandle } from "../../shared/testudo-feature-session";
import { declaredDefaultCamera, networkBounds } from "../testudo-camera";
import { parseTestudoPackageStructure } from "../testudo-package-data";
import { RENDERING_OUTPUTS_LOCAL_IDS } from "../../testudo-layer-ownership";
import { turnRibbonFeatureCollection } from "./rendering-outputs-turns";


type Json = Record<string, unknown>;
type OwnedMap = TestudoMapHandle & {
  setPaintProperty?(id: string, key: string, value: unknown): void;
  getZoom?(): number;
};
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const collection = (value: unknown): FeatureCollection | null => {
  const data = object(value);
  return data.type === "FeatureCollection" && Array.isArray(data.features) ? data as unknown as FeatureCollection : null;
};
async function decode(bytes: ArrayBuffer, path: string): Promise<FeatureCollection | null> {
  if (path.endsWith(".gz")) {
    if (typeof DecompressionStream === "undefined") throw new Error("Compressed geometry requires browser gzip support.");
    bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  return collection(JSON.parse(new TextDecoder().decode(bytes)));
}
const METERS_PER_DEGREE = 111319.49079327358;
const MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 156543.03392804097;
function laneRibbon(feature: Feature, zoom: number): Feature | null {
  const geometry = feature.geometry;
  if (!geometry || (geometry.type !== "LineString" && geometry.type !== "MultiLineString")) return null;
  const props = object(feature.properties);
  const width = [props.width, props.lane_width].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0) as number | undefined ?? 3;
  const lines = geometry.type === "LineString" ? [geometry.coordinates as Position[]] : geometry.coordinates as Position[][];
  const polygons: Position[][][] = [];
  for (const coords of lines) for (let i = 0; i + 1 < coords.length; i += 1) {
      const a = coords[i]!; const b = coords[i + 1]!;
      const latitude = (a[1]! + b[1]!) / 2;
      const metersPerLon = METERS_PER_DEGREE * Math.max(Math.cos(latitude * Math.PI / 180), 1e-6);
      const dx = (b[0]! - a[0]!) * metersPerLon; const dy = (b[1]! - a[1]!) * METERS_PER_DEGREE;
      const length = Math.hypot(dx, dy); if (!length) continue;
      const metersPerPixel = MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 * Math.max(Math.cos(latitude * Math.PI / 180), 1e-6) / 2 ** (Number.isFinite(zoom) ? zoom : 15);
      const halfWidth = Math.max(width, 2 * metersPerPixel) / 2;
      const ox = -dy / length * halfWidth / metersPerLon; const oy = dx / length * halfWidth / METERS_PER_DEGREE;
      polygons.push([[[a[0]! + ox, a[1]! + oy], [b[0]! + ox, b[1]! + oy], [b[0]! - ox, b[1]! - oy], [a[0]! - ox, a[1]! - oy], [a[0]! + ox, a[1]! + oy]]]);
  }
  return polygons.length ? { type: "Feature", id: feature.id, properties: feature.properties, geometry: { type: "MultiPolygon", coordinates: polygons } } : null;
}
function fc(features: Feature[]): FeatureCollection { return { type: "FeatureCollection", features }; }

export interface RenderingOutputsService {
  readonly ownedIds: readonly string[];
  readonly available: boolean;
  readonly hasLanes: boolean;
  readonly hasSections: boolean;
  readonly showLanes: boolean;
  readonly showSections: boolean;
  setGeometry(geometry: "lanes" | "sections", visible: boolean): { showLanes: boolean; showSections: boolean };
  setLegend(visible: boolean): boolean;
  dispose(): void;
}

/** Mounts the source renderer exactly once for one TView package generation. */
export async function mountRenderingOutputs(options: {
  map: TestudoMapHandle | null;
  context: TestudoFeatureContext;
  manifest: Json;
  packageInfo: Json;
  fetchArtifact(ref: string): Promise<ArrayBuffer>;
  onProgress(progress: TestudoPackageProgress): void;
  cameraWasOverridden(): boolean;
}): Promise<RenderingOutputsService> {
  const { map: rawMap, context } = options;
  if (!rawMap) return emptyService();
  const map = rawMap as OwnedMap;
  const namespace = `testudo-${context.tviewId}-${context.generation}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const namespaceToken = namespace.replace(/^testudo-/, "");
  const id = (local: string) => local.replace("rendering-outputs.", `rendering-outputs.${namespaceToken}.`);
  const ids = RENDERING_OUTPUTS_LOCAL_IDS.map(id);
  const layerIds = new Set<string>(); const sourceIds = new Set<string>();
  const root = map.getContainer?.();
  let disposed = false; let showLanes = false; let showSections = true;
  let mapRenderFailed = false; let geometryFailed = false;
  let sections: FeatureCollection | null = null; let lanes: FeatureCollection | null = null;
  let laneData: FeatureCollection = fc([]);
  let styleElement: HTMLLinkElement | null = null;
  let dialog: HTMLDialogElement | null = null; let control: HTMLButtonElement | null = null; let controlRoot: HTMLDivElement | null = null;
  let status: HTMLElement | null = null; let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  let bounds: ReturnType<typeof networkBounds> = null;
  let cameraOverridden = false;
  const onMoveStart = (event?: { originalEvent?: unknown }) => { if (event?.originalEvent) cameraOverridden = true; };
  map.on?.("movestart", onMoveStart);
  const layerEvents = map as OwnedMap & {
    on?(type: string, layer: string, listener: (event: { features?: Feature[] }) => void): void;
    off?(type: string, layer: string, listener: (event: { features?: Feature[] }) => void): void;
  };
  const zoomEvents = map as OwnedMap & { on?(type: string, listener: () => void): void; off?(type: string, listener: () => void): void };
  let automaticLod = true;
  const onSelect = (event: { features?: Feature[] }) => {
    const feature = event.features?.[0]; if (!feature || disposed) return;
    map.getSource(id("rendering-outputs.selection-source"))?.setData(fc([feature]));
    const identify = dialog?.querySelector<HTMLElement>(".ro-identify");
    if (identify) identify.textContent = `Selected ${String(object(feature.properties).oid ?? object(feature.properties).lane_id ?? feature.id ?? "network feature")}.`;
  };
  const progress = (label: string) => {
    if (disposed) return;
    if (status) status.textContent = label;
    if (status && /unavailable|absent|section-only/i.test(label)) {
      status.classList.add("ro-error");
      if (notificationTimer) clearTimeout(notificationTimer);
      notificationTimer = setTimeout(() => status?.classList.remove("ro-error"), 6000);
    }
    options.onProgress({ value: 0, loaded: 0, total: 0, label });
  };
  const safeFetch = async (path: string, label: string) => {
    if (!path || path.startsWith("/") || path.includes("..") || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error(`Invalid package-relative ${label} path.`);
    progress(`Loading ${label}…`); return options.fetchArtifact(path);
  };
  // Create transient controls before artifact reads so progress and failures
  // are visible while the package is loading.
  if (root && typeof document !== "undefined") {
    styleElement = document.createElement("link"); styleElement.rel = "stylesheet"; styleElement.href = new URL("./rendering-outputs.css", import.meta.url).href; root.append(styleElement);
    dialog = document.createElement("dialog"); dialog.setAttribute("aria-label", "Rendering outputs simulation and display");
    dialog.style.position = "fixed"; dialog.style.inset = "12px 12px auto auto"; dialog.style.margin = "0";
    dialog.innerHTML = `<form method="dialog"><button type="submit" aria-label="Close" title="Close">×</button></form><div class="rendering-outputs-panel rendering-outputs-simulation-panel"><div class="ro-status" role="status">Loading rendering-output package…</div><div class="ro-section" data-section="selectors"><button type="button" class="ro-section-header" data-section-toggle="selectors"><span class="ro-section-caret">▾</span> Simulation &amp; Display</button><div class="ro-section-body"><label>Scenario</label><select class="ro-scenario" disabled aria-label="Scenario"><option>Package network</option></select><label>Experiment</label><select class="ro-experiment" disabled aria-label="Experiment"><option>Not applicable</option></select><label>Replication</label><select class="ro-replication" disabled aria-label="Replication"><option>Not applicable</option></select><label>Display scope</label><select class="ro-scope" aria-label="Display scope"><option value="auto">Auto (zoom)</option><option value="section">Sections</option><option value="lane">Lanes</option></select></div></div><div class="ro-section" data-section="legend"><button type="button" class="ro-section-header" data-section-toggle="legend"><span class="ro-section-caret">▾</span> Map display &amp; Identify</button><div class="ro-section-body"><label class="ro-extrusion-toggle"><input type="checkbox" data-geometry="lanes" /> Lane geometry</label><label class="ro-extrusion-toggle"><input type="checkbox" data-geometry="sections" /> Section geometry</label><div class="ro-identify">Click a network section or lane to identify it.</div></div></div></div>`;
    root.append(dialog); controlRoot = document.createElement("div"); controlRoot.className = "ro-toggle-ctrl";
    control = document.createElement("button"); control.type = "button"; control.className = "ro-toggle ro-toggle-active"; control.textContent = "RO"; control.title = "Rendering outputs"; control.setAttribute("aria-label", "Rendering outputs"); controlRoot.append(control); root.append(controlRoot);
    status = dialog.querySelector(".ro-status");
    control.addEventListener("click", () => {
      if (dialog?.open) { control?.classList.remove("ro-toggle-active"); dialog.close(); }
      else { control?.classList.add("ro-toggle-active"); dialog?.show(); }
    });
    dialog.addEventListener("close", () => control?.classList.remove("ro-toggle-active"));
    for (const header of dialog.querySelectorAll<HTMLButtonElement>(".ro-section-header")) {
      header.addEventListener("click", () => {
        const section = header.closest<HTMLElement>(".ro-section");
        if (!section) return;
        const collapsed = section.classList.toggle("ro-collapsed");
        header.querySelector(".ro-section-caret")!.textContent = collapsed ? "▸" : "▾";
      });
    }
    const laneInput = dialog.querySelector<HTMLInputElement>('input[data-geometry="lanes"]')!;
    const sectionInput = dialog.querySelector<HTMLInputElement>('input[data-geometry="sections"]')!;
    laneInput.addEventListener("change", () => setGeometry("lanes", laneInput.checked));
    sectionInput.addEventListener("change", () => setGeometry("sections", sectionInput.checked));
    dialog.querySelector<HTMLSelectElement>(".ro-scope")!.addEventListener("change", (event) => {
      const scope = (event.currentTarget as HTMLSelectElement).value;
      automaticLod = scope === "auto";
      if (scope === "lane") { setGeometry("sections", false); setGeometry("lanes", true); }
      else if (scope === "section") { setGeometry("lanes", false); setGeometry("sections", true); }
      else onZoomEnd();
    });
    dialog.show();
  }
  try {
    const structure = parseTestudoPackageStructure(options.manifest, options.packageInfo);
    if (structure.sectionsPath) sections = await decode(await safeFetch(structure.sectionsPath, "section geometry"), structure.sectionsPath);
    if (structure.lanesPath) {
      try { lanes = await decode(await safeFetch(structure.lanesPath, "lane geometry"), structure.lanesPath); }
      catch (error) { progress(`Lane geometry unavailable; showing section network: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!sections && !lanes) throw new Error("No readable section or lane geometry was declared.");
    if (!lanes?.features.length) progress("Lane geometry is absent; showing section-only network.");
    sections ??= fc([]); lanes ??= fc([]);
    laneData = fc(lanes.features.map((feature) => laneRibbon(feature, map.getZoom?.() ?? 15)).filter((feature): feature is Feature => Boolean(feature)));
    if (!sections.features.length && !laneData.features.length) throw new Error("Declared network geometry contains no renderable line features.");
    showLanes = Boolean(laneData.features.length && (!sections.features.length || (map.getZoom?.() ?? 15) > 12));
    showSections = Boolean(sections.features.length && !showLanes);
    if (dialog) {
      const laneInput = dialog.querySelector<HTMLInputElement>('input[data-geometry="lanes"]')!;
      const sectionInput = dialog.querySelector<HTMLInputElement>('input[data-geometry="sections"]')!;
      laneInput.checked = showLanes; laneInput.disabled = !laneData.features.length;
      sectionInput.checked = showSections; sectionInput.disabled = !sections.features.length;
    }
    bounds = networkBounds(lanes, sections);
  } catch (error) {
    geometryFailed = true;
    if (dialog) for (const input of dialog.querySelectorAll<HTMLInputElement>("input[data-geometry]")) input.disabled = true;
    progress(`Network unavailable: ${error instanceof Error ? error.message : String(error)}`);
    // Optional package network failure must not make capability loading fail.
  }

  // Add geometry now that the source data is ready. Layers use disjoint ids,
  // preserving stable ownership when host modes switch.
  if (!disposed && !geometryFailed && map.getSource && !map.getSource(id("rendering-outputs.source"))) {
    try {
    const structure = parseTestudoPackageStructure(options.manifest, options.packageInfo);
    // Data is fetched above; retain the parsed collections locally for mount.
    const sectionData = sections ?? fc([]);
    if (sectionData.features.length) {
      const sid = id("rendering-outputs.source"); map.addSource(sid, { type: "geojson", data: sectionData }); sourceIds.add(sid);
      const lid = id("rendering-outputs.line"); map.addLayer({ id: lid, type: "line", source: sid, layout: { visibility: showSections ? "visible" : "none" }, paint: { "line-color": "#777777", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 16, 4], "line-opacity": 0.82 } }); layerIds.add(lid);
      const exs = id("rendering-outputs.extrusion-source"); map.addSource(exs, { type: "geojson", data: sectionData }); sourceIds.add(exs);
      const exl = id("rendering-outputs.extrusion-fill"); map.addLayer({ id: exl, type: "fill", source: exs, layout: { visibility: "none" }, paint: { "fill-color": "#777777", "fill-opacity": 0.55 } }); layerIds.add(exl);
      const sels = id("rendering-outputs.selection-source"); map.addSource(sels, { type: "geojson", data: fc([]) }); sourceIds.add(sels);
      const sell = id("rendering-outputs.selection"); map.addLayer({ id: sell, type: "line", source: sels, paint: { "line-color": "#ffe600", "line-width": 5 } }); layerIds.add(sell);
      layerEvents.on?.("click", lid, onSelect);
    }
    if (laneData.features.length) {
      const sid = id("rendering-outputs.lane.source"); map.addSource(sid, { type: "geojson", data: laneData }); sourceIds.add(sid);
      const lid = id("rendering-outputs.lane"); map.addLayer({ id: lid, type: "fill", source: sid, layout: { visibility: showLanes ? "visible" : "none" }, paint: { "fill-color": "#777777", "fill-opacity": 0.72 } }); layerIds.add(lid);
      layerEvents.on?.("click", lid, onSelect);
      const exs = id("rendering-outputs.lane.extrusion-source"); map.addSource(exs, { type: "geojson", data: laneData }); sourceIds.add(exs);
      const exl = id("rendering-outputs.lane.extrusion-fill"); map.addLayer({ id: exl, type: "fill", source: exs, layout: { visibility: "none" }, paint: { "fill-color": "#777777", "fill-opacity": 0.8 } }); layerIds.add(exl);
    }
    const turnsPath = structure.turnsPath;
    if (turnsPath) try {
      const turns = await decode(await safeFetch(turnsPath, "turn geometry"), turnsPath);
      if (turns?.features.length) {
        const ribbons = turnRibbonFeatureCollection(turns);
        const sid = id("rendering-outputs.turn.source"); map.addSource(sid, { type: "geojson", data: ribbons }); sourceIds.add(sid);
        const lid = id("rendering-outputs.turn"); map.addLayer({ id: lid, type: "fill", source: sid, layout: { visibility: showLanes ? "visible" : "none" }, paint: { "fill-color": "#777777", "fill-opacity": 0.62 } }); layerIds.add(lid);
      }
    } catch (error) { progress(`Turn geometry unavailable; continuing without turns: ${error instanceof Error ? error.message : String(error)}`); }
    if (bounds && !cameraOverridden && !options.cameraWasOverridden()) {
      const declared = declaredDefaultCamera(options.manifest, options.packageInfo);
      if (declared && !Array.isArray(declared)) map.jumpTo?.(declared);
      else map.fitBounds?.(declared ?? bounds, { padding: 48, maxZoom: 16, bearing: 0, pitch: 0 });
    }
    if (!turnsPath) progress(laneData.features.length ? "Network ready; turn geometry is absent." : "Section-only network ready; lane and turn geometry are absent.");
    else progress(laneData.features.length ? "Network ready." : "Section-only network ready; lane geometry is absent.");
    } catch (error) {
      mapRenderFailed = true;
      for (const layer of [...layerIds].reverse()) try { if (map.getLayer(layer)) map.removeLayer(layer); } catch { /* keep cleanup best-effort */ }
      for (const source of [...sourceIds].reverse()) try { if (map.getSource(source)) map.removeSource(source); } catch { /* keep cleanup best-effort */ }
      layerIds.clear(); sourceIds.clear();
      if (dialog) for (const input of dialog.querySelectorAll<HTMLInputElement>("input[data-geometry]")) input.disabled = true;
      progress(`Network rendering unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const setGeometry = (geometry: "lanes" | "sections", visible: boolean) => {
    if (geometry === "lanes" && !laneData.features.length) return { showLanes, showSections };
    if (geometry === "sections" && !sections?.features.length) return { showLanes, showSections };
    automaticLod = false;
    if (geometry === "lanes") showLanes = Boolean(visible); else showSections = Boolean(visible);
    const target = geometry === "lanes" ? id("rendering-outputs.lane") : id("rendering-outputs.line");
    if (map.getLayer(target)) map.setLayoutProperty(target, "visibility", visible ? "visible" : "none");
    const turn = id("rendering-outputs.turn"); if (map.getLayer(turn)) map.setLayoutProperty(turn, "visibility", showLanes ? "visible" : "none");
    if (dialog) dialog.querySelector<HTMLInputElement>(`input[data-geometry="${geometry}"]`)!.checked = visible;
    return { showLanes, showSections };
  };
  const onZoomEnd = () => {
    if (!automaticLod || disposed) return;
    showLanes = Boolean(!mapRenderFailed && laneData.features.length && (!sections?.features.length || (map.getZoom?.() ?? 15) > 12));
    showSections = Boolean(!mapRenderFailed && sections?.features.length && !showLanes);
    const section = id("rendering-outputs.line"); const lane = id("rendering-outputs.lane"); const turn = id("rendering-outputs.turn");
    if (map.getLayer(section)) map.setLayoutProperty(section, "visibility", showSections ? "visible" : "none");
    if (map.getLayer(lane)) map.setLayoutProperty(lane, "visibility", showLanes ? "visible" : "none");
    if (map.getLayer(turn)) map.setLayoutProperty(turn, "visibility", showLanes ? "visible" : "none");
    if (dialog) {
      dialog.querySelector<HTMLInputElement>('input[data-geometry="lanes"]')!.checked = showLanes;
      dialog.querySelector<HTMLInputElement>('input[data-geometry="sections"]')!.checked = showSections;
    }
  };
  zoomEvents.on?.("zoomend", onZoomEnd);
  return {
    ownedIds: ids,
    get available() { return !geometryFailed && !mapRenderFailed && (layerIds.size > 0); },
    get hasLanes() { return laneData.features.length > 0; },
    get hasSections() { return Boolean(sections?.features.length); },
    get showLanes() { return showLanes; }, get showSections() { return showSections; },
    setGeometry,
    setLegend(visible) { const section = dialog?.querySelector<HTMLElement>('.ro-section[data-section="legend"]'); if (section) section.hidden = !visible; return Boolean(visible); },
    dispose() {
      if (disposed) return; disposed = true;
      for (const layer of layerIds) try { layerEvents.off?.("click", layer, onSelect); } catch { /* map may already be unloading */ }
      for (const layer of [...layerIds].reverse()) try { if (map.getLayer(layer)) map.removeLayer(layer); } catch { /* map may already be unloading */ }
      for (const source of [...sourceIds].reverse()) try { if (map.getSource(source)) map.removeSource(source); } catch { /* map may already be unloading */ }
      try { map.off?.("movestart", onMoveStart); } catch { /* map may already be unloading */ }
      try { zoomEvents.off?.("zoomend", onZoomEnd); } catch { /* map may already be unloading */ }
      if (notificationTimer) clearTimeout(notificationTimer);
      dialog?.close(); dialog?.remove(); controlRoot?.remove(); styleElement?.remove();
      dialog = null; control = null; controlRoot = null; status = null; styleElement = null;
    },
  };
}

function emptyService(): RenderingOutputsService {
  return { ownedIds: [], available: false, hasLanes: false, hasSections: false, showLanes: false, showSections: false,
    setGeometry: () => ({ showLanes: false, showSections: false }), setLegend: () => false, dispose() {} };
}
