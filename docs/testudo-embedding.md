# Testudo native embedding

The `layout=testudo` profile embeds the native map and five traffic plugins in
the Testudo product shell. It removes desktop chrome and plugin source pickers;
the selected plugin retains its scenario, rendering and playback controls.
The existing Jupyter bridges and generic authoring API are disabled in this
profile. Only the exact same-origin parent in the deployment allowlist can use
the bounded Testudo commands.

The typed `@geolibre/embed` client adds `testudoLoadPackage`,
`testudoOpenLocalPackage`, `testudoSetGuestCapability`, `testudoSetPlugin`,
`testudoSetMode`, `testudoOpenGeoAiChat`, `testudoSetPreset`, `testudoGetState`, and the
`testudoStateChanged` event. See
`packages/embed/src/testudo.ts` for DTOs. Parent origins are exact entries in
`VITE_GEOLIBRE_EMBED_ORIGINS`; the iframe announces a cryptographic 128-bit
challenge, and every command carries that challenge. The child checks
`event.source === window.parent`, the exact allowlisted parent origin, command
type and challenge. The host must check the iframe source and exact app origin.

GeoAI chat is a persistent assistant panel, independent of the selected map
plugin and demo mode. Map selection remains in `selectedPlugin`; opening or
closing GeoAI uses `testudoOpenGeoAiChat({ open: boolean })` and does not alter
the selected plugin or mode. `assistantOpen` is included in acknowledgements,
`testudoGetState`, and `testudoStateChanged`, including when the user closes the
panel inside the iframe. This command accepts only the challenge and boolean
`open` field. Prompts and credentials stay inside the iframe and are never sent
through this parent bridge. Package changes and iframe teardown close the panel
and clear its in-memory GeoAI session; mode changes leave an open panel in place.

The native chat panel sends prompts directly to Testudo's authenticated chat
routes from inside the iframe. Signed-in sessions use
`POST /api/v1/ai/chat` with the principal bearer and the platform package and
accepted version UUIDs. Public demos use
`POST /api/public/demo/geoai-chat` with the in-memory `Testudo-Embed`
credential; the server derives the demo scope from that credential. Both send
only bounded viewer context. Guest requests may include up to ten prior chat
turns; the current prompt is sent once. Credentials and prompts do not pass
through the parent bridge. Ollama and optional Ollaya provider calls remain
server-side, and any proposed actions continue through the existing approval
flow. The public demo bootstrap must advertise GeoAI as available for its
capability-guarded button to appear.

For anonymous public demos, the host obtains a short-lived guest capability
from its server and sends it only in `testudoSetGuestCapability` after the
challenge. The native viewer keeps it in memory and uses exactly
`Authorization: Testudo-Embed <token>` for scoped VDS and bytes reads. The
subsequent `testudoLoadPackage` carries the unchanged canonical bootstrap and
challenge, never the token. Guest capability is scoped to the immutable London
demo package/version and is read-only. A refreshed capability can replace it
in memory using the same command and challenge; the host must never ask the
iframe to mint one. Tokens never enter URLs, storage, package state, events or
logs. Presets use an explicit option allowlist; the server-declared capability
and preset arrays are retained as-is, so all package-approved native modes
remain available.

The native Testudo overlay presents Animation, Flow, Paths and Density as
package-backed selectors. Each selector sends only the `testudoSetMode` enum;
the child checks it against modes derived from that package's declared
capabilities and data. Animation requires an available animation capability
and a playable animation manifest or root chunk catalog. A root chunk stream is
represented once at package scope, without attributing it to one of several
result scenarios. Flow and Density require the corresponding declared result
ramp/column, and Paths requires the package's paths capability plus path index.
For London, the published metadata declares all four data families (with
Animation backed by the root chunk catalog); the package does not currently
declare separate presets or viewmodes.

Account-authenticated published artifacts use VDS descriptors followed by
signed byte URLs from configured byte origins. Guest published artifacts use
credential-free, queryless byte URLs and the custom Testudo-Embed authorization
header at both services. `testudo-source.ts` deliberately supplies
`baseUrl:null` so DuckDB reads buffers through this source instead of making
uncredentialed HTTP requests itself. Each read has a 60-second deadline and
refreshes an expired signature once. The read-only directory adapter reuses the
native loaders without duplicating their manifest/scenario logic. Their new
optional directory argument preserves existing standalone picker behavior.

Local packages use one user-initiated folder picker inside the iframe. The same
handle is reused for all plugins. No upload occurs. Chrome/Edge folder access is
required; `.ang` models must first become render packages. Environment and
comparison availability depends on dataset metadata, not merely plugin presence.
The host invokes the picker's typed `testudoOpenLocalPackage()` command; it takes
no package path or handle from the host. The child still validates the caller's
source, exact allowlisted origin and challenge before presenting its own picker.
Call it directly from the host button's click handler so the browser's transient
user activation is available. Canceling the picker leaves the current package
state unchanged.

Scenario impact answers may include separate package facts, calculated severity/worsening rankings,
and likely scenario candidates. Candidate scores are labeled as model match scores. A typed viewer
action is accepted only when its package version matches the active bootstrap and its scenario ID
exists in the loaded package. GeoLibre then changes the scenario in memory, switches to the KPI
view, and highlights a section that exists in rendered package geometry. The independent GeoAI
panel stays open. Guest actions do not write package data or persist a selection.

Build the application artifact with explicit origins:

```powershell
$env:VITE_GEOLIBRE_EMBED_ORIGINS='https://app.testudo.live,https://www.testudo.live'
$env:VITE_TESTUDO_BYTE_ORIGINS='https://bytes.testudo.live'
node scripts/build-testudo.mjs --out-dir <temporary-output-directory>
```

The script typechecks and builds the requested output directory (defaults to
`apps/geolibre-desktop/dist-testudo`), including
the browser ESM `embed-client.js`, license and `testudo-build-manifest.json`.
It sets base `/geolibre-native/` and disables service workers. Serve the entire
artifact at that path with correct JavaScript/WASM MIME, same-origin/blob worker
support and WebAssembly-enabled CSP. Data stays on the signed-byte service.
Do not deploy an unverified partial build.

Both npm and pnpm lockfiles are tracked. The current checkout has the pnpm graph;
the manifest records both lock hashes and actual compiler/bundler versions.
Use the corresponding frozen lock when reproducing dependencies. A narrowly
scoped Vite transform changes cog-tiler-wasm's geokeys default import to a
namespace: the 2024 package provides both named/default exports, while 2026
provides named exports only; both expose the unchanged `toProj4` function.

Run targeted source/protocol/embed/layout tests and real browser package tests.
A successful acknowledgement means initialization completed; it does not prove
pixels painted. Exercise all five plugin renders and package/logout cleanup.
Buffering Parquet is intentional for authentication correctness; assess memory
and startup with representative packages before release.
