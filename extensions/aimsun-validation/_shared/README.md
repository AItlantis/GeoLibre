# _shared: DuckDB + validation helpers for the Aimsun plugins

Plugins import from `src/browser.ts` and are bundled with `scripts/build-lib.mjs`
(`bundlePlugin({entry, outfile})`) into ONE self-contained ES module.

```ts
import { getDuckDbInline, loadPackage, installViews, scatterSvg, regressionStats } from "../_shared/src/browser";
const h = await getDuckDbInline();                       // shared singleton (Symbol.for global)
await loadPackage(h, manifestUrl, { requiredTables: ["detectors_sim", "detectors_obs"] });
await installViews(h, { only: ["det"], bucketMinutes: 60 });   // views bind tables at creation
const rows = await h.query("SELECT * FROM v_det_validation");
```

Build step for the deployer: `copyDuckDbWasm("apps/geolibre-desktop/public/plugins")` puts
`duckdb-eh.wasm` at `public/plugins/_shared/duckdb/duckdb-eh.wasm` (no `plugin.json`, so the
bundled-plugins scanner ignores the folder; it is served as a static file).

## Blob-module constraints (verified in headless Chrome under a Tauri-like CSP, `npm run build:smoke` + `node smoke/run-chrome.mjs`)

- The entry is `import()`ed from a `blob:` URL: no usable `import.meta.url`, no relative or bare
  imports, no code splitting. Everything JS is bundled (~1 MB incl. the DuckDB JS API + inlined worker).
- Worker: `duckdb-browser-eh.worker.js` (~770 KB classic script) is inlined as a string and started
  from a `blob:` URL. CSP has `worker-src blob: 'self'`: OK.
- wasm (`duckdb-eh.wasm`, 36 MB) is NOT inlined: the host rejects entries > 50 MB
  (`MAX_PLUGIN_ASSET_BYTES`) and base64 (48 MB) x 7 plugins is untenable. It is fetched at run time from
  `<app>/plugins/_shared/duckdb/duckdb-eh.wasm`, then falls back to jsDelivr (pinned 1.33.1-dev57.0;
  needs network). `connect-src 'self' ... https:` and `'wasm-unsafe-eval'` already cover both.
- eh bundle only (the pthread/coi build needs cross-origin isolation, which the app lacks).
- `resolvePluginAssetUrl` (host API) cannot escape the plugin folder, so the shared wasm uses an
  app-origin-relative URL (`document.baseURI`) instead; pass `wasmUrl` to override.
- Not verified: inside the real Tauri webview (different origin scheme) and with a real parquet
  package (`loadPackage` is only unit-tested for manifest validation).

## Table contract (workstream A must emit)

`od_before/od_after(origin,destination,trips)`, `centroids(id,name,grp,lon,lat)` (EPSG:4326),
`detectors_sim(oid,eid,t_start_min,dur_min,flow)`, `detectors_obs(detector_id,t_start_min,dur_min,flow)`.
Join: `detectors_sim.eid = detectors_obs.detector_id`. See header of `src/sql/views.sql.ts`.

### Flow semantics (`flowKind`)

`flow` is an HOURLY RATE (veh/h) by default, for both sides: the observed pattern files are rates on a
5-minute grid, and simulated MADET `flow` is a veh/h rate for a 1-hour interval (median sim/obs about 1.1
over the sim window). Hourly flow of a bucket is therefore the duration-weighted mean
`SUM(flow*dur_min)/SUM(dur_min)`. If a table instead holds vehicle COUNTS per interval, pass
`simFlowKind: "count"` / `obsFlowKind: "count"` to `buildViewsSql` (hourly flow = `SUM(flow)*60/SUM(dur_min)`).
TS twins: `hourlyFlow(flow, durMin, kind = "rate")`, `hourlyFlowOver(intervals, kind)`.
`eid` identifies one detector: on the real AMPK_3 / PMPK_3 data NO `eid` is shared by two `oid`s (verified in `real-data.test.ts`).
The 53 "extra" oids of the 3646 are simulated detectors whose `eid` is NULL / empty (51 carry flow in AMPK_3, 52 in PMPK_3): they cannot be
matched to an observed detector, so `v_det_validation` EXCLUDES them and `v_det_unmatched_sim(oid, flow, n_intervals)` /
`v_det_unmatched_sim_summary(n_oids, n_with_flow)` list them so panels can warn. The join stays on `eid`.

### Real extractor tables -> adapter (`src/sql/adapter.sql.ts`)

Register the parquet files as `detectors_sim_raw` / `detectors_obs_raw` and run `buildAdapterSql(opts)`, then
`buildViewsSql({ only: ["det"], ...ADAPTED_RELATIONS })` (reads `v_sim_norm` / `v_obs_norm`).
- `v_sim_norm(oid,eid,t_start_min,dur_min,flow)`: raw `(did,run,oid,eid,ent,sid,interval_start_s,duration_s,flow,volume)`,
  filtered to `sid = 0` (sid is the vehicle class; 0 = all vehicles; `simClass: null` keeps all), minutes = seconds/60.
- `v_obs_norm(detector_id,t_start_min,dur_min,flow)`: raw `(detector_id,ts,flow,source_file)`. `ts` labels the interval
  END (first stamp 00:05, last 00:00 next day) so `t_start_min = minutes(ts - 2025-01-01) - 5` (`obsTsLabel: "start"` to change);
  `dur_min = 5`; rows outside the reference day are dropped. validation and calibration files overlap on most detectors:
  rows are de-duplicated by `(detector_id, ts)` preferring validation (`obsPreference`), and `obsSource: "validation" |
  "calibration" | "both"` (default both) selects the file.

### Observed journey time: `v_sp_obs` (`src/sql/subpath.sql.ts`)

Table `subpath_obs_jt(route,direction_norm,ts,seconds,source)`. `v_sp_obs_day` = per route/dir/source/day/bucket mean
(bucket 15 min default, 60 for hourly); `v_sp_obs` = mean/median/min/max across days (`n_days`). Sources are never mixed.
UNVERIFIED UNIT: for `monthly_15min` the `seconds` column is the raw `Avg_traveltime`, unit not stated in the source.
Evidence it is seconds: 'Al Ain Road' monthly median 64 (IB 63.8, OB 63.9; 07:00 hour 71 IB / 64.5 OB) vs the subnetwork file's
`route_typical_duration_sum` (seconds) 86 IB / 84 OB overall (116 IB / 83 OB in the 07:00 hour): same order of magnitude, so
minutes (would be ~64 min) is implausible; but a +-25% difference between the two sources remains. Route lengths are not in
`subpaths.json` (sections only), so a speed plausibility check was not done. Confirm with the data owner.

## Tests

`npm test` (= `node --import tsx --test tests/*.test.ts`): metrics, SQL views against native DuckDB
(`@duckdb/node-api`; same SQL as wasm), manifest validation, chart SVG.
Also `adapter.test.ts` (hand-computed adapter/v_sp_obs) and `real-data.test.ts` (real AMPK_3/PMPK_3 parquet from `$AIMSUN_DATA_DIR`, NO default: skipped when unset; also checks GEH on hourly rates with m = sim / c = obs, %GEH<5, end-labelled obs `ts`,
partial-bucket exclusion, validation/calibration de-duplication and the eid-less detectors). `package-security.test.ts` covers manifest path
traversal (plain, `%2e%2e`, double-encoded, backslash, UNC, scheme) and the incremental SHA-256; `det-unmatched.test.ts` the eid-less views.

## Concurrency and manifest safety (shared API)

- `withDuckDbLock(fn)` (`src/lock.ts`, re-exported by `browser.ts`): ONE FIFO mutex for heavy operations on the shared DuckDB, keyed on
  `Symbol.for("aimsun.validation.duckdb.lock")`. The legacy detector key `Symbol.for("aimsun.validation.det.lock")` is an alias: every
  acquisition waits for both tails and publishes under both, so old detector bundles and new code exclude each other. Not re-entrant.
- Plugins must not share global DuckDB names: parquet files are registered under unique names (`registerTable` uses
  `pkg_<table>_<unique>.parquet` and drops it in a `finally`); OD controllers and subpath sessions each run in a private attached in-memory catalog
  on their own connection and drop/detach it on dispose.
- `resolveInsidePackage(base, rel)` / `isSafePackagePath(rel)` / `packageBaseUrl(manifestUrl)` (`src/package.ts`): every manifest path is resolved through
  this helper (rejects `..`, `%2e%2e`, `%252e`, backslashes, schemes, `//host`, absolute and control characters, then checks the resolved href
  starts with the manifest directory).
- `Sha256` / `sha256OfStream(stream)` (`src/sha256.ts`): incremental SHA-256 for files that must not be buffered (OD parquet, 17-35 MB, about 160 MB/s in V8).
