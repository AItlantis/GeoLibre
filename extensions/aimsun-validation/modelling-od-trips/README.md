# Modelling OD Trips

One drop-in GeoLibre plugin for OD trip exploration, adjustment comparison, run comparison, generation/attraction balance, trip-length distributions, flow matrices, and adjustment differences. The package loader, `OdController`, private DuckDB catalog, cached `od_cell`, project state, and map overlay are shared by every view.

## Package rules

- `od_before` plus `od_after` and `centroids` enables **OD Trips**, **OD Before/After**, **OD Difference**, **Balance**, **Trip length**, and **Flow matrix**. **Comparison** is enabled when the package has multiple runs.
- One matrix (`od`, `od_before`, or `od_after`) plus `centroids` enables **OD Trips**, **Balance**, **Trip length**, and **Flow matrix**. The remaining modes show a disabled reason when their required data is missing.
- No matrix shows an empty/error state naming the missing table choices and `centroids`.
- Optional manifest `analysis: "adjustment" | "assignment"` adds a header hint. The table inventory determines the available views.
- Matrix rows use `origin_id`, `origin_name`, `destination_id`, `destination_name`, and `value`. Existing extractor matrices with `origin_id`, `destination_id`, and `value` remain supported.
- Manifest paths stay inside the package directory. Declared SHA-256 values are streamed and verified before data is registered.
- Run comparison reads each run in turn and restores the originally selected run after collecting bounded summaries, so it does not keep a second 4.4M-row `od_cell` table resident.
- Trip lengths are trip-weighted haversine straight-line distances; intrazonal pairs are excluded. The maximum-distance bin includes all longer trips.
- The Flow matrix shows at most the 30 highest-volume groups and folds the rest into **Other**. Selecting a matrix cell sets the OD scope and draws its group-to-group desire line.
- The collapsible Checks panel runs scalar DuckDB integrity queries on demand. It reports matrix totals and sums, grouped conservation, new/dropped flows, unknown centroid IDs, invalid values, and manifest hash state.
- Difference map classification supports Linear, Quantile, Jenks-Fisher, and Manual breaks. Jenks uses a deterministic sample capped at 2,000 values; the number of classes is 3–9. Volume can scale feature opacity as well as width or radius.

## Build and verify

From this directory:

```powershell
$env:AIMSUN_DATA_DIR = 'F:/repos/aimsun-validation-pkg/data'
npm test
npm run typecheck
node build.mjs
node smoke/run-chrome.mjs
```

`smoke/assignment-only/` is the tiny assignment package used by the browser smoke; `node smoke/create-assignment-fixture.mjs` recreates it. The browser smoke checks the real AMPK_3 totals, transitions between views without reloading, and verifies layer cleanup and assignment-only mode availability.
