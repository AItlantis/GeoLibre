import test from "node:test";
import assert from "node:assert/strict";
import { resolveDuckDbExtensionRepository } from "./duckdb-extension-repository";

test("resolves the DuckDB extension repository under the standalone app base", () => {
  assert.equal(
    resolveDuckDbExtensionRepository("/", "http://127.0.0.1:5173"),
    "http://127.0.0.1:5173/duckdb-extensions",
  );
});

test("resolves the DuckDB extension repository under Testudo's embedded base", () => {
  assert.equal(
    resolveDuckDbExtensionRepository("/geolibre-native/", "https://testudo.example"),
    "https://testudo.example/geolibre-native/duckdb-extensions",
  );
});

test("normalizes a base URL without a trailing slash", () => {
  assert.equal(
    resolveDuckDbExtensionRepository("/geolibre-native", "https://testudo.example"),
    "https://testudo.example/geolibre-native/duckdb-extensions",
  );
});
