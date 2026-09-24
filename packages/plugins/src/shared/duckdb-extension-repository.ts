/** Build the pinned DuckDB extension repository URL for the current Vite base. */
export function resolveDuckDbExtensionRepository(baseUrl: string, origin: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("duckdb-extensions", new URL(normalizedBase, origin)).toString().replace(/\/$/, "");
}

export function getDuckDbExtensionRepository(): string {
  return resolveDuckDbExtensionRepository(import.meta.env.BASE_URL, window.location.origin);
}
