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
| `testudoSetGuestCapability` | `{ protocol: 1, guestEmbedToken, expiresAt }` | `{ accepted: true, expiresAt }` |
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
`testudoGetPlaybackState`. Scenario selection and map/camera commands address a
specific `tviewId`; selection does not mutate a comparison's other view.

`testudoStateChanged`, `testudoPlaybackChanged`, and `testudoGeoAIRequest` are
typed embed events. Progress is reported from real loader byte counters as
`{ label, value, loaded, total }`, with `value` derived from `loaded / total`.
Invalid progress fails the provider load rather than producing a synthetic fraction.

## Credentials and GeoAI

The child accepts `testudoSetGuestCapability` into memory and keeps the value
out of package state, events, URLs, browser storage, and GeoAI requests. The
provider receives a `getArtifactAuthorizationHeader()` callback only for
authenticated package artifact fetches. Expired or cleared capabilities return
`null`, and the iframe clears its copy when its embed session ends. The host
retains its own in-memory capability for its separate Gateway GeoAI request.

`testudoGeoAIRequest` includes `requestId`, `messages`, and full context with
package/version/plugin/scenario, `tviewId`, and `generation`. The host validates
that context before calling Gateway, then rechecks the current TView generation
and package version before delivery. Its reply contains only
`{ requestId, tviewId, generation, content? | error? }`; the child resolves
that tuple against the exact pending request and its owning plugin session.
