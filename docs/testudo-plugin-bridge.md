# Testudo plugin bridge on GeoLibre 3.1

This bridge targets GeoLibre **3.1.0**, commit
`5b5b3b8146f79d51dff0cc83b7464d492fb8b87c`. It relies on the v3.1 plugin API
and the version 2 iframe embed protocol. GeoLibre 3.2.0 and unpublished tags
are outside this compatibility contract.

## Ownership

Testudo behavior is provided by plugins. The host supplies the existing plugin
manager, map, camera, panel and iframe transport APIs. The shared feature
contracts in `@geolibre/plugins` define playback, scenarios, map/camera
controls, view modes, network filters and GeoAI requests without adding those
concepts to the generic GeoLibre app API.

Every feature session has a `tviewId` and monotonically increasing `generation`.
Replacing or closing a session invalidates its late package loads and GeoAI
responses. A view command is delivered to the session identified by its `tviewId`;
the receiver must not resolve the current or focused view as a fallback.

## Iframe messages

`@geolibre/embed` `connect(iframe, { origin })` remains the consumer entry point.
The parent pins the exact iframe origin; the child checks both
`event.source === window.parent` and that origin. After the `ready` event, each
Testudo request carries a fresh request id and the child-issued 32 character
hex challenge. Successful commands acknowledge with the standard embed `ack`
event. Errors reject the command promise with the child error text.

Package commands:

| Method | Input | Result |
| --- | --- | --- |
| `testudoCreateTView` | `{ tviewId }` | `{ tviewId, generation: 0, loaded: false }` |
| `testudoGetTViews` | none | each host-created view's id, generation and loaded flag |
| `testudoLoadPackage` | `{ tviewId, bootstrap, selectedPlugin?, presetId? }` | viewer state |
| `testudoSetPlugin` | `{ tviewId, id }` | viewer state |
| `testudoSetPreset` | `{ tviewId, id }` | viewer state |
| `testudoGetState` | `{ tviewId }` | viewer state |
| `testudoRequestInvestigation` | `{ question, tviewId, activeScenarioId? }` | `{ requestId, tviewId, generation, accepted: true }` |
| `testudoRespondGeoAIRequest` | `{ requestId, tviewId, generation, content?, error? }` | `{ requestId, accepted }` |
| `testudoOpenRecordTour` / `testudoOpenRecordVideo` | `{ tviewId }` | `{ opened: true }` |

The host creates an explicit TView id before loading a package. Package loading
never creates a default view or redirects to the focused view. Every state,
scenario, playback, camera, map-control, view-mode, filter and record command
includes the TView id. `testudoSetActiveTView` reports the host's toolbar
selection; it is not a routing fallback.

Playback commands are `testudoSetPlaybackPlaying`, `testudoRestartPlayback`,
`testudoSeekPlayback`, `testudoSetPlaybackSpeed`, and
`testudoGetPlaybackState`. Playback methods may carry the current `generation`;
when supplied, the bridge rejects commands from an older package generation.
The playback feature itself receives both `tviewId` and `generation` on every
operation. Scenario selection and map/camera commands address a
specific `tviewId`; selection does not mutate a comparison's other view.

Scenario ids are strings at the bridge boundary, including numeric simulation
scenario ids. The Testudo shell should call `String(scid)` before sending
`scenarioId` or `activeScenarioId`; replication ids remain numeric.

`?layout=testudo` selects Testudo mode in `apps/geolibre-desktop/src/hooks/useLayoutOptions.ts`.
It hides the stock Strands assistant and blocks GeoAgent. The remaining GeoAI
path is the correlated `testudoGeoAIRequest` relay to the embedding host.

The built-in `vehicle-playback`, `network-kpi`, `emissions-h3`, and
`scenario-comparison` providers register through
`registerTestudoPackageProvider`. The package resolver opens every registered,
available capability declared by the package into one TView session. The
provider suite owns the shared generation-scoped clock (using the vehicle
provider's playback source when declared, or a suite clock derived from the
capability manifest range otherwise); selecting another capability changes
the active view without replacing that clock. Every clock
change calls each provider's optional `onPlaybackTick(tviewId, generation,
state)` hook. `testudoGetPlaybackState` adds optional `activeCapability` and
`tickFollowers` fields so the host can see which capabilities follow the clock
and which have time-series values. A capability with no time-series data
reports `timeSeriesAvailable: false` in its follower entry.

The v3.1 time-series adapters read package `manifest.json` fields
`kpiTimeSeries`, `emissionsTimeSeries`, and `comparisonTimeSeries`. Each field
maps a section/H3/scenario id to an array indexed by the shared zero-based tick.
The network-KPI and emissions providers expose the current values through
their session's `getPlaybackValues()` hook. The comparison provider exposes
both requested scenario rows through `getComparisonAtTick([scenarioA,
scenarioB])`; both rows use exactly the shared tick. Scenario identifiers stay
strings at the bridge boundary. All follower calls validate the explicit TView
id and package generation, and providers are disposed together when that
package session is replaced.

The older line's parquet readers, geometry preparation, and MapLibre rendering
adapters cannot be carried over as v3.1 package providers without their older
renderer/data-provider contract. This port covers the v3.1 session contract,
manifest-backed tick values, capability switching, and comparison pairing; it
does not reproduce those older spatial rendering paths. `path-analysis` and
dataset-query remain unregistered in this branch.

`testudoStateChanged`, `testudoPlaybackChanged`, and `testudoGeoAIRequest` are
typed embed events. Progress is reported from real loader byte counters as
`{ label, value, loaded, total }`, with `value` derived from `loaded / total`.
Invalid progress fails the provider load rather than producing a synthetic fraction.

In `?layout=testudo`, the Testudo shell opens a local package through
`testudoOpenLocalPackage({ tviewId })`, which returns the resulting
`ViewerState`. The iframe validates `manifest.json` and
`geolibre/package.json`, opens its own read-only folder picker, and reads
artifacts directly from that directory. Package bytes and directory handles
stay in the iframe and never pass through the host. Call the command directly
from the shell button's click handler so the browser can preserve transient user
activation for the picker. The command is enabled only when the embed API is
enabled by `VITE_GEOLIBRE_EMBED_ORIGINS` at build time or
`GEOLIBRE_EMBED_ORIGINS` in `geolibre-runtime-config.js` at runtime.

## Credentials and GeoAI

Package artifact credentials stay in the embedding host. The iframe has no
guest-token setter and receives no authorization header. A provider asks for a
relative artifact reference; the iframe sends a correlated
`testudoArtifactRequest` containing only `requestId`, `tviewId`, `generation`,
the artifact reference, and the child-issued challenge. The typed host client
calls its `fetchArtifact` option, where the host can use its own in-memory auth,
then transfers the `ArrayBuffer` in a `testudoArtifactResponse` that echoes the
same correlation tuple. The host drops requests and results for unknown TViews,
old generations, duplicate request ids, or a disconnected client. The iframe
also checks the exact parent source, pinned origin, challenge, and full
correlation tuple before handing bytes to the provider. No credential field or
token is part of these protocol messages.

```ts
const client = await connect(iframe, {
  origin: "https://gis.example.com",
  fetchArtifact: async ({ artifactRef }, signal) => {
    // Keep authorization in this host-side closure. Resolve only references
    // from the package endpoint captured by the host.
    const response = await fetch(resolvePackageArtifact(artifactRef), {
      signal,
      headers: getHostAuthorizationHeaders(),
    });
    if (!response.ok) throw new Error("Artifact fetch failed");
    return response.arrayBuffer();
  },
});
```

`testudoGeoAIRequest` includes `requestId`, `messages`, and full context with
package/version/plugin/scenario, `tviewId`, and `generation`. The host validates
that context before calling Gateway, then rechecks the current TView generation
and package version before delivery. Its reply contains only
`{ requestId, tviewId, generation, content? | error? }`; the child resolves
that tuple against the exact pending request and its owning plugin session.
