# Testudo–GeoLibre plugin bridge v2

This document defines the host/plugin message contract implemented by the GeoLibre Testudo bridge plugin. It is separate from GeoLibre's existing `geolibre` iframe embed protocol. The host and plugin keep independent challenges, message sources, and pending request maps.

## Lifecycle and envelopes

The plugin posts a `ready` message immediately and every 750 ms until deactivation:

```json
{"v":2,"source":"geolibre-testudo-plugin","type":"ready","payload":{"version":"testudo-v1","challenge":"<32 lowercase hex characters>"}}
```

The host sends commands to the iframe using the exact `contentWindow` target and the allow-listed iframe origin:

```json
{"v":2,"source":"testudo-geolibre-plugin","type":"testudoGetState","requestId":"<host-generated id>","payload":{"challenge":"<ready challenge>"}}
```

Every supported command receives one acknowledgement with the same request ID:

```json
{"v":2,"source":"geolibre-testudo-plugin","type":"ack","payload":{"requestId":"<host-generated id>","ok":true,"result":{}}}
```

Errors use `ok:false` and a bounded `error` string instead of `result`. Invalid origins, sources, versions, challenges, request IDs, and unknown command names are ignored. A supported command with invalid arguments or an unavailable provider receives an error ACK. The host must not reuse this channel's challenge or pending map for core `geolibre` messages.

The plugin posts `ready` before receiving a host command. State-change events are sent after the host's first valid command establishes the target origin. On plugin deactivation, the plugin clears credentials, timers, listeners, package state, and its shared-feature registrations; a new activation creates a new challenge.

## Package bootstrap and artifact access

`testudoLoadPackage` takes the existing Testudo bootstrap paths; it does not require a new playback URL:

```json
{
  "bootstrap": {
    "packageId": "<package id>",
    "versionId": "<package version id>",
    "manifestPath": "manifest.json",
    "nativeManifestPath": "geolibre/package.json",
    "artifactEndpoint": "/api/v1/view/<version id>/artifact/"
  },
  "transport": {"bearerToken":"<optional signed-in token>"}
}
```

The plugin resolves `artifactEndpoint` against the GeoLibre iframe's `window.location.origin`, validates it is same-origin with that API origin, and checks that it is scoped to `versionId`. The parent website origin is used only for the validated `postMessage` channel; it is not used for Testudo API requests. The plugin fetches the root manifest, the native GeoLibre package manifest, and every animation chunk listed by the root manifest through the descriptor endpoint. Chunk paths are checked before use. The native package supplies scenario metadata; the root manifest supplies the measured tick and chunk progress data.

The plugin requests the exact `nativeManifestPath` first. For the known legacy `geolibre/package.json` path only, a descriptor `404` retries `geolibre-package.json` through the same version-scoped endpoint and authorization. Authorization failures, network errors, and other status codes do not trigger the fallback. Both paths remain bound to the same package version.

Authentication follows Testudo's artifact contract:

- Signed-in: the descriptor GET carries `Authorization: Bearer <token>`. The returned signed byte URL is fetched without the Bearer header; its signature authorizes the byte request.
- Guest: first send `testudoSetGuestCapability` with `{protocol:1,guestEmbedToken,expiresAt,packageId,packageVersionId}`. The capability is package/version-bound and accepts up to 605 seconds to cover epoch-second rounding and Testudo's five-second skew allowance. Descriptor and returned byte requests both carry `Authorization: Testudo-Embed <token>`; the guest byte URL must not contain a query string or fragment.
- Credentials are sent in headers, never appended to descriptor URLs. Fetches use omitted browser credentials, no-store caching, and error-on-redirect.

Returned byte URLs must use the configured Testudo byte origin (`VITE_TESTUDO_BYTE_ORIGINS`; default `https://bytes.testudo.live`) over HTTPS, except localhost development. The byte service must allow the embedding viewer origin and expose `Content-Length` for measured byte progress.

## Commands

Every payload also includes the plugin `challenge` shown in `ready`.

| Command | Additional payload | Result / behavior |
| --- | --- | --- |
| `testudoGetState` | none | Readiness, capability flags, and current map/control snapshot. |
| `testudoGetCameraState` | none | `{available,center,zoom,bearing,pitch}` or an unavailable reason. |
| `testudoSetCamera` | Any of `center:[lng,lat]`, `zoom`, `bearing`, `pitch` | Applies a validated camera jump and returns current camera state. |
| `testudoGetMapControlState` | none | Renderer and built-in control visibility. |
| `testudoSetBuiltInMapControl` | `{control,visible}` | Updates a supported built-in control (`navigation`, `fullscreen`, `geolocate`, `globe`, `terrain`, `scale`, `attribution`, `logo`, `maptoolkit-logo`, `layer-control`). |
| `testudoGetViewModeState` | none | Active view-mode provider state, or `{available:false,modes:[]}`. |
| `testudoSetViewMode` | `{mode}` | Sets a provider-supported mode; errors if no provider is active. |
| `testudoGetNetworkFilterState` | none | Active filter state, or `{available:false,filters:{}}`. |
| `testudoSetNetworkFilters` | `{filters}` | Sets up to 64 safe-key scalar filter values; errors if no provider is active. |
| `testudoSetGuestCapability` | `{protocol:1,guestEmbedToken,expiresAt,packageId,packageVersionId}` | Stores a short-lived, package-bound guest capability for artifact loading and GeoAI. |
| `testudoLoadPackage` | `{bootstrap,transport?}` | Loads the package manifests and listed chunks; returns package/version identity and playback availability. |
| `testudoGetPlaybackState` | none | Active shared playback provider state. |
| `testudoSetPlaybackPlaying` | `{playing:boolean}` | Starts or pauses playback. |
| `testudoSeekPlayback` | `{tick}` | Seeks to a non-negative tick within the loaded range. |
| `testudoSetPlaybackSpeed` | `{speed}` | Sets speed within the shared playback bounds. |
| `testudoRestartPlayback` | none | Stops and returns to tick zero. |
| `testudoGetProgressState` | none | Measured package chunk and byte progress. |
| `testudoGetScenarioState` | none | Loaded package scenarios, selected scenario, and replication. |
| `testudoSelectScenario` | `{scenarioId,replicationId?}` | Selects a scenario declared by the native package manifest; the selected ID is included as `viewer_context.active_scenario_id` on the next GeoAI request. |
| `testudoGetGeoAiStatus` | none | Testudo credential configuration; `providerReady` is `null` until the gateway request. |
| `testudoGetOllayaScenarioStatus` | none | Reports that Testudo's gateway evaluates typed scenario matching per request. |
| `testudoOpenGeoAiChat` | `{open:boolean}` | Opens or closes the GeoAI panel. |
| `testudoRequestInvestigation` | `{question,activeScenarioId?}` | Sends the question with the exact package/version binding and available map bounds. When GeoLibre has a selected scenario, the host must send the same ID as `activeScenarioId`; stale or missing IDs are rejected. The matching ID is forwarded as `viewer_context.active_scenario_id`. Returns `{accepted:true,requestId}` and later emits an investigation event. |

Playback uses provider arbitration through GeoLibre's shared-feature API. An available package playback provider has priority over route animation; if package playback is unavailable, route animation remains the active fallback. Provider teardown removes only its own registration and restores the remaining provider. Scenario, map-control, view-mode, network-filter, progress, and playback state all use the same shared-feature registry.

## Events

Events use `v:2` and `source:"geolibre-testudo-plugin"` and are sent to the established host origin:

- `testudoPlaybackChanged`: active playback snapshot.
- `testudoProgressChanged`: measured progress snapshot (`stage`, chunk counts, byte counts when known, and normalized `value`).
- `testudoScenarioChanged`: available scenarios and the selected scenario/replication.
- `testudoMapControlChanged`, `testudoViewModeChanged`, `testudoNetworkFiltersChanged`: respective shared-feature snapshots when providers exist.
- `testudoGeoAiInvestigationUpdate`: `{requestId,question,status:"complete",summary}` or `{requestId,question,status:"error",error}`.

The host may receive state events from the native `geolibre` channel independently. It should route each channel by `source` and use its own request map and challenge for this plugin channel.
