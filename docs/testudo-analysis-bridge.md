# Testudo "Analyse" bridge

The Testudo shell can open the three Aimsun validation drop-ins inside the
`layout=testudo` iframe: **Modelling Count Manager**, **Modelling OD Trips** and
**Modelling Journey Time**. This page is the contract between the Testudo host
and GeoLibre; the producer side is `PLAN_testudo_v2.md` (C3-C5). Analyse is a
host workflow state, not a network view mode: it never goes through
`testudoSetPlugin` / `testudoSetMode`.

## Capabilities (C3)

Three independent capability ids, each backed by one plugin:

| Capability | Plugin id |
|---|---|
| `analysis-counts` | `modelling-count-manager` |
| `analysis-od` | `modelling-od-trips` |
| `analysis-journey-time` | `modelling-journey-time` |

They are valid ids in `bootstrap.capabilities[]` and appear in
`TestudoViewerState.capabilities`. They are deliberately **not** feature
capabilities (`featureCapabilityIds`), map-plugin handlers, presets or default
plugins: loading a package never opens an Analyse plugin by itself. Local
folder packages report them unavailable.

## Bootstrap addition (C4)

`bootstrap.analysis` is optional; bootstraps without it validate unchanged.

```ts
analysis?: {
  schemaVersion: 1;
  baseUrl: string;                 // <byteOrigin>/api/v1/analysis-bytes/<versionId>/<token>/analysis/
                                   // absolute, trailing "/", https (http only for localhost), no credentials/query
  runs: Array<{ run: string; label: string; available: boolean; reason?: string;
                manifest: string;  // "<run>/analysis_manifest.json", relative to baseUrl: no scheme, no leading "/", no ".."
                capabilities?: { "analysis-counts": boolean; "analysis-od": boolean; "analysis-journey-time": boolean } }>;
  plugins: Partial<Record<"analysis-counts" | "analysis-od" | "analysis-journey-time",
                          { pluginId: <matching plugin id>; available: boolean; reason?: string }>>;
  expiresAt: number | string;      // integer epoch MILLISECONDS (UTC) or ISO-8601
}
```

`manifestUrl = baseUrl + manifest` and must start with the (normalised) `baseUrl`.

**Expiry units.** `expiresAt` is epoch milliseconds. A number below `1e11` (a seconds
timestamp is ~1.8e9, 1e11 ms is 1973) is rejected as ambiguous, never silently scaled:
the bootstrap fails with `Invalid Testudo package bootstrap: analysis.expiresAt must be
epoch milliseconds; <n> is below 100000000000 and looks like seconds.` ISO-8601 strings
are still accepted.

**Run capabilities.** `runs[].capabilities` is optional; when present it holds only the
three analysis ids with strict boolean values. An open is rejected when the run has
capabilities and the target plugin's flag is `false` (a missing key is not a rejection).

Any other shape makes the whole bootstrap invalid (`Invalid Testudo package bootstrap`).

## Commands (C5)

All three are bounded Testudo commands (parent origin, `v: 2`, per-session challenge
as for every other command; no credential-like keys). The typed client exposes
`testudoOpenAnalysis(payload)`, `testudoCloseAnalysis(payload)` and
`testudoRefreshAnalysisGrant(payload)`.

- `testudoOpenAnalysis { plugin, manifestUrl, run, generation }`
  - `plugin` is a plugin id (`modelling-*`), `manifestUrl` an absolute https
    URL (http only for localhost), `run` a non-empty string, `generation` a
    positive integer.
  - GeoLibre opens **only that plugin** through
    `PluginManager.openWithParams(pluginId, { aimsunPackage: manifestUrl, aimsunRun: run }, app)`:
    activate if needed, then call that plugin's `handleUrlParameters` and wait for it. The global
    URL-parameter loop (`handleUrlParameters`), which opens every plugin owning
    `aimsunPackage`, is never used.
  - `generation` is monotonic per plugin: a value `<=` the last accepted one is
    rejected as stale (`Stale analysis generation ...`). The counter survives
    `testudoCloseAnalysis` (a late open after a close stays rejected) and is reset
    by a package switch.
  - The request must match the loaded package's `analysis` block: it must exist
    and not be expired, the plugin's capability must be `available`, the run must
    be listed and `available` (and its `capabilities` flag for the plugin not `false`),
    and `manifestUrl` must be under the current `baseUrl` (so a URL carrying a
    superseded token is rejected after a refresh).
  - Not available to guest sessions, nor while a package is loading.
- `testudoRefreshAnalysisGrant { baseUrl, expiresAt }` swaps the authorization of the
  loaded package without resetting it. The host re-fetches a bootstrap before the grant
  expires and sends the new `baseUrl` (same shape, new token) and `expiresAt`. GeoLibre
  replaces its stored `baseUrl`/`expiresAt` only: open plugins stay open, generations
  and the selected tab are untouched. It is accepted only for the same loaded package
  and only when the new `baseUrl` has the same origin and the same
  `/api/v1/analysis-bytes/<versionId>/<token>/analysis/` shape with the same
  `<versionId>` and a different (or equal) `<token>` segment; `expiresAt` must be a valid,
  not yet expired millisecond (or ISO) value. Anything else leaves the grant unchanged and
  replies `status: "error"`. The host then opens further runs with manifest URLs under the
  new base. Not available to guests nor while a package is loading.
- `testudoCloseAnalysis { plugin }` deactivates that plugin (teardown). Package
  load, package switch, `testudoDestroyTView` and iframe unmount close every open
  Analyse plugin as well. A close that arrives while an open is still loading wins.

Replies: the ack result is a `TestudoAnalysisStatus`, and the same object is emitted as
the `testudoAnalysisStatus` event.

| Command | Reply |
|---|---|
| open | `{ plugin, status: "open", run, generation }` once the package finished loading |
| close | `{ plugin, status: "closed" }` |
| refresh | `{ status: "refreshed", expiresAt }` (epoch ms), or `{ status: "error", error }` as the ack result (`ok: true`) and as an event; no `plugin` |

A failed open acks `ok: false` with the error text and emits `{ plugin, status: "error",
run, generation, error }` (stale rejections reject the command without an event).

**Load semantics.** Each of the three plugins' `handleUrlParameters` resolves `true` only
when the package finished loading, and rejects with the load error message when loading
failed (a manifest that 404s, is malformed, has no usable run, ...). `PluginManager.openWithParams`
returns `{ ok: boolean; error?: string }` (a handler resolving `false`, throwing, an unknown
plugin or a refused activation is `ok: false`; a handler resolving nothing is `ok`, for
legacy plugins). The bridge answers `status: "open"` only after `ok: true`; otherwise it
deactivates the half-open plugin and answers `status: "error"` with the plugin's message.
The global URL-parameter loop still ignores the returned value.
The host opens one Analyse plugin at a time by sending `testudoCloseAnalysis` for
the previous one; GeoLibre does not close siblings implicitly.

Plugin ids are not in `TESTUDO_BLOCKED_PLUGIN_IDS`, so they run in the Testudo
layout.

## Build: plugins and the DuckDB wasm

`layout=testudo` builds use the same bundled drop-in discovery as every build
(`vite-plugins/bundled-plugins.ts` scans `apps/geolibre-desktop/public/plugins/<id>/plugin.json`
at Vite start). `node scripts/build-testudo.mjs` now, before `vite build`:

1. checks that the three plugin bundles exist and rebuilds a missing one from
   `extensions/aimsun-validation/<id>/build.mjs` (`--rebuild-plugins` rebuilds all
   three; the output can differ byte-wise from the committed bundle depending on the
   local esbuild version);
2. provisions `public/plugins/_shared/duckdb/duckdb-eh.wasm` (git-ignored, ~36 MB)
   through `copyDuckDbWasm` from `extensions/aimsun-validation/_shared/scripts/build-lib.mjs`
   and verifies it byte for byte against the installed `@duckdb/duckdb-wasm`;
3. records the plugin entry hashes and the wasm hash in `testudo-build-manifest.json`
   under `analysis`.

**Offline operation (no jsDelivr) requires that wasm.** The plugins load the engine
from `<app>/plugins/_shared/duckdb/duckdb-eh.wasm` and only fall back to jsDelivr
when it is absent. A build made without step 2 still works online but fails
offline. Do not commit the wasm. For a non-Testudo build, run the three
`node build.mjs` scripts (the last one provisions the wasm) before `npm run build`.
