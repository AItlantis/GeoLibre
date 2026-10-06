import type { FeatureCollection, Feature, LineString } from "geojson";
import type { TestudoFeatureContext, TestudoFeatureSession, TestudoPackageProgress, TestudoPlaybackState, TestudoScenario, TestudoMapHandle } from "../shared/testudo-feature-session";
import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "../testudo-feature-bridge";
import { registerTestudoPackageProvider } from "../testudo-provider-registry";
import { acquireTestudoResultsDb, discoverResultsSchema, type TestudoLoadSqlJs, type TestudoResultsDbLease, type TestudoResultsSqlDatabase } from "./testudo-results-database";

type Json = Record<string, unknown>;
type ResultCapability = "network-kpi" | "emissions-h3" | "scenario-comparison";
type MetricRow = { oid: string; value: number };
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
function playbackRange(root: Json, packageInfo: Json): { maxTick: number; dt: number } {
  const metadata = record(root.metadata);
  const time = record(packageInfo.time);
  const tickCount = finite(root.n_ticks) ?? finite(root.tick_count) ?? finite(metadata.n_ticks) ?? finite(time.intervalCount) ?? 1;
  const maxTick = finite(root.maxTick) ?? finite(root.max_tick) ?? tickCount - 1;
  return {
    maxTick: Math.max(0, Math.trunc(maxTick)),
    dt: Math.max(0.001, finite(root.dt) ?? finite(root.step_seconds) ?? finite(metadata.dt) ?? finite(time.dtSeconds) ?? 1),
  };
}
function seriesAt(values: unknown, tick: number): unknown {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values[Math.min(Math.max(0, Math.trunc(tick)), values.length - 1)];
}
const json = async (fetchArtifact: (ref: string) => Promise<ArrayBuffer>, path: string): Promise<Json> => {
  return record(JSON.parse(new TextDecoder().decode(await fetchArtifact(path))));
};
const scopedCapability = (id: ResultCapability, available: boolean, reason?: string) => ({ id, available, ...(reason ? { reason } : {}) });

function scenariosFrom(root: Json, packageInfo: Json): TestudoScenario[] {
  const source = Array.isArray(packageInfo.scenarios) ? packageInfo.scenarios : Array.isArray(root.scenarios) ? root.scenarios : [];
  const replications = Array.isArray(root.replications) ? root.replications : [];
  return source.flatMap((value, index) => {
    const row = record(value);
    const id = row.scid ?? row.id;
    if (typeof id !== "string" && typeof id !== "number") return [];
    const reps = Array.isArray(row.replications) ? row.replications : replications.filter((item) => String(record(item).scid ?? "") === String(id));
    return [{ id: String(id), label: String(row.scname ?? row.name ?? row.label ?? `Scenario ${index + 1}`), replications: reps.flatMap((item) => {
      const replication = record(item);
      const did = Number(replication.did ?? replication.id);
      return Number.isSafeInteger(did) ? [{ id: did, ...(typeof replication.didname === "string" ? { label: replication.didname } : {}) }] : [];
    }) }];
  });
}

function resultsPath(root: Json, packageInfo: Json): string | null {
  const environment = record(root.environment);
  const packageEnvironment = record(packageInfo.environment);
  const results = record(packageInfo.results);
  const value = environment.sqlite_relative ?? environment.sqlite_path ?? packageEnvironment.sqlite_relative ?? results.path;
  return typeof value === "string" && value.trim() ? value : null;
}

function selectedDid(scenarios: TestudoScenario[], scenarioId: string): number | null {
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (scenario) return scenario.replications?.[0]?.id ?? null;
  const replicationId = Number(scenarioId);
  return scenarios.some((item) => item.replications?.some((replication) => replication.id === replicationId)) ? replicationId : null;
}

function comparisonDids(scenarios: TestudoScenario[], selectedId: string): [number, number] | null {
  const selectedIndex = Math.max(0, scenarios.findIndex((scenario) => scenario.id === selectedId));
  if (scenarios.length >= 2) {
    const first = selectedDid(scenarios, selectedId);
    const second = selectedDid(scenarios, scenarios[(selectedIndex + 1) % scenarios.length]!.id);
    return first !== null && second !== null ? [first, second] : null;
  }
  const reps = scenarios[0]?.replications ?? [];
  return reps.length >= 2 ? [reps[0]!.id, reps[1]!.id] : null;
}

function queryMetrics(db: TestudoResultsSqlDatabase, dids: number[], tick: number, columns: Set<string>): MetricRow[] {
  if (!dids.length || !columns.has("did") || !columns.has("oid") || !columns.has("ent") || !columns.has("speed")) return [];
  const result = db.exec(`SELECT oid, AVG(speed) AS value FROM MISECT WHERE did IN (${dids.join(",")}) AND ent = ${Math.max(0, Math.trunc(tick))} AND speed IS NOT NULL GROUP BY oid`)[0];
  return (result?.values ?? []).flatMap((row) => {
    const oid = row[0]; const value = Number(row[1]);
    return (typeof oid === "string" || typeof oid === "number") && Number.isFinite(value) ? [{ oid: String(oid), value }] : [];
  });
}

function hasMetrics(db: TestudoResultsSqlDatabase, dids: number[], columns: Set<string>): boolean {
  if (!dids.length || !columns.has("did")) return false;
  const count = db.exec(`SELECT COUNT(*) AS count FROM MISECT WHERE did IN (${dids.join(",")})`)[0]?.values?.[0]?.[0];
  return Number(count) > 0;
}

function asSections(value: unknown): FeatureCollection<LineString> | null {
  const root = record(value);
  if (root.type !== "FeatureCollection" || !Array.isArray(root.features)) return null;
  return root as unknown as FeatureCollection<LineString>;
}

function sectionMetricFeatures(sections: FeatureCollection<LineString>, rows: MetricRow[], diverging = false): FeatureCollection<LineString> {
  const byOid = new Map(rows.map((row) => [row.oid, row.value]));
  const values = rows.map((row) => row.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const features = sections.features.flatMap((feature) => {
    const properties = record(feature.properties);
    // Testudo's network geometry section_id is the MISECT result object's oid.
    const sectionId = properties.section_id;
    if (typeof sectionId !== "number" && typeof sectionId !== "string") return [];
    const value = byOid.get(String(sectionId));
    if (value === undefined) return [];
    const normalized = max === min ? 0.5 : (value - min) / (max - min);
    const color = diverging
      ? value < 0 ? "#2563eb" : value > 0 ? "#dc2626" : "#f8fafc"
      : normalized < 0.5 ? "#2563eb" : "#dc2626";
    return [{ ...feature, properties: { ...properties, __testudoKpiColor: color, __testudoKpiValue: value } } as Feature<LineString>];
  });
  return { type: "FeatureCollection", features };
}

function createProvider(capability: ResultCapability, loadSqlJs: TestudoLoadSqlJs): TestudoFeatureProviderFactory {
  return {
    async open(bootstrap: TestudoPackageBootstrap, context: TestudoFeatureContext, onProgress: (progress: TestudoPackageProgress) => void,
      fetchArtifact: (ref: string) => Promise<ArrayBuffer>, map?: TestudoMapHandle | null): Promise<TestudoFeatureSession> {
      const root = await json(fetchArtifact, "manifest.json");
      let packageInfo: Json = {};
      try { packageInfo = await json(fetchArtifact, "geolibre/package.json"); } catch { /* Older packages keep this metadata in manifest.json. */ }
      const path = resultsPath(root, packageInfo);
      const { maxTick, dt } = playbackRange(root, packageInfo);
      const inlineKey = capability === "network-kpi" ? "kpiTimeSeries"
        : capability === "emissions-h3" ? "emissionsTimeSeries" : "comparisonTimeSeries";
      const inlineSeries = record(root[inlineKey]);
      const hasInlineSeries = Object.values(inlineSeries).some((series) => Array.isArray(series) && series.length > 0);
      const useInline = hasInlineSeries;
      const scenarios = scenariosFrom(root, packageInfo);
      let selectedScenarioId = scenarios[0]?.id ?? "";
      let currentTick = 0;
      let currentRows: MetricRow[] = [];
      let comparisonRows: [MetricRow[], MetricRow[]] = [[], []];
      let lease: TestudoResultsDbLease | null = null;
      let schema: ReturnType<typeof discoverResultsSchema> | null = null;
      let sections: FeatureCollection<LineString> | null = null;
      let owner: import("./testudo-package-renderer").TestudoLayerOwner | null = null;
      let disposed = false;
      let activated = false;
      let modeActive = false;
      const declaredCapability = bootstrap.capabilities?.find((item) => item.id === capability);
      let capabilityState = scopedCapability(capability, useInline || Boolean(path && declaredCapability?.available),
        useInline ? undefined : path && declaredCapability?.available
          ? "Declared by the package; detailed schema checks run when selected."
          : declaredCapability?.reason ?? "The package has no time-series data for this capability.");
      let layerVisible = true;
      const abortController = new AbortController();
      const namespace = `testudo-${context.tviewId}-${context.generation}-${capability}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const assertCurrent = (tviewId: string, generation: number) => {
        if (disposed || tviewId !== context.tviewId || generation !== context.generation) throw new Error("Results update belongs to a stale Testudo package generation.");
      };
      const getLease = async () => {
        if (lease) return lease;
        if (useInline) throw new Error("This capability uses manifest-declared inline time-series data.");
        if (!path) throw new Error("The package manifest does not declare a results SQLite artifact.");
        lease = await acquireTestudoResultsDb({ tviewId: context.tviewId, generation: context.generation, artifactPath: path,
          fetchArtifact, loadSqlJs, signal: abortController.signal });
        schema = discoverResultsSchema(lease.database);
        return lease;
      };
      const getOwner = async () => {
        if (!map) return null;
        if (!owner) {
          const renderer = await import("./testudo-package-renderer");
          if (!disposed) owner = renderer.createTestudoLayerOwner(map, namespace);
        }
        return owner;
      };
      const loadSections = async () => {
        if (sections) return sections;
        const geometry = record(root.geometry);
        const path = geometry.sections;
        if (typeof path !== "string") throw new Error("Network KPI geometry is unavailable because the manifest has no section geometry path.");
        const bytes = await fetchArtifact(path);
        if (disposed) throw new Error("Network geometry belongs to a stale package generation.");
        const decoded = path.endsWith(".gz")
          ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
          : bytes;
        sections = asSections(JSON.parse(new TextDecoder().decode(decoded)));
        if (!sections) throw new Error("The declared section geometry is not a GeoJSON FeatureCollection.");
        return sections;
      };
      const updateLayer = async () => {
        if (!modeActive || !capabilityState.available || !map) return;
        const target = await getOwner();
        if (!target || disposed) return;
        if (capability === "network-kpi" && sections) {
          const collection = sectionMetricFeatures(sections, currentRows);
          target.addGeoJson("network-kpi-sections", collection, "line", "__testudoKpiColor");
          target.setData("network-kpi-sections", collection);
          target.setVisible("network-kpi-sections", layerVisible);
          const values = currentRows.map((row) => row.value);
          target.setLegend("network-kpi", "Section speed", values.length ? String(Math.min(...values)) : "No data", "#2563eb", values.length ? String(Math.max(...values)) : "No data", "#dc2626");
        } else if (capability === "scenario-comparison" && sections) {
          const left = new Map(comparisonRows[0].map((row) => [row.oid, row.value]));
          const right = new Map(comparisonRows[1].map((row) => [row.oid, row.value]));
          const rows = [...left].flatMap(([oid, value]) => right.has(oid) ? [{ oid, value: value - right.get(oid)! }] : []);
          const collection = sectionMetricFeatures(sections, rows, true);
          target.addGeoJson("scenario-comparison", collection, "line", "__testudoKpiColor");
          target.setData("scenario-comparison", collection);
          target.setVisible("scenario-comparison", layerVisible);
          target.setLegend("scenario-comparison", "Speed difference", "Slower", "#2563eb", "Faster", "#dc2626");
        }
      };
      const updateData = async (tick: number) => {
        if (useInline) {
          capabilityState = scopedCapability(capability, true);
          return;
        }
        const activeLease = await getLease();
        if (disposed) return;
        const resultSchema = schema!;
        const sectionColumns = resultSchema.columns.get("MISECT");
        if (capability === "emissions-h3") {
          capabilityState = scopedCapability(capability, false,
            "The results database has no producer-declared H3 emissions table. Available emissions tables are section/interval based; H3 values and cell geometry cannot be derived safely.");
          return;
        }
        if (!resultSchema.tables.has("MISECT") || !sectionColumns || !["did", "oid", "ent", "speed"].every((column) => sectionColumns.has(column))) {
          capabilityState = scopedCapability(capability, false, "Results table MISECT is missing one or more required columns: did, oid, ent, speed.");
          return;
        }
        if (capability === "network-kpi") {
          const did = selectedDid(scenarios, selectedScenarioId);
          if (did === null) {
            capabilityState = scopedCapability(capability, false, "The selected scenario has no declared replication did.");
            return;
          }
          currentRows = queryMetrics(activeLease.database, [did], tick, sectionColumns);
          if (!hasMetrics(activeLease.database, [did], sectionColumns)) {
            capabilityState = scopedCapability(capability, false, `MISECT contains no rows for replication did ${did}.`);
            return;
          }
        } else {
          const dids = comparisonDids(scenarios, selectedScenarioId);
          if (!dids) {
            capabilityState = scopedCapability(capability, false, "Scenario comparison requires two declared scenarios or two replications with did values.");
            return;
          }
          const [firstDid, secondDid] = dids;
          comparisonRows = [queryMetrics(activeLease.database, [firstDid], tick, sectionColumns), queryMetrics(activeLease.database, [secondDid], tick, sectionColumns)];
          if (!hasMetrics(activeLease.database, [firstDid], sectionColumns) || !hasMetrics(activeLease.database, [secondDid], sectionColumns)) {
            capabilityState = scopedCapability(capability, false, `MISECT has no speed rows for both selected replications at interval ${tick}.`);
            return;
          }
        }
        capabilityState = scopedCapability(capability, true);
      };
      const session: TestudoFeatureSession = {
        context,
        get capabilities() { return [capabilityState]; },
        scenarios,
        get selectedScenarioId() { return selectedScenarioId; },
        playbackRange: { maxTick, dt },
        get timeSeriesAvailable() { return capabilityState.available; },
        async onActivate() {
          if (disposed) return;
          modeActive = true;
          if (activated) {
            if (capabilityState.available && !useInline && (capability === "network-kpi" || capability === "scenario-comparison")) await updateLayer();
            return;
          }
          activated = true;
          try {
            onProgress({ value: 0, loaded: 0, total: 0, label: useInline ? "Opening manifest time-series" : "Opening packaged results database" });
            await updateData(currentTick);
            if (capabilityState.available && !useInline && (capability === "network-kpi" || capability === "scenario-comparison")) {
              await loadSections();
              await updateLayer();
            }
            if (!disposed) onProgress({ value: 100, loaded: 0, total: 0, label: capabilityState.available ? "Results ready" : capabilityState.reason });
          } catch (error) {
            if (!disposed) capabilityState = scopedCapability(capability, false, error instanceof Error ? error.message : String(error));
          }
        },
        async onPlaybackTick(tviewId: string, generation: number, playback: TestudoPlaybackState) {
          assertCurrent(tviewId, generation);
          currentTick = Math.max(0, Math.trunc(playback.tick));
          if (useInline) { await updateData(currentTick); return; }
          if (!activated || !capabilityState.available) return;
          try {
            await updateData(currentTick);
            if (!useInline && capabilityState.available && (capability === "network-kpi" || capability === "scenario-comparison")) await updateLayer();
          }
          catch (error) { if (!disposed) capabilityState = scopedCapability(capability, false, error instanceof Error ? error.message : String(error)); }
        },
        getPlaybackValues() {
          if (useInline) {
            const values = Object.fromEntries(Object.entries(inlineSeries).map(([key, series]) => [key, seriesAt(series, currentTick)]));
            return { tick: currentTick, values };
          }
          if (!path && !capabilityState.available) return { tick: currentTick, values: undefined };
          if (capability === "network-kpi") {
            const values = currentRows.map((row) => row.value);
            return { tick: currentTick, metric: "speed", values: currentRows, legend: { low: "#2563eb", high: "#dc2626", min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null } };
          }
          if (capability === "scenario-comparison") return { tick: currentTick, metric: "speed difference", scenarioIds: [selectedScenarioId, scenarios[(scenarios.findIndex((item) => item.id === selectedScenarioId) + 1) % Math.max(1, scenarios.length)]?.id], values: comparisonRows, legend: { negative: "#2563eb", zero: "#f8fafc", positive: "#dc2626" } };
          return { tick: currentTick, values: [], legend: null };
        },
        getComparisonAtTick(ids) {
          if (useInline) {
            return { tick: currentTick, scenarioIds: ids, values: ids.map((id) => {
              const series = inlineSeries[id];
              return seriesAt(series, currentTick) ?? {};
            }) };
          }
          const db = lease?.database;
          const columns = schema?.columns.get("MISECT");
          if (!db || !columns) return { tick: currentTick, scenarioIds: ids, values: [] };
          const values = ids.map((id) => queryMetrics(db, [selectedDid(scenarios, id) ?? -1], currentTick, columns));
          return { tick: currentTick, scenarioIds: ids, values };
        },
        selectScenario(id) {
          if (!scenarios.some((scenario) => scenario.id === id)) throw new Error(`Scenario ${id} is not declared in this package.`);
          selectedScenarioId = id;
          if (activated && capabilityState.available) void updateData(currentTick).catch((error) => {
            if (!disposed) capabilityState = scopedCapability(capability, false, error instanceof Error ? error.message : String(error));
          });
          return id;
        },
        setKpiGeometry(geometry, visible) {
          if (geometry === "sections") { layerVisible = visible; owner?.setVisible(capability === "scenario-comparison" ? "scenario-comparison" : "network-kpi-sections", visible); }
          return { showLanes: false, showSections: layerVisible };
        },
        getKpiGeometryState() { return { showLanes: false, showSections: layerVisible }; },
        onDeactivate() { modeActive = false; owner?.remove(); owner = null; },
        async dispose() {
          if (disposed) return;
          disposed = true;
          abortController.abort();
          owner?.remove(); owner = null;
          sections = null; currentRows = []; comparisonRows = [[], []];
          lease?.release(); lease = null;
        },
      };
      // Missing schema or data is a capability-level state, not a package-load failure.
      return session;
    },
  };
}

let configuredSqlLoader: TestudoLoadSqlJs | null = null;
const missingSqlLoader: TestudoLoadSqlJs = async () => {
  if (!configuredSqlLoader) throw new Error("The host has not configured the bundled sql.js loader.");
  return configuredSqlLoader();
};

export function createTestudoTimeSeriesProviders(loadSqlJs: TestudoLoadSqlJs) {
  return {
    networkKpi: createProvider("network-kpi", loadSqlJs),
    emissionsH3: createProvider("emissions-h3", loadSqlJs),
    scenarioComparison: createProvider("scenario-comparison", loadSqlJs),
  };
}

export const testudoNetworkKpiProvider = createProvider("network-kpi", missingSqlLoader);
export const testudoEmissionsH3Provider = createProvider("emissions-h3", missingSqlLoader);
export const testudoScenarioComparisonProvider = createProvider("scenario-comparison", missingSqlLoader);

const registrations: Array<[ResultCapability, TestudoFeatureProviderFactory]> = [
  ["network-kpi", testudoNetworkKpiProvider], ["emissions-h3", testudoEmissionsH3Provider], ["scenario-comparison", testudoScenarioComparisonProvider],
];
const owners = new Map<string, () => void>();
export function registerTestudoTimeSeriesProviders(loadSqlJs?: TestudoLoadSqlJs): () => void {
  if (loadSqlJs) configuredSqlLoader = loadSqlJs;
  for (const [capability, factory] of registrations) {
    if (!owners.has(capability)) owners.set(capability, registerTestudoPackageProvider({ capability, factory }, `geolibre-${capability}`));
  }
  return () => { for (const unregister of owners.values()) unregister(); owners.clear(); configuredSqlLoader = null; };
}
