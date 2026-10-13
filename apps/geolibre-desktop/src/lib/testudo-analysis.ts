import type { TestudoAnalysisBootstrap, TestudoAnalysisCapabilityId, TestudoAnalysisPluginId, TestudoAnalysisStatus, TestudoCloseAnalysis, TestudoOpenAnalysis, TestudoRefreshAnalysisGrant } from "@geolibre/embed";
import { analysisExpiryMs, isTestudoAnalysisPluginId, parseAnalysisUrl, TESTUDO_ANALYSIS_CAPABILITY_IDS, TESTUDO_ANALYSIS_PLUGIN_IDS } from "./testudo-protocol";

/** The slice of `PluginManager` the Analyse bridge needs (kept structural so tests can stub it). */
export interface TestudoAnalysisHost<App> {
  /** Activate (if needed) and run only that plugin's URL handler. `ok` is true only after the package finished loading. */
  openWithParams(id: string, params: Record<string, string>, app: App): Promise<{ ok: boolean; error?: string }>;
  deactivate(id: string, app: App): void;
}

export class StaleAnalysisGenerationError extends Error {
  constructor(plugin: string, generation: number, latest: number) {
    super(`Stale analysis generation ${generation} for ${plugin}; latest accepted is ${latest}.`);
    this.name = "StaleAnalysisGenerationError";
  }
}

/** `/analysis-bytes/<versionId>/<token>/analysis/`: the only base shape a grant refresh may move within. */
const GRANT_PATH_RE = /^(.*\/analysis-bytes\/)([^/]+)\/([^/]+)\/analysis\/$/;
function grantParts(base: string): { origin: string; prefix: string; versionId: string; token: string } | null {
  let url: URL;
  try { url = new URL(base); } catch { return null; }
  const match = GRANT_PATH_RE.exec(url.pathname);
  return match && !url.search && !url.hash ? { origin: url.origin, prefix: match[1], versionId: match[2], token: match[3] } : null;
}

/** True when the analysis block declares at least one available plugin and at least one available run. */
export function hasUsableAnalysis(analysis: TestudoAnalysisBootstrap | null | undefined): boolean {
  if (!analysis) return false;
  return Object.values(analysis.plugins ?? {}).some(item => item?.available) && (analysis.runs ?? []).some(run => run.available);
}

/**
 * Decides how a freshly loaded package becomes viewable: through a map plugin, through analysis only
 * (no map plugin, no Present modes), or not at all (throws the unsupported-package error).
 */
export function resolveTestudoViewerKind(initialPlugin: unknown, analysis: TestudoAnalysisBootstrap | null | undefined): "map" | "analysis-only" {
  if (initialPlugin) return "map";
  if (hasUsableAnalysis(analysis)) return "analysis-only";
  throw new Error("This package has no supported viewer data");
}

export function capabilityForAnalysisPlugin(plugin: TestudoAnalysisPluginId): TestudoAnalysisCapabilityId {
  return TESTUDO_ANALYSIS_CAPABILITY_IDS.find(id => TESTUDO_ANALYSIS_PLUGIN_IDS[id] === plugin)!;
}

/**
 * Opens and closes the Testudo Analyse plugins one at a time through the public plugin API.
 *
 * - Only the targeted plugin is opened; the global URL-parameter loop is never used.
 * - `generation` is monotonic per plugin; an equal or older value is rejected as stale.
 * - A package switch (`setPackage`) tears every open plugin down and resets the counters.
 * - Requests must match the bootstrap's declared analysis (plugin available, run available,
 *   manifest under `baseUrl`, not expired).
 */
export class TestudoAnalysisController<App> {
  private analysis: TestudoAnalysisBootstrap | null = null;
  private versionId: string | null = null;
  private generations = new Map<TestudoAnalysisPluginId, number>();
  private epochs = new Map<TestudoAnalysisPluginId, number>();
  private wanted = new Map<TestudoAnalysisPluginId, boolean>();
  private opened = new Map<TestudoAnalysisPluginId, { run: string; generation: number }>();

  constructor(
    private readonly host: TestudoAnalysisHost<App>,
    private readonly app: App,
    private readonly emit: (status: TestudoAnalysisStatus) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Package switch: close everything and adopt the new package's analysis block (or none). */
  setPackage(analysis: TestudoAnalysisBootstrap | null | undefined, versionId: string | null = null): void {
    this.teardown();
    this.generations.clear();
    this.analysis = analysis ?? null;
    this.versionId = versionId;
  }

  /**
   * Replace the authorization base and expiry in place (token refresh): open plugins, generations and the
   * selected tab are untouched. Only the token segment of `/analysis-bytes/<versionId>/<token>/analysis/` may
   * change (same origin, same version); anything else answers `status: "error"`.
   */
  refreshGrant(payload: TestudoRefreshAnalysisGrant): TestudoAnalysisStatus {
    const fail = (error: string): TestudoAnalysisStatus => {
      const status: TestudoAnalysisStatus = { status: "error", error };
      this.emit(status);
      return status;
    };
    const analysis = this.analysis;
    if (!analysis) return fail("The loaded package declares no analysis.");
    const expiry = analysisExpiryMs(payload.expiresAt);
    if (expiry === null) return fail("The refreshed expiresAt must be epoch milliseconds or an ISO-8601 timestamp.");
    if (expiry <= this.now()) return fail("The refreshed analysis grant is already expired.");
    const next = parseAnalysisUrl(payload.baseUrl);
    const nextParts = next && String(payload.baseUrl).endsWith("/") ? grantParts(next.href) : null;
    const current = grantParts(analysis.baseUrl);
    if (!nextParts || !current) return fail("The analysis base URL does not have the /analysis-bytes/<versionId>/<token>/analysis/ shape.");
    if (nextParts.origin !== current.origin || nextParts.prefix !== current.prefix || nextParts.versionId !== current.versionId
      || (this.versionId !== null && nextParts.versionId !== this.versionId)) {
      return fail("The refreshed analysis base URL may differ from the current one only in the token segment.");
    }
    this.analysis = { ...analysis, baseUrl: next!.href, expiresAt: expiry };
    const status: TestudoAnalysisStatus = { status: "refreshed", expiresAt: expiry };
    this.emit(status);
    return status;
  }

  isOpen(plugin: TestudoAnalysisPluginId): boolean {
    return this.opened.has(plugin);
  }

  /** Close every analysis plugin that is open or still opening. */
  teardown(): void {
    for (const plugin of new Set([...this.opened.keys(), ...this.wanted.keys()])) {
      if (this.wanted.get(plugin) || this.opened.has(plugin)) this.closeQuietly(plugin);
    }
  }

  async open(payload: TestudoOpenAnalysis): Promise<TestudoAnalysisStatus> {
    const { plugin, manifestUrl, run, generation } = payload;
    if (!isTestudoAnalysisPluginId(plugin)) throw new Error("Unknown analysis plugin.");
    const latest = this.generations.get(plugin) ?? 0;
    if (!Number.isSafeInteger(generation) || generation <= latest) throw new StaleAnalysisGenerationError(plugin, generation, latest);
    this.generations.set(plugin, generation);
    const epoch = this.bump(plugin);
    this.wanted.set(plugin, true);
    try {
      this.authorize(plugin, manifestUrl, run);
      let opened: { ok: boolean; error?: string };
      try {
        opened = await this.host.openWithParams(plugin, { aimsunPackage: manifestUrl, aimsunRun: run }, this.app);
      } catch (error) {
        opened = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (this.epochs.get(plugin) !== epoch) {
        // A newer open/close/package switch won the race; leave the winner's state alone.
        if (this.wanted.get(plugin) === false) this.host.deactivate(plugin, this.app);
        throw new Error(`Analysis open for ${plugin} was superseded.`);
      }
      if (!opened.ok) {
        // The plugin activated but its package failed to load: tear the half-open panel down.
        this.host.deactivate(plugin, this.app);
        throw new Error(opened.error || `Analysis plugin ${plugin} could not be opened.`);
      }
    } catch (error) {
      if (this.epochs.get(plugin) === epoch) {
        this.wanted.set(plugin, false);
        this.emit({ plugin, status: "error", run, generation, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
    this.opened.set(plugin, { run, generation });
    const status: TestudoAnalysisStatus = { plugin, status: "open", run, generation };
    this.emit(status);
    return status;
  }

  close(payload: TestudoCloseAnalysis): TestudoAnalysisStatus {
    const { plugin } = payload;
    if (!isTestudoAnalysisPluginId(plugin)) throw new Error("Unknown analysis plugin.");
    return this.closeQuietly(plugin);
  }

  private closeQuietly(plugin: TestudoAnalysisPluginId): TestudoAnalysisStatus {
    this.bump(plugin);
    this.wanted.set(plugin, false);
    this.opened.delete(plugin);
    this.host.deactivate(plugin, this.app);
    const status: TestudoAnalysisStatus = { plugin, status: "closed" };
    this.emit(status);
    return status;
  }

  private bump(plugin: TestudoAnalysisPluginId): number {
    const next = (this.epochs.get(plugin) ?? 0) + 1;
    this.epochs.set(plugin, next);
    return next;
  }

  private authorize(plugin: TestudoAnalysisPluginId, manifestUrl: string, run: string): void {
    const analysis = this.analysis;
    if (!analysis) throw new Error("The loaded package declares no analysis.");
    const expiry = analysisExpiryMs(analysis.expiresAt);
    if (expiry === null || expiry <= this.now()) throw new Error("The analysis grant has expired; reload the package.");
    const availability = analysis.plugins[capabilityForAnalysisPlugin(plugin)];
    if (!availability?.available) throw new Error(availability?.reason ?? `Analysis is unavailable for ${plugin} in this package.`);
    const declared = analysis.runs.find(item => item.run === run);
    if (!declared?.available) throw new Error(declared?.reason ?? `Analysis run ${run} is unavailable.`);
    if (declared.capabilities && declared.capabilities[capabilityForAnalysisPlugin(plugin)] === false) throw new Error(`Analysis run ${run} does not provide ${capabilityForAnalysisPlugin(plugin)}.`);
    const url = parseAnalysisUrl(manifestUrl);
    if (!url || !url.href.startsWith(new URL(analysis.baseUrl).href)) throw new Error("The analysis manifest is outside the package analysis base URL.");
  }
}
