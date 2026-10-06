import type { TestudoFeatureContext, TestudoFeatureSession, TestudoPackageProgress, TestudoPlaybackState, TestudoScenario } from "../shared/testudo-feature-session";
import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "../testudo-feature-bridge";
import { registerTestudoPackageProvider } from "../testudo-provider-registry";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const manifest = async (fetchArtifact: (ref: string) => Promise<ArrayBuffer>, onProgress: (p: TestudoPackageProgress) => void) => {
  const bytes = await fetchArtifact("manifest.json");
  onProgress({ value: 100, loaded: bytes.byteLength, total: bytes.byteLength, label: "Reading Testudo time series" });
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new Error("The Testudo time-series manifest is not valid JSON."); }
};
const ticks = (raw: Json, packageInfo: Json): number => {
  const metadata = record(raw.metadata);
  const time = record(packageInfo.time);
  return Math.max(0, Math.trunc(finite(raw.maxTick ?? raw.max_tick)
    ?? ((finite(raw.n_ticks ?? raw.tick_count ?? metadata.n_ticks ?? time.intervalCount) ?? 1) - 1)));
};
const seriesAt = (raw: unknown, tick: number): unknown => {
  if (!Array.isArray(raw)) return undefined;
  return raw[Math.max(0, Math.min(raw.length - 1, Math.trunc(tick)))];
};

function provider(capability: "network-kpi" | "emissions-h3" | "scenario-comparison"): TestudoFeatureProviderFactory {
  return {
    async open(_bootstrap: TestudoPackageBootstrap, context: TestudoFeatureContext, onProgress, fetchArtifact): Promise<TestudoFeatureSession> {
      const data = await manifest(fetchArtifact, onProgress);
      let packageInfo: Json = {};
      try { packageInfo = record(JSON.parse(new TextDecoder().decode(await fetchArtifact("geolibre/package.json")))); }
      catch { /* Older packages may carry their scenario metadata in manifest.json. */ }
      const field = capability === "network-kpi" ? "kpiTimeSeries" : capability === "emissions-h3" ? "emissionsTimeSeries" : "comparisonTimeSeries";
      const rows = record(data[field]);
      const hasSeries = Object.values(rows).some((value) => Array.isArray(value) && value.length > 0);
      const maxTick = ticks(data, packageInfo);
      const time = record(packageInfo.time);
      const metadata = record(data.metadata);
      const dt = Math.max(0.001, finite(data.dt ?? data.step_seconds ?? metadata.dt ?? time.dtSeconds) ?? 1);
      const scenarioSource = Array.isArray(data.scenarios) ? data.scenarios : packageInfo.scenarios;
      const scenarios: TestudoScenario[] = Array.isArray(scenarioSource) ? scenarioSource.flatMap((value, index) => {
        const row = record(value);
        const id = row.scid ?? row.id;
        if (typeof id !== "string" && typeof id !== "number") return [];
        return [{ id: String(id), label: typeof row.name === "string" ? row.name : typeof row.label === "string" ? row.label : `Scenario ${index + 1}` }];
      }) : [];
      let selectedScenarioId = scenarios[0]?.id ?? "";
      let currentTick = 0;
      let currentValues: unknown = undefined;
      const session: TestudoFeatureSession = {
        context,
        capabilities: [{ id: capability, available: hasSeries,
          ...(!hasSeries ? { reason: `The package does not contain decoded ${capability} time-series data.` } : {}) }],
        scenarios,
        timeSeriesAvailable: hasSeries,
        playbackRange: { maxTick, dt },
        onPlaybackTick(tviewId, generation, state: TestudoPlaybackState) {
          if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback follower belongs to a stale Testudo package.");
          currentTick = state.tick;
          currentValues = Object.fromEntries(Object.entries(rows).map(([key, series]) => [key, seriesAt(series, currentTick)]));
        },
        getPlaybackValues() { return { tick: currentTick, values: currentValues }; },
        selectScenario(id) { selectedScenarioId = id; return id; },
        get selectedScenarioId() { return selectedScenarioId; },
      };
      // Comparison regression logic in the existing bridge keeps selection and
      // writes scoped by TView/generation; this adapter exposes both scenario
      // series at the same shared tick rather than maintaining a second clock.
      if (capability === "scenario-comparison") {
        session.getComparisonAtTick = (ids: [string, string]) => ({
          tick: currentTick,
          scenarioIds: ids,
          values: ids.map((id) => seriesAt(rows[id], currentTick)),
        });
      }
      return session;
    },
  };
}

export const testudoNetworkKpiProvider = provider("network-kpi");
export const testudoEmissionsH3Provider = provider("emissions-h3");
export const testudoScenarioComparisonProvider = provider("scenario-comparison");

const registrations: Array<["network-kpi" | "emissions-h3" | "scenario-comparison", TestudoFeatureProviderFactory]> = [
  ["network-kpi", testudoNetworkKpiProvider], ["emissions-h3", testudoEmissionsH3Provider], ["scenario-comparison", testudoScenarioComparisonProvider],
];
const owners = new Map<string, () => void>();
export function registerTestudoTimeSeriesProviders(): () => void {
  for (const [capability, factory] of registrations) {
    if (!owners.has(capability)) owners.set(capability, registerTestudoPackageProvider({ capability, factory }, `geolibre-${capability}`));
  }
  return () => { for (const unregister of owners.values()) unregister(); owners.clear(); };
}
