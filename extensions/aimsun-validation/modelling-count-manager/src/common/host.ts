/**
 * Minimal structural types for the parts of the GeoLibre plugin API these plugins use.
 * A drop-in is bundled on its own and cannot import `@geolibre/plugins`, so the subset is
 * restated here. Keep in sync with packages/plugins/src/types.ts (GeoLibreAppAPI,
 * GeoLibrePlugin, GeoLibreRightPanelRegistration, GeoLibreExternalNativeLayerRegistration).
 */

export interface MapLike {
  addSource(id: string, spec: Record<string, unknown>): void;
  getSource(id: string): { setData?: (d: unknown) => void } | undefined;
  removeSource(id: string): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  setPaintProperty(layer: string, prop: string, value: unknown): void;
  setLayoutProperty(layer: string, prop: string, value: unknown): void;
  setFilter?(layer: string, filter: unknown): void;
  addImage?(id: string, image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, options?: { sdf?: boolean; pixelRatio?: number }): void;
  hasImage?(id: string): boolean;
  removeImage?(id: string): void;
  on(type: string, layerOrFn: string | ((e: any) => void), fn?: (e: any) => void): void;
  off(type: string, layerOrFn: string | ((e: any) => void), fn?: (e: any) => void): void;
  getContainer(): HTMLElement;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
  /** Rendered features under a pixel box (collided/hidden symbols are not returned). */
  queryRenderedFeatures?(box: [[number, number], [number, number]], options?: { layers?: string[] }): Array<{ layer?: { id?: string }; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> | null }>;
  project?(lngLat: [number, number]): { x: number; y: number };
  flyTo(opts: Record<string, unknown>): void;
  fitBounds?(bounds: [[number, number], [number, number]], opts?: Record<string, unknown>): void;
}

export interface RightPanelRegistration {
  id: string;
  title: string | (() => string);
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onClose?: () => void;
}

export interface ToolbarMenuLike {
  id: string;
  label: string | (() => string);
  items: Array<{ id: string; label: string | (() => string); onSelect: () => void }>;
}

export interface NativeLayerRegistration {
  id: string;
  name: string;
  type?: string;
  nativeLayerIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  geojson?: unknown;
  paintMode?: "geolibre" | "plugin";
  paintBridge?: { setOpacity?: (o: number) => void; setVisibility?: (v: boolean) => void };
  metadata?: Record<string, unknown>;
}

export interface AppLike {
  getMap?: () => MapLike | null;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  registerExternalNativeLayer?: (l: NativeLayerRegistration) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
  registerRightPanel?: (p: RightPanelRegistration) => () => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
  registerToolbarMenu?: (m: ToolbarMenuLike) => () => void;
  getLocale?: () => string;
  onLocaleChange?: (listener: (locale: string) => void) => () => void;
  translate?: (key: string, defaultValue: string, params?: Record<string, string | number>) => string;
}

export interface PluginLike {
  id: string;
  name: string;
  version: string;
  urlParameterNames?: string[];
  activate: (app: AppLike) => boolean | void | Promise<boolean | void>;
  deactivate: (app: AppLike) => void;
  handleUrlParameters?: (app: AppLike, params: URLSearchParams) => void | boolean | Promise<void | boolean>;
  /** Host-only run switch (Testudo analysis bridge); resolves false unless the host opened the plugin. */
  setRun?: (run: string) => Promise<boolean>;
  /** Host-only time window / info hooks (Testudo analysis bridge, contract C15). */
  setTimeWindow?: (win: { from_s: number; to_s: number; cursor_s: number }) => void;
  onHostInfo?: (cb: ((info: any) => void) | null) => void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: AppLike, state: unknown) => boolean | void;
}
