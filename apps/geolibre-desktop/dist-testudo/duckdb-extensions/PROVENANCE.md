# Pinned Parquet extensions for Testudo

These are unmodified, signed DuckDB-Wasm Parquet extensions for the `v1.5.4`
DuckDB engine embedded in `@duckdb/duckdb-wasm` version `1.33.1-dev57.0`.
DuckDB-Wasm verifies the extension signature when it loads the binary.

| Target | Official source | SHA-256 of decompressed WASM |
| --- | --- | --- |
| `wasm_eh` | https://extensions.duckdb.org/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm | `4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95` |
| `wasm_mvp` | https://extensions.duckdb.org/v1.5.4/wasm_mvp/parquet.duckdb_extension.wasm | `b64c255a7f7d06cc234535b2f0ecab345fda91bffff5509d3179004bc13aa19a` |

Downloaded 2026-09-23 with `curl --compressed`, preserving the decompressed
WASM bytes. [DuckDB-Wasm's MIT license](LICENSE) accompanies these files.
The build script rejects changed extension hashes and an engine without
`v1.5.4`; update both together when upgrading DuckDB-Wasm.
