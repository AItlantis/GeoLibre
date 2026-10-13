import type { TestudoAnalysisBootstrap, TestudoAnalysisCapabilityId, TestudoAnalysisPluginId, TestudoAnalysisStatus, TestudoCloseAnalysis, TestudoOpenAnalysis } from "@geolibre/embed";
import { analysisExpiryMs, isTestudoAnalysisPluginId, parseAnalysisUrl, TESTUDO_ANALYSIS_CAPABILITY_IDS, TESTUDO_ANALYSIS_PLUGIN_IDS } from "./testudo-protocol";

/** The slice of `PluginManager` the Analyse bridge needs (kept structural so tests can stub it). */
export interface TestudoAnalysisHost<App> {
  /** Activate (if needed) and run only that plugin's URL handler. Resolves false when it cannot be opened. */
  openWithParams(id: string, params: Record<string, string>, app: App): Promise<boolean>;
  deactivate(id: string, app: App): void;
}

export class StaleAnalysisGenerationError extends Error {
  constructor(plugin: string, generation: number, latest: number) {
    super(`Stale analysis generation ${generation} for ${plugin}; latest accepted is ${latest}.`);
    this.name = "StaleAnalysisGenerationError";
  }
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
  setPackage(analysis: TestudoAnalysisBootstrap | null | undefined): void {
    this.teardown();
    this.generations.clear();
    this.analysis = analysis ?? null;
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
      const opened = await this.host.openWithParams(plugin, { aimsunPackage: manifestUrl, aimsunRun: run }, this.app);
      if (this.epochs.get(plugin) !== epoch) {
        // A newer open/close/package switch won the race; leave the winner's state alone.
        if (this.wanted.get(plugin) === false) this.host.deactivate(plugin, this.app);
        throw new Error(`Analysis open for ${plugin} was superseded.`);
      }
      if (!opened) throw new Error(`Analysis plugin ${plugin} could not be opened.`);
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
    const url = parseAnalysisUrl(manifestUrl);
    if (!url || !url.href.startsWith(new URL(analysis.baseUrl).href)) throw new Error("The analysis manifest is outside the package analysis base URL.");
  }
}
