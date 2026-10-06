# Rendering outputs network service

P1 ports the package network portion of GeoLibre's original rendering-outputs
plugin into Testudo's v3.1 plugin runtime. Source of truth:

- `viewer/vendor/geolibre/rendering-outputs.js` (1988-line vendored bundle)
- `viewer/vendor/geolibre/rendering-outputs-turns.js`
- `viewer/vendor/geolibre/rendering-outputs.css`
- `viewer/core/network-tile-source.js` (reviewed for the large-network boundary)

The vendored renderer was built from `modelling-plugins/geolibre-plugin` base
commit `92f105dfd0484f6ca69c7edce098b1be080d8cc4`, validated against GeoLibre
v2.5.0 (`4a955436a4bfb1250017fd19d25d632ebf5b0e34`), and has upstream ESM
SHA-256 `64205464AE109948B67B8DA1BDA6D6E4CAB69046BB756941562861BF8FA40818`.

## Ported files and mapping

- `index.ts`: ESM package-generation service adapted from the network lifecycle,
  section/lane source and layer setup, zoom LOD, selection, grey lane display,
  network display/identify panel and teardown logic in `rendering-outputs.js`.
- `rendering-outputs-turns.ts`: ESM turn ribbon geometry helper from
  `rendering-outputs-turns.js`.
- `rendering-outputs.css`: copied verbatim from the original 20-line
  `rendering-outputs.css`; original class names, CSS variables, collapsible
  section styling and `.ro-toggle-ctrl` styles are retained.

The classic-script globals `window.vweGeoLibrePlugin` and
`window.vweGeoLibreTurns` are replaced with module exports. The registry imports
this service dynamically, so the main bundle does not eagerly include it. Map
IDs are scoped to sanitized `TView + generation` keys; the service mounts once
for that package generation and survives capability/mode switches. It reads
package files only through `fetchArtifact` and accepts the original section,
lane and turn path forms supported by the v3.1 package parser. Failed optional
lane/turn files leave section rendering available with a progress reason.

## UI and host adaptation

The original renderer's panel content uses `app.registerFloatingPanel`,
`app.openFloatingPanel`, `app.addMapControl`/`removeMapControl`, and
`app.getMap`. Those methods are not part of v3.1's `TestudoMapHandle` contract.
The original simulation/display panel markup, labels, class names, collapse
behavior and stylesheet are retained. A native temporary `<dialog>` and a
`.ro-toggle-ctrl` button mounted in the map container replace the GeoLibre
floating-panel manager; the replacement is non-modal so the map remains
interactive. Closing the dialog removes the active toggle state.
The panel opens for network loading and can be reopened with the `RO` control.
Scenario, experiment and replication selectors are disabled because P1 only
loads network geometry. The original map-display/identify section includes the
v3.1 lane and section visibility controls. The host Legend control shows/hides
that original panel section. Map selection updates the original identify text.
No `window`, GeoLibre host global, CDN, or network request is used by this
service.

The original time panel and time controls are not included: they operate on
interval and metric data, which belongs to later Results/Animation stages.
The grey network has no metric color ramp; the original network display panel's
“Map display & Identify” section is the applicable legend/identify section for
this P1 renderer.

## Geometry and scale

Section lines are neutral grey; lane features are neutral-grey ribbons, turn
features are grey ribbons, and selected sections/lanes use the original
selection highlight color. When both geometries exist, automatic display uses
the original LOD rule: lane scope above zoom 12, section scope at zoom 12 and
below. Explicit lane/section controls disable automatic LOD until Auto is
selected. If lanes are absent, sections remain visible; if turns are absent,
network loading succeeds and reports that reason. Camera fit uses the same
loaded section/lane bounds and yields to user camera movement or a declared
package camera.

`network-tile-source.js` was reviewed but not ported. The London fixture at
`F:\repos\tmp\scratch\pkg-rebuild-20261006\london\package` has only a few
hundred section/lane/turn features (far below the source renderer's large
network tiling use case), so tile index creation and viewport refresh would add
unneeded data-path and lifecycle complexity for this package. Zoom LOD is
ported because the ordinary renderer uses it at any network size.

## Ownership

`testudo-layer-ownership.ts` declares the permanent `rendering-outputs.*`
network set plus disjoint mode prefixes: `testudo-vehicle-*`,
`testudo-results-*`, `testudo-comparison-*`, and `testudo-path-*`. Registry mode
switches remove only the outgoing mode IDs. The network service retains the
same IDs through Animation, Results, Environment, Comparisons and Paths; it is
disposed only when that package generation unloads or reloads.

