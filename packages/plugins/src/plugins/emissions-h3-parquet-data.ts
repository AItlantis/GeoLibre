import type * as duckdb from "@duckdb/duckdb-wasm";
import { getDatabase, registerParquetCatalogEntry, type CatalogEntry } from "./network-kpi-parquet-data";
import { computeNoiseSource, type EmissionsRow } from "./emissions-h3-data";
export type { EmissionsRow } from "./emissions-h3-data";
export { loadEmissionsH3Geometry } from "./emissions-h3-geometry";
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

/**
 * Load only the section centerlines required by the H3 renderer.
 *
 * The shared network geometry loader also fetches lanes, turns, and nodes for
 * Network KPI. H3 never consumes those layers; requesting them made a large
 * package (notably Abu Dhabi) wait on a multi-gigabyte turns asset before the
 * emissions layer could render.
 */
function rowNumber(row: Row, key: string): number | null {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function rowKey(row: Row): string {
  return `${Number(row.oid)}:${Number(row.eid)}`;
}

function contractEmissionTables(provider: TestudoDatasetProvider, did: number): string[] {
  const emissions = provider.metadata.dataContracts.emissions;
  const candidates: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const table = value.trim().toUpperCase();
    if ((table === "MIPTPO" || table === "MISECTIEM") && !candidates.includes(table)) candidates.push(table);
  };
  if (emissions && typeof emissions === "object") {
    const contract = emissions as Record<string, unknown>;
    add(contract.selected_table);
    add(contract.preferred_table);
    const fallbackOrder = contract.fallback_order;
    if (Array.isArray(fallbackOrder)) fallbackOrder.forEach(add);
    const tableSelection = contract.table_selection;
    if (tableSelection && typeof tableSelection === "object") {
      const selection = tableSelection as Record<string, unknown>;
      add(selection.selected_table);
      const perDid = selection.per_did;
      if (Array.isArray(perDid)) {
        const selected = perDid.find((entry) => entry && typeof entry === "object" && Number((entry as Record<string, unknown>).did) === did);
        if (selected && typeof selected === "object") add((selected as Record<string, unknown>).selected_table);
      }
    }
  }
  // The catalog is authoritative for newer packages, while older manifests
  // put the same selection under environment.data_contracts. Keep both
  // paths usable and only query tables actually declared by the provider.
  for (const dataset of provider.metadata.datasets) add(dataset.table);
  for (const fallback of ["MIPTPO", "MISECTIEM"]) add(fallback);
  return candidates;
}

function normalizedColumnName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function pickEmissionColumn(columns: string[], metric: "co2" | "nox"): string | null {
  const target = metric === "co2" ? "co2" : "nox";
  const exact = columns.find((column) => normalizedColumnName(column) === target);
  if (exact) return exact;
  // Accept exporter variants such as CO2_D, co2_emission, NOX, or
  // nox_interurban while avoiding unrelated pollutant columns.
  return columns.find((column) => {
    const normalized = normalizedColumnName(column);
    return normalized.startsWith(target) || normalized.includes(`${target}emission`) || normalized.includes(`${target}interurban`);
  }) ?? null;
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
    // Some microscopic exporters omit optional stop metrics while still
    // providing the flow/speed statistics required by this plugin. Do not
    // misclassify those packages as non-microscopic.
    try {
      result = await provider.query({
        ...base,
        scenarioId,
        columns: ["oid", "eid", "sid", "ent", "flow", "speed"],
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
      // Query the schema first when the package did not expose a complete
      // data-contract envelope. This also handles harmless casing/variant
      // differences without falling back to SQLite.
      const schema = await provider.query({ dataset: table, did, scenarioId, limit: 1 });
      const co2Column = pickEmissionColumn(schema.columns, "co2");
      const noxColumn = pickEmissionColumn(schema.columns, "nox");
      if (!co2Column && !noxColumn) continue;
      const emissionResult = await provider.query({
        dataset: table,
        did,
        scenarioId,
        columns: ["oid", "eid", "sid", "ent", ...(co2Column ? [co2Column] : []), ...(noxColumn ? [noxColumn] : [])],
        filters: [{ column: "ent", op: "=", value: ent }, { column: "sid", op: "=", value: 0 }],
        limit: 250_000,
      });
      for (const row of emissionResult.rows) {
        const co2Value = co2Column ? row[co2Column] : null;
        const noxValue = noxColumn ? row[noxColumn] : null;
        const co2 = co2Value === null || co2Value === undefined || co2Value === "" ? null : Number(co2Value);
        const nox = noxValue === null || noxValue === undefined || noxValue === "" ? null : Number(noxValue);
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
