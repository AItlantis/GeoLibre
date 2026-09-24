import {
  DEFAULT_ELLIPSOID_ID,
  DEFAULT_LAYER_STYLE,
  getPlanetaryBasemapByStyleUrl,
  useAppStore,
} from "@geolibre/core";
import { useLayoutEffect } from "react";
import { readLastBasemap, writeLastBasemap } from "../lib/last-basemap";

const DEFAULT_WORLD_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_WORLD_IMAGERY_SOURCE = "geolibre-default-world-imagery";
const DEFAULT_WORLD_IMAGERY_ATTRIBUTION =
  "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const DEFAULT_WORLD_IMAGERY_OPACITY = 0.35;

/** Restore the last basemap into the empty startup workspace and track changes. */
export function useLastBasemapPersistence(): void {
  useLayoutEffect(() => {
    const state = useAppStore.getState();
    const storedBasemap = readLastBasemap();

    // Never replace a project that another startup source already loaded.
    if (
      storedBasemap !== null &&
      state.projectGeneration === 0 &&
      state.projectPath === null &&
      !state.isDirty
    ) {
      const ellipsoidId =
        getPlanetaryBasemapByStyleUrl(storedBasemap)?.ellipsoidId ?? DEFAULT_ELLIPSOID_ID;
      useAppStore.setState({
        basemapStyleUrl: storedBasemap,
        preferences: {
          ...state.preferences,
          map: { ...state.preferences.map, ellipsoidId },
        },
      });
    }

    // Keep the default imagery as an ordinary layer so its opacity and
    // visibility are controlled by the layer system. This hook runs in the
    // regular desktop app and in embedded GeoLibre sessions (including
    // Testudo); project-loaded sessions keep the layers from their project.
    const current = useAppStore.getState();
    if (
      current.projectGeneration === 0 &&
      current.projectPath === null &&
      !current.isDirty &&
      !current.layers.some((layer) => layer.metadata.sourceKind === DEFAULT_WORLD_IMAGERY_SOURCE)
    ) {
      useAppStore.setState({
        layers: [
          ...current.layers,
          {
            id: DEFAULT_WORLD_IMAGERY_SOURCE,
            name: "World Imagery (Esri)",
            type: "xyz",
            source: {
              type: "raster",
              tiles: [DEFAULT_WORLD_IMAGERY_URL],
              tileSize: 256,
              attribution: DEFAULT_WORLD_IMAGERY_ATTRIBUTION,
            },
            visible: true,
            opacity: DEFAULT_WORLD_IMAGERY_OPACITY,
            style: { ...DEFAULT_LAYER_STYLE },
            metadata: { sourceKind: DEFAULT_WORLD_IMAGERY_SOURCE },
          },
        ],
      });
    }

    writeLastBasemap(useAppStore.getState().basemapStyleUrl);
    return useAppStore.subscribe((next, previous) => {
      if (next.basemapStyleUrl !== previous.basemapStyleUrl) {
        writeLastBasemap(next.basemapStyleUrl);
      }
    });
  }, []);
}
