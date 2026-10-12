import type * as duckdb from "@duckdb/duckdb-wasm";
import { getDatabase, registerParquetCatalogEntry, type CatalogEntry } from "./network-kpi-parquet-data";
import { computeNoiseSource, type EmissionsRow } from "./emissions-h3-data";
export type { EmissionsRow } from "./emissions-h3-data";
export { loadEmissionsH3Geometry } from "./emissions-h3-geometry";
import { createNetworkKpiHttpSource, createNetworkKpiDirectorySource, fetchNetworkKpiManifestJson, readLocalNetworkKpiManifestJson, loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiPackageSource, type NetworkKpiDirectoryHandle, type NetworkKpiGeometry, type NetworkKpiManifest } from "./network-kpi-data";
import { openTestudoDatasetProvider, type TestudoDatasetProvider, type TestudoDatasetSource } from "./testudo-dataset-provider";
import { commitEmissionsLoadIfCurrent, readEmissionsRowsFromProvider } from "./emissions-h3-provider-reader";

export { commitEmissionsLoadIfCurrent, readEmissionsRowsFromProvider } from "./emissions-h3-provider-reader";

export { energyWeightedDb } from "./emissions-h3-aggregation";
export { createNetworkKpiHttpSource, createNetworkKpiDirectorySource, fetchNetworkKpiManifestJson, readLocalNetworkKpiManifestJson, loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiDirectoryHandle, type NetworkKpiPackageSource };
export { computeNoiseSource };
export interface EmissionsResults { rows: Map<string, EmissionsRow>; intervals: number[]; dids: number[]; did: number; }
export interface EmissionsPackage { geometry: NetworkKpiGeometry; manifest: NetworkKpiManifest; results: EmissionsResults; }
export type Opened = { db: duckdb.AsyncDuckDB; source: NetworkKpiPackageSource; catalog: CatalogEntry[]; registered: string[]; hasMicroscopicColumns?: boolean; hasEmissions?: boolean };
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

export async function openEmissionsDatasetProvider(
  source: TestudoDatasetSource,
  manifest: unknown,
): Promise<TestudoDatasetProvider> {
  return openTestudoDatasetProvider({ source, manifest });
}
async function openCatalog(source: NetworkKpiPackageSource, catalogPath: string): Promise<Opened> {
  const raw = JSON.parse(new TextDecoder().decode(await source.read(catalogPath))) as { files?: CatalogEntry[] } | CatalogEntry[];
  const catalog = Array.isArray(raw) ? raw : raw.files ?? [];
  const db = await getDatabase();
  return { db, source, catalog, registered: [] };
}
function didOf(e: CatalogEntry): number { return Number(e.did ?? String(e.partition ?? "").match(/did=([^/]+)/)?.[1]); }
async function tableSql(opened: Opened, did: number, tables: string[]): Promise<string> {
  const entries = opened.catalog.filter(e => didOf(e) === did && tables.includes(e.table ?? "MISECT") && typeof e.path === "string");
  const byTable = new Map<string, string[]>();
  for (const e of entries) { const h = await registerParquetCatalogEntry(opened.db, opened.source, e, "__emissions"); opened.registered.push(h); const t=e.table??"MISECT"; byTable.set(t,[...(byTable.get(t)??[]),h]); }
  return [...byTable].map(([, files]) => `SELECT * FROM read_parquet([${files.map(quote).join(",")}])`).join(" UNION ALL ");
}
