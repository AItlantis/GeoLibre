# Mapbox renderer

Choose **View → Rendering engine → Mapbox** to render a project with Mapbox GL JS.
The engine is also available from the rendering-engine menu in each split pane.
MapLibre remains the default. Projects save the primary and secondary renderer
choices, and the Python and iframe APIs accept `mapbox` as a renderer name.

Paste your token into **Settings → Environment Variables → Mapbox token** and
click **Save Settings**. Like the Cesium token, it is stored on this device,
outside the project file. Existing enabled Mapbox environment-variable rows
move into this field when settings are saved; Cancel leaves them unchanged.
Alternatively, launch the development server with `MAPBOX_TOKEN` in its environment. Token changes
recreate Mapbox maps. A missing token displays setup instructions; map loading
errors redact access tokens. Use a public Mapbox token appropriate for your
application. Mapbox use is associated with that token's account and is subject
to Mapbox's terms and usage pricing.

New projects use Mapbox Streets by default for the Mapbox renderer. Open the
shared **Basemaps** panel from the Layers panel or Add Data to select Mapbox
styles (including Standard), public styles, or stacked raster basemaps. The
separate floating Mapbox selector has been removed.

A style selected in the Basemaps panel is saved as
`preferences.map.mapboxStyleUrl` while Mapbox is active, leaving the shared
MapLibre/Cesium background unchanged. All Mapbox panes share that choice.
Previously saved projects keep their selected styles. Provider credentials
come from Environment variables or the basemap control's API keys panel.

## Supported paths

- Native GeoJSON, including the vector importer's materialized data, with point,
  line, polygon, extrusion, label, data-driven color, opacity, and filter styles.
- HTTP(S) raster tiles (XYZ, WMS and WMTS), vector tiles with named source layers,
  and georeferenced image/video sources.
- Shared layer/group visibility, opacity and ordering; synchronized or independent
  split-view cameras; Mercator/globe projection and Mapbox terrain.
- Feature picking, selection highlighting, extent drawing, draggable placement,
  and engine-level image capture.

Mapbox is not a full replacement for MapLibre's plugin ecosystem. Plugins must
explicitly declare `engines: ["mapbox"]` (or include it alongside other engines).
Unsupported plugins are disabled in the menu. `app.getMap()` stays MapLibre-only;
Mapbox-aware plugins use `app.getMapboxMap()` or the renderer-neutral app methods.
The vector import panel uses the existing store-based geometry bridge.

The offline (local PMTiles) basemap is MapLibre-only as well: its `pmtiles://`
source protocol is not registered with Mapbox, so a Mapbox pane whose project
basemap is an offline archive falls back to the default basemap (with a console
warning). Pick a Mapbox style from the shared Basemaps panel instead.
MapLibre custom protocols, tiled/streamed vector imports beyond the bridge's
materialization limits, custom COG terrain, deck.gl, and specialized plugin-owned
layers require additional adapters. Visible unsupported layers report an error
on the map instead of being silently omitted. Advanced MapLibre-only symbology
(such as custom marker assets and blend modes) is not reproduced by this native
renderer. Mapbox Standard's imported basemap layers do not expose the same
per-layer opacity controls as classic styles; use a classic style for background
opacity editing.

## License and terms

GeoLibre itself is MIT licensed, but the Mapbox renderer depends on
[Mapbox GL JS](https://github.com/mapbox/mapbox-gl-js) v3 (`mapbox-gl`
3.30.0 at the time of writing), which is **not** open source. Mapbox GL JS v3
is distributed under the
[Mapbox Terms of Service](https://www.mapbox.com/legal/tos) and its
[license](https://github.com/mapbox/mapbox-gl-js/blob/main/LICENSE.txt);
it requires an active Mapbox account, may only be used with an access token
from that account and with the relevant Mapbox products, and its terms restrict
altering the SDK's billing, accounting and data-collection code. Usage-based
billing and Mapbox's attribution requirements depend on how the Mapbox services
are used under your account and the applicable terms; consult those terms before
enabling the renderer in a product. The SDK is a runtime dependency of
`@geolibre/map`, so npm consumers of that package and the desktop and web
distributions receive it even when MapLibre stays the active renderer, but no
Mapbox code runs (and no Mapbox service is contacted) until a Mapbox pane is
opened.

## Loading and size

Mapbox's JavaScript and CSS are imported only when a Mapbox pane mounts. The
production build gives them a separate chunk and excludes them from the PWA's
initial precache. MapLibre startup therefore does not download the Mapbox engine.
Desktop/web distribution artifacts still include it. With Mapbox GL JS 3.30.0,
the engine and stylesheet add approximately 1.91 MB raw, or 532 KB with gzip;
this excludes map tiles and other service responses.

## Add Data compatibility

The Add Data menu waits for Mapbox to finish loading before accepting an
import, so early clicks cannot lose a panel-opening request.

The Add Data menu and command palette withhold loaders that require an
unimplemented MapLibre protocol or custom render pass. These entries are
visible but disabled in the menu with a Mapbox compatibility hint: MBTiles,
PMTiles, Zarr, LiDAR, Gaussian Splatting, 3D Tiles, DuckDB, and deck.gl/3D models.
Cesium Ion, CZML, and KML scene loaders remain Cesium-only.

FlatGeobuf uses the shared vector importer on Mapbox. ArcGIS vector-tile
services retain their resolved tile sources, service styles, classification
filters, visibility, and opacity. STAC supports catalog browsing, extent
search, bbox drawing, footprints, and selection on both MapLibre and Mapbox;
assets that need PMTiles or Zarr remain download-only on Mapbox.

NetCDF/HDF files and directly readable remote files can render a selected
plane, including a time slice, as an image. Mapbox does not animate that image
through the Zarr renderer. Kerchunk references that require that renderer
cannot be added under Mapbox.

### Browser validation

The September 2026 audit opened every one of the 37 Add Data entries that was
enabled, checked the existing disabled entries, and exercised the public data
paths below with an authenticated Mapbox map. A mounted panel alone is not a
successful import; the table records the level of verification. Backend and
service restrictions are included explicitly.

| Panel | Result |
| --- | --- |
| Vector | US states GeoJSON: 52 features imported and rendered |
| Raster | Public DEM GeoTIFF: GPU raster displayed |
| Delimited Text | US cities CSV: 109 points imported and rendered |
| CAD | US states DXF: 58 entities discovered; EPSG:5070 import exercised |
| File Geodatabase | Panel opens; its local GDAL/sidecar workflow requires Desktop |
| Geotagged Photos | EXIF sample JPEG: one located photo imported |
| GPX | Fells Loop: 86 waypoints and one route; both native sources created |
| Encoded Polyline | Precision-5 sample: one line imported and rendered |
| MBTiles | Disabled: local custom protocol has no Mapbox adapter |
| OSM PBF | Monaco extract: 4,249 points, 4,002 lines, and 2,341 polygons imported and displayed |
| XYZ | USGS imagery sample: native raster source mounted |
| WMS | USGS NAIP sample: native raster source mounted |
| CSW Catalog | Open Canada catalog searched; Manitoba Economic Regions imported as eight GeoJSON features |
| WFS | MapServer continents service imported; the GeoServer sample was blocked by its remote service |
| WMTS | EOX Sentinel-2 cloudless sample: native raster source mounted |
| OGC API - Features | pygeoapi lakes sample: 25 features imported and rendered |
| OGC Vector Tiles | PDOK BGT sample: native vector-tile source mounted |
| ArcGIS | 4,186 city features rendered; Santa Monica parcels rendered using all seven service style layers |
| GeoRSS | USGS daily earthquake feed: 34 features imported (the live count changes) |
| STAC | Earth Search connected; 20 Sentinel-2 search footprints added |
| Video | Mapbox coastal video sample: native video source mounted |
| Deck.gl | Disabled: custom renderer has no adapter |
| GeoParquet | US states: 52 features imported and rendered |
| FlatGeobuf | Countries: 179 features imported through the shared vector bridge |
| PMTiles | Archive read reproduced an unsupported-protocol error; entry now disabled |
| Zarr | Panel/sample loading exercised; custom rendering remains unsupported and entry disabled |
| NetCDF / HDF | Air-temperature file: selected time slice added as a native image |
| LiDAR | Panel/sample loading exercised; custom rendering remains unsupported and entry disabled |
| Gaussian Splatting | Panel opens; custom rendering unsupported and entry disabled |
| 3D Tiles | Panel opens; custom rendering unsupported and entry disabled |
| Cesium Ion | Disabled: Cesium-only |
| CZML | Disabled: Cesium-only |
| KML / KMZ | Disabled: Cesium scene loader |
| 3D Model | Disabled: deck.gl scenegraph renderer |
| DuckDB | Panel opens; dedicated custom renderer unsupported and entry disabled |
| PostgreSQL | Panel explains its Desktop/Martin requirement; no database connection tested |
| Apache Iceberg | Panel opens; no table/catalog connection supplied for an import |

An opt-in regression suite repeats the FlatGeobuf, ArcGIS vector-tile, STAC,
and menu-boundary checks in light and dark themes:

```bash
# Supply a public token in the environment before running.
npm exec -- playwright test e2e/mapbox-add-data.spec.ts
```

The tests skip when `MAPBOX_TOKEN` is absent. They use live public services;
remote-service availability is part of these integration checks.
