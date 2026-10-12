/**
 * Minimal structural types for the parts of the GeoLibre plugin API the OD plugins use.
 * A drop-in is bundled on its own and cannot import `@geolibre/plugins`, so the subset is
 * restated here. Keep in sync with packages/plugins/src/types.ts.
 */

export interface MapLike {
  addSource(id: string, spec: Record<string, unknown>): void;
  getSource(id: string): { setData?: (d: unknown) => void } | undefined;
  removeSource(id: string): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  setLayoutProperty(layer: string, prop: string, value: unknown): void;
  setPaintProperty(layer: string, prop: string, value: unknown): void;
  on(type: string, layerOrFn: string | ((e: any) => void), fn?: (e: any) => void): void;
  off(type: string, layerOrFn: string | ((e: any) => void), fn?: (e: any) => void): void;
  getContainer(): HTMLElement;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
  getPitch?(): number;
  easeTo?(opts: Record<string, unknown>): void;
  flyTo(opts: Record<string, unknown>): void;
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
  handleUrlParameters?: (app: AppLike, params: URLSearchParams) => void | Promise<void>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: AppLike, state: unknown) => boolean | void;
}
