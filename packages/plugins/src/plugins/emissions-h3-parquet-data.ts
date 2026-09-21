import type * as duckdb from "@duckdb/duckdb-wasm";
import { getDatabase, registerParquetCatalogEntry, type CatalogEntry } from "./network-kpi-parquet-data";
import { computeNoiseSource, type EmissionsRow } from "./emissions-h3-data";
export type { EmissionsRow } from "./emissions-h3-data";
import { createNetworkKpiHttpSource, createNetworkKpiDirectorySource, fetchNetworkKpiManifestJson, readLocalNetworkKpiManifestJson, loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiPackageSource, type NetworkKpiDirectoryHandle, type NetworkKpiGeometry, type NetworkKpiManifest } from "./network-kpi-data";
import { openTestudoDatasetProvider, type TestudoDatasetProvider, type TestudoDatasetSource } from "./testudo-dataset-provider";

export { energyWeightedDb } from "./emissions-h3-aggregation";
export { createNetworkKpiHttpSource, createNetworkKpiDirectorySource, fetchNetworkKpiManifestJson, readLocalNetworkKpiManifestJson, loadNetworkKpiGeometry, parseNetworkKpiManifest, type NetworkKpiDirectoryHandle, type NetworkKpiPackageSource };
export { computeNoiseSource };
export interface EmissionsResults { rows: Map<string, EmissionsRow>; intervals: number[]; dids: number[]; did: number; }
export interface EmissionsPackage { geometry: NetworkKpiGeometry; manifest: NetworkKpiManifest; results: EmissionsResults; }
type Row = Record<string, unknown>;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const asRows = (r: { toArray(): Array<{ toJSON?: () => Row } & Row> }) => r.toArray().map(x => x.toJSON ? x.toJSON() : x);
export type Opened = { db: duckdb.AsyncDuckDB; source: NetworkKpiPackageSource; catalog: CatalogEntry[]; registered: string[]; hasMicroscopicColumns?: boolean; hasEmissions?: boolean };

export async function openEmissionsDatasetProvider(
  source: TestudoDatasetSource,
  manifest: unknown,
): Promise<TestudoDatasetProvider> {
  return openTestudoDatasetProvider({ source, manifest });
}

function rowNumber(row: Row, key: string): number | null {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function rowKey(row: Row): string {
  return `${Number(row.oid)}:${Number(row.eid)}`;
}

function contractEmissionTables(provider: TestudoDatasetProvider, did: number): string[] {
  const emissions = provider.metadata.dataContracts.emissions;
  if (!emissions || typeof emissions !== "object") return ["MIPTPO", "MISECTIEM"];
  const tableSelection = (emissions as Record<string, unknown>).table_selection;
  if (!tableSelection || typeof tableSelection !== "object") return ["MIPTPO", "MISECTIEM"];
  const perDid = (tableSelection as Record<string, unknown>).per_did;
  if (!Array.isArray(perDid)) return ["MIPTPO", "MISECTIEM"];
  const selected = perDid.find((entry) => entry && typeof entry === "object" && Number((entry as Record<string, unknown>).did) === did);
  const selectedTable = selected && typeof selected === "object" ? (selected as Record<string, unknown>).selected_table : null;
  return selectedTable === "MIPTPO" || selectedTable === "MISECTIEM" ? [selectedTable] : [];
}

/**
 * A replication whose MISECT partition has zero rows is a real, observed
 * case (the exporter still writes an empty file for a replication that
 * never produced section results) and would otherwise become the silent
 * default whenever it sorts first numerically, leaving the panel fully
 * loaded (scenario/replication pickers populated, no error) but with
 * nothing to draw. `TestudoDatasetMetadata` carries no per-did row counts
 * (unlike the raw Parquet `catalog.json` shape `pickDefaultDid` in
 * parquet-catalog.ts reads), so this checks candidate dids in order with a
 * cheap, bounded existence query and prefers the first with any rows.
 */
async function pickDidWithMisectRows(
  provider: TestudoDatasetProvider,
  dids: number[],
  scenarioId?: string | number,
): Promise<number> {
  for (const did of dids) {
    try {
      const probe = await provider.query({ dataset: "MISECT", did, scenarioId, columns: ["oid"], limit: 1 });
      if (probe.rows.length > 0) return did;
    } catch {
      // An unqueryable did is treated the same as an empty one; keep scanning.
    }
  }
  return dids[0] ?? Number.NaN;
}

/** Query environment rows through the shared package provider. */
export async function readEmissionsRowsFromProvider(
  provider: TestudoDatasetProvider,
  requestedDid: number,
  requestedInterval: number,
  scenarioId?: string | number,
): Promise<{ rows: EmissionsRow[]; intervals: number[]; dids: number[]; did: number; ents: number[]; hasMicroscopicColumns: boolean; hasEmissions: boolean }> {
  const metadata = provider.describe();
  const scenario = scenarioId === undefined ? undefined : metadata.scenarios.find((item) => String(item.scid) === String(scenarioId));
  const scopedDids = scenario?.replications.map((replication) => replication.did) ?? [];
  const dids = [...new Set(scopedDids.length ? scopedDids : metadata.datasets.flatMap((dataset) => dataset.dids))].sort((a, b) => a - b);
  const did = dids.includes(requestedDid) ? requestedDid : await pickDidWithMisectRows(provider, dids, scenarioId);
  const base = { dataset: "MISECT", did, limit: 250_000 } as const;
  const intervalRows = await provider.query({ ...base, scenarioId, distinct: true, columns: ["ent"] });
  if (intervalRows.truncated) throw new Error("Environment interval discovery exceeded its bounded query limit.");
  const ents = [...new Set(intervalRows.rows.map((row) => rowNumber(row, "ent")).filter((value): value is number => value !== null))].sort((a, b) => a - b);
  const ent = ents.includes(requestedInterval) ? requestedInterval : (ents.includes(0) ? 0 : (ents[0] ?? 0));
  let result;
  let hasMicroscopicColumns = true;
  try {
    result = await provider.query({
      ...base,
      scenarioId,
      columns: ["oid", "eid", "sid", "ent", "flow", "speed", "nstops"],
      filters: [{ column: "ent", op: "=", value: ent }],
    });
  } catch {
    hasMicroscopicColumns = false;
    result = await provider.query({
      ...base,
      scenarioId,
      columns: ["oid", "eid", "sid", "ent"],
      filters: [{ column: "ent", op: "=", value: ent }],
    });
  }
  if (result.truncated) throw new Error("Environment result query exceeded its bounded query limit.");
  const byKey = new Map<string, { aggregate?: Row; classes: Row[] }>();
  for (const row of result.rows) {
    const group = byKey.get(rowKey(row)) ?? { classes: [] };
    if (rowNumber(row, "sid") === 0) group.aggregate = row;
    else group.classes.push(row);
    byKey.set(rowKey(row), group);
  }
  const emissionValues = new Map<string, { co2: number | null; nox: number | null }>();
  for (const table of contractEmissionTables(provider, did)) {
    try {
      const emissionResult = await provider.query({
        dataset: table,
        did,
        scenarioId,
        columns: ["oid", "eid", "sid", "ent", "CO2", "NOx"],
        filters: [{ column: "ent", op: "=", value: ent }, { column: "sid", op: "=", value: 0 }],
        limit: 250_000,
      });
      for (const row of emissionResult.rows) {
        const co2 = row.CO2 === null || row.CO2 === undefined || row.CO2 === "" ? null : Number(row.CO2);
        const nox = row.NOx === null || row.NOx === undefined || row.NOx === "" ? null : Number(row.NOx);
        if (Number.isFinite(co2) || Number.isFinite(nox)) emissionValues.set(rowKey(row), { co2: Number.isFinite(co2) ? co2 : null, nox: Number.isFinite(nox) ? nox : null });
      }
      if (emissionResult.truncated) throw new Error("Environment emissions query exceeded its bounded query limit.");
      if (emissionValues.size) break;
    } catch (error) {
      // The contract-selected table may be absent from a legacy sidecar; keep
      // the plugin usable when the authoritative SQLite fallback has it.
      if (error instanceof Error && error.message.includes("bounded query limit")) throw error;
    }
  }
  const heavySids = new Set<number>();
  try {
    const meta = await provider.query({ dataset: "META_SUB_INFO", columns: ["pos", "oname"], distinct: true, limit: 250_000 });
    for (const row of meta.rows) {
      if (String(row.oname ?? "").toUpperCase().includes("HGV")) {
        const sid = rowNumber(row, "pos");
        if (sid !== null && sid > 0) heavySids.add(sid);
      }
    }
  } catch {
    // Vehicle-class labels are optional; the contract warning remains visible.
  }
  const rows = [...byKey.entries()].map(([key, group]) => {
    const aggregate = group.aggregate;
    const classRows = group.classes;
    const flow = Number(aggregate?.flow ?? classRows.reduce((sum, row) => sum + (Number(row.flow) || 0), 0)) || 0;
    const speed = aggregate?.speed == null
      ? (classRows.length ? classRows.reduce((sum, row) => sum + (Number(row.flow) || 0) * (Number(row.speed) || 0), 0) / Math.max(flow, 1e-9) : null)
      : Number(aggregate.speed);
    const stops = Number(aggregate?.nstops ?? classRows.reduce((sum, row) => sum + (Number(row.nstops) || 0), 0)) || 0;
    const heavyFlow = classRows.filter((row) => heavySids.has(rowNumber(row, "sid") ?? -1)).reduce((sum, row) => sum + (Number(row.flow) || 0), 0);
    const [oid, eid] = key.split(":").map(Number);
    const emission = emissionValues.get(key) ?? { co2: null, nox: null };
    return { oid, eid, ent, noise: computeNoiseSource(flow, speed, stops, 0, 0, heavyFlow, 0, 0), co2: emission.co2, nox: emission.nox } as EmissionsRow;
  });
  return { rows, intervals: ents, dids, did, ents, hasMicroscopicColumns, hasEmissions: emissionValues.size > 0 };
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
