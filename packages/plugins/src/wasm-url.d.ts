// Vite's `?url` suffix resolves a static asset import to its served URL string
// at build time, rather than inlining/bundling the asset itself — used here so
// sql.js's ~1.5 MB WASM binary is fetched on demand instead of bundled inline.
// Mirrors the app-level `*.geojson?url` declaration in
// apps/geolibre-desktop/src/vite-env.d.ts.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
declare module "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url" { const url: string; export default url; }
declare module "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url" { const url: string; export default url; }
