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
  baseUrl: string;                 // absolute, ends with "/", https (http only for localhost), no credentials/query
  runs: Array<{ run: string; label: string; available: boolean; reason?: string;
                manifest: string }>; // manifest is relative to baseUrl: no scheme, no leading "/", no ".."
  plugins: Partial<Record<"analysis-counts" | "analysis-od" | "analysis-journey-time",
                          { pluginId: <matching plugin id>; available: boolean; reason?: string }>>;
  expiresAt: number | string;      // epoch milliseconds or ISO-8601
}
```

Any other shape makes the whole bootstrap invalid (`Invalid Testudo package bootstrap`).

## Commands (C5)

Both are bounded Testudo commands (parent origin, `v: 2`, per-session challenge
as for every other command; no credential-like keys). The typed client exposes
`testudoOpenAnalysis(payload)` and `testudoCloseAnalysis(payload)`.

- `testudoOpenAnalysis { plugin, manifestUrl, run, generation }`
  - `plugin` is a plugin id (`modelling-*`), `manifestUrl` an absolute https
    URL (http only for localhost), `run` a non-empty string, `generation` a
    positive integer.
  - GeoLibre opens **only that plugin** through
    `PluginManager.openWithParams(pluginId, { aimsunPackage: manifestUrl, aimsunRun: run }, app)`:
    activate if needed, then call that plugin's `handleUrlParameters`. The global
    URL-parameter loop (`handleUrlParameters`), which opens every plugin owning
    `aimsunPackage`, is never used.
  - `generation` is monotonic per plugin: a value `<=` the last accepted one is
    rejected as stale (`Stale analysis generation ...`). The counter survives
    `testudoCloseAnalysis` (a late open after a close stays rejected) and is reset
    by a package switch.
  - The request must match the loaded package's `analysis` block: it must exist
    and not be expired, the plugin's capability must be `available`, the run must
    be listed and `available`, and `manifestUrl` must be under `baseUrl`.
  - Not available to guest sessions, nor while a package is loading.
- `testudoCloseAnalysis { plugin }` deactivates that plugin (teardown). Package
  load, package switch, `testudoDestroyTView` and iframe unmount close every open
  Analyse plugin as well. A close that arrives while an open is still loading wins.

Replies: the ack result is a `TestudoAnalysisStatus`
`{ plugin, status: "open" | "closed" | "error", run?, generation?, error? }`, and
the same object is emitted as the `testudoAnalysisStatus` event (including
`status: "error"` with the message when an open fails; stale rejections reject the
command without an event). A failed command acks `ok: false` with the error text.
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
