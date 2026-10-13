/**
 * Minimal structural subset of GeoLibre's plugin contract (packages/plugins/src/types.ts), kept local
 * because a drop-in plugin is built outside the monorepo's TypeScript project. Every member used here
 * exists with the same shape in GeoLibrePlugin / GeoLibreAppAPI / GeoLibreRightPanelRegistration.
 */
export interface HostRightPanel {
  id: string;
  title: string | (() => string);
  defaultWidth?: number;
  deactivatePluginOnClose?: boolean;
  render: (container: HTMLElement) => void | (() => void);
  onClose?: () => void;
}

export interface HostMapLike {
  addSource(id: string, source: unknown): unknown;
  addLayer(layer: unknown): unknown;
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  removeLayer(id: string): unknown;
  removeSource(id: string): unknown;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}

export interface HostApp {
  addGeoJsonLayer: (name: string, data: GeoJSONFC, sourcePath?: string) => string;
  getMap?: () => HostMapLike | null;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  registerRightPanel?: (panel: HostRightPanel) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  getLocale?: () => string;
  onLocaleChange?: (listener: (locale: string) => void) => () => void;
  translate?: (key: string, defaultValue: string, params?: Record<string, string | number>) => string;
}

export interface HostPlugin {
  id: string;
  name: string;
  version: string;
  urlParameterNames?: string[];
  activate: (app: HostApp) => boolean | void | Promise<boolean | void>;
  deactivate: (app: HostApp) => void;
  handleUrlParameters?: (app: HostApp, params: URLSearchParams) => void | boolean | Promise<void | boolean>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: HostApp, state: unknown) => boolean | void;
}

export interface GeoJSONFeature {
  type: "Feature";
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}
export interface GeoJSONFC {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}
