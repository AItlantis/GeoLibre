# Testudo native embedding

The `layout=testudo` profile embeds the native map and five traffic plugins in
the Testudo product shell. It removes desktop chrome and plugin source pickers;
the selected plugin retains its scenario, rendering and playback controls.
The existing Jupyter bridges and generic authoring API are disabled in this
profile. Only the exact same-origin parent in the deployment allowlist can use
the bounded Testudo commands.

The typed `@geolibre/embed` client adds `testudoLoadPackage`, `testudoSetPlugin`,
`testudoSetPreset`, `testudoGetState`, and the `testudoStateChanged` event. See
`packages/embed/src/testudo.ts` for DTOs. Tokens belong only to the transport
closure, never project settings, events or URLs. Presets use an explicit option
allowlist; unknown presets and options reject. Empty preset lists are valid.

Published artifacts use authenticated VDS descriptors, followed by signed byte
URLs from configured byte origins. `testudo-source.ts` deliberately supplies
`baseUrl:null` so DuckDB reads buffers through this source instead of making
uncredentialed HTTP requests itself. Each read has a 60-second deadline and
refreshes an expired signature once. The read-only directory adapter reuses the
native loaders without duplicating their manifest/scenario logic. Their new
optional directory argument preserves existing standalone picker behavior.

Local packages use one user-initiated folder picker inside the iframe. The same
handle is reused for all plugins. No upload occurs. Chrome/Edge folder access is
required; `.ang` models must first become render packages. Environment and
comparison availability depends on dataset metadata, not merely plugin presence.

Build the application artifact with explicit origins:

```powershell
$env:VITE_GEOLIBRE_EMBED_ORIGINS='https://app.testudo.live'
$env:VITE_TESTUDO_BYTE_ORIGINS='https://bytes.testudo.live'
node scripts/build-testudo.mjs
```

The script typechecks and builds `apps/geolibre-desktop/dist-testudo`, including
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
