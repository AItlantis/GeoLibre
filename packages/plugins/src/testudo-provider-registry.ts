import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "./testudo-feature-bridge";
import type { TestudoCapabilityKey, TestudoFeatureSession, TestudoPlaybackState } from "./shared/testudo-feature-session";
import { switchTestudoModeLayers, type TestudoOwnedMode } from "./testudo-layer-ownership";

export interface TestudoPackageProviderRegistration {
  capability: TestudoCapabilityKey;
  factory: TestudoFeatureProviderFactory;
}

interface OwnedRegistration extends TestudoPackageProviderRegistration {
  owner: string;
}

const providers = new Map<TestudoCapabilityKey, OwnedRegistration>();

/** Register one package loader/feature adapter under its manifest capability. */
export function registerTestudoPackageProvider(
  registration: TestudoPackageProviderRegistration,
  owner: string,
): () => void {
  if (!owner.trim()) throw new Error("A provider owner id is required.");
  const previous = providers.get(registration.capability);
  if (previous) throw new Error(`A Testudo provider is already registered for ${registration.capability}.`);
  const entry: OwnedRegistration = { ...registration, owner };
  providers.set(registration.capability, entry);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (providers.get(registration.capability) === entry) providers.delete(registration.capability);
  };
}

/** Resolve only a provider registered by an active plugin. */
export function getTestudoPackageProvider(
  capability: TestudoCapabilityKey,
  bootstrap: TestudoPackageBootstrap,
): TestudoFeatureProviderFactory | null {
  const declared = bootstrap.capabilities?.find((item) => item.id === capability && item.available);
  if (!declared) return null;
  return providers.get(capability)?.factory ?? null;
}

/** Resolve all declared Testudo providers as one TView session with one clock. */
export function getTestudoPackageProviderSuite(bootstrap: TestudoPackageBootstrap): TestudoFeatureProviderFactory | null {
  const selectedId = bootstrap.selectedPlugin ?? bootstrap.capabilities?.find((item) => item.available)?.id;
  if (!selectedId) return null;
  const selected = selectedId as TestudoCapabilityKey;
  const entries = (bootstrap.capabilities ?? []).filter((item) => item.available)
    .map((item) => [item.id, getTestudoPackageProvider(item.id, bootstrap)] as const)
    .filter((entry): entry is readonly [TestudoCapabilityKey, TestudoFeatureProviderFactory] => entry[1] !== null);
  if (!entries.some(([id]) => id === selected)) return null;
  const primary = entries.find(([id]) => id === selected)!;
  return {
    async open(packageBootstrap, context, onProgress, fetchArtifact, map): Promise<TestudoFeatureSession> {
      const cache = new Map<string, Promise<ArrayBuffer>>();
      const sharedFetch = (ref: string) => {
        let pending = cache.get(ref);
        if (!pending) { pending = fetchArtifact(ref); cache.set(ref, pending); }
        return pending;
      };
      const sessions = new Map<TestudoCapabilityKey, TestudoFeatureSession>();
      let network: import("./plugins/rendering-outputs").RenderingOutputsService | null = null;
      let networkLegendVisible = true;
      const namespace = `testudo-${context.tviewId}-${context.generation}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const modeFor = (id: TestudoCapabilityKey): TestudoOwnedMode => id === "vehicle-playback" ? "animation"
        : id === "scenario-comparison" ? "comparison" : id === "path-analysis" ? "paths" : "results";
      let activeMode: TestudoOwnedMode = modeFor(selected);
      try {
        if (map) {
          try {
            const [manifestBytes, packageBytes] = await Promise.all([sharedFetch("manifest.json"), sharedFetch("geolibre/package.json")]);
            const parse = (bytes: ArrayBuffer) => {
              const value = JSON.parse(new TextDecoder().decode(bytes));
              return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
            };
            const renderer = await import("./plugins/rendering-outputs");
            network = await renderer.mountRenderingOutputs({
              map, context, manifest: parse(manifestBytes), packageInfo: parse(packageBytes), fetchArtifact: sharedFetch,
              onProgress, cameraWasOverridden: () => false,
            });
          } catch (error) {
            onProgress({ value: 0, loaded: 0, total: 0, label: `Network unavailable: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        for (const [id, factory] of entries) {
          sessions.set(id, await factory.open(packageBootstrap, { ...context, pluginId: id }, onProgress, sharedFetch, map));
        }
      } catch (error) {
        await Promise.all([...sessions.values()].map((session) => session.dispose?.()));
        throw error;
      }
      const clockSession = sessions.get(primary[0])!;
      let active = selected;
      let fallbackState: TestudoPlaybackState = {
        available: true, loading: false, playing: false, tick: 0,
        maxTick: Math.max(0, ...[...sessions.values()].map((session) => session.playbackRange?.maxTick ?? 0)),
        speed: 1, dt: clockSession.playbackRange?.dt ?? 1, loop: false,
      };
      const fallbackListeners = new Set<(tviewId: string, generation: number, state: TestudoPlaybackState) => void>();
      let fallbackTimer: ReturnType<typeof setInterval> | undefined;
      const fallbackEmit = () => { for (const listener of fallbackListeners) listener(context.tviewId, context.generation, { ...fallbackState }); };
      const fallbackPlayback: TestudoFeatureSession["playback"] = {
        getPlaybackState(tviewId, generation) { if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback state belongs to a stale Testudo package."); return { ...fallbackState }; },
        play(tviewId, generation) {
          if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback command belongs to a stale Testudo package.");
          if (fallbackTimer) clearInterval(fallbackTimer);
          fallbackState = { ...fallbackState, playing: fallbackState.tick < fallbackState.maxTick };
          if (fallbackState.playing) fallbackTimer = setInterval(() => {
            fallbackState = { ...fallbackState, tick: Math.min(fallbackState.maxTick, fallbackState.tick + 1) };
            if (fallbackState.tick >= fallbackState.maxTick) { fallbackState.playing = false; if (fallbackTimer) clearInterval(fallbackTimer); fallbackTimer = undefined; }
            fallbackEmit();
          }, Math.max(16, Math.round(1000 * fallbackState.dt / fallbackState.speed)));
          fallbackEmit(); return { ...fallbackState };
        },
        pause(tviewId, generation) { if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback command belongs to a stale Testudo package."); if (fallbackTimer) clearInterval(fallbackTimer); fallbackTimer = undefined; fallbackState = { ...fallbackState, playing: false }; fallbackEmit(); return { ...fallbackState }; },
        restart(tviewId, generation) { this.pause(tviewId, generation); fallbackState = { ...fallbackState, tick: 0 }; fallbackEmit(); return { ...fallbackState }; },
        seek(tviewId, generation, tick) { this.pause(tviewId, generation); fallbackState = { ...fallbackState, tick: Math.min(fallbackState.maxTick, Math.trunc(tick)) }; fallbackEmit(); return { ...fallbackState }; },
        setSpeed(tviewId, generation, speed) { const wasPlaying = fallbackState.playing; this.pause(tviewId, generation); fallbackState = { ...fallbackState, speed }; return wasPlaying ? this.play(tviewId, generation) : (fallbackEmit(), { ...fallbackState }); },
        subscribe(listener) { fallbackListeners.add(listener); return () => fallbackListeners.delete(listener); },
      };
      const clockPlayback = clockSession.playback ?? fallbackPlayback!;
      let lastState: TestudoPlaybackState = clockPlayback.getPlaybackState(context.tviewId, context.generation);
      const decorate = (state: TestudoPlaybackState): TestudoPlaybackState => ({
        ...state, activeCapability: active,
        tickFollowers: entries.map(([capability]) => {
          const follower = sessions.get(capability)!;
          const isActive = capability === active;
          return { capability, following: capability === primary[0] || Boolean(follower.onPlaybackTick), timeSeriesAvailable: isActive && (follower.timeSeriesAvailable ?? capability === primary[0]) };
        }),
      });
      const follow = async (state: TestudoPlaybackState) => {
        lastState = decorate(state);
        await Promise.all([...sessions.entries()].map(async ([capability, follower]) => {
          if (follower === clockSession && follower.playback && capability === primary[0]) return;
          await follower.onPlaybackTick?.(context.tviewId, context.generation, lastState);
        }));
      };
      await follow(lastState);
      const selectedSession = () => sessions.get(active)!;
      await selectedSession().onActivate?.();
      const aggregate: TestudoFeatureSession = {
        ...selectedSession(),
        context: { ...context, pluginId: active },
        get capabilities() {
          const byId = new Map<TestudoCapabilityKey, NonNullable<TestudoFeatureSession["capabilities"]>[number]>();
          for (const session of sessions.values()) for (const item of session.capabilities ?? []) byId.set(item.id, item);
          return (packageBootstrap.capabilities ?? []).map((declared) => byId.get(declared.id) ?? {
            ...declared,
            available: false,
            reason: declared.reason ?? (declared.id === "emissions-h3"
              ? "The package does not declare producer-backed H3 emissions data."
              : "No provider loaded this declared capability."),
          });
        },
        async selectPlugin(id) {
          if (!sessions.has(id as TestudoCapabilityKey)) throw new Error(`Capability ${id} is not available for this package.`);
          const next = id as TestudoCapabilityKey;
          const nextMode = modeFor(next);
          if (nextMode !== activeMode) {
            await selectedSession().onDeactivate?.();
            switchTestudoModeLayers(map ?? null, namespace, activeMode, nextMode);
          }
          activeMode = nextMode;
          active = next;
          aggregate.context.pluginId = active;
          const nextSession = selectedSession();
          await nextSession.onActivate?.();
          // Activation can initialise a provider at tick zero. Reapply the
          // shared clock snapshot so mode switches preserve the current tick.
          await follow(clockPlayback.getPlaybackState(context.tviewId, context.generation));
          return id;
        },
        get scenarios() { return selectedSession().scenarios; },
        get selectedScenarioId() { return selectedSession().selectedScenarioId; },
        selectScenario(id) { const current = selectedSession(); if (!current.selectScenario) throw new Error("Scenario selection is unavailable for this capability."); return current.selectScenario(id); },
        getPlaybackValues() { return selectedSession().getPlaybackValues?.() ?? { tick: lastState.tick, values: undefined }; },
        getComparisonAtTick(ids) { const current = sessions.get("scenario-comparison"); if (!current?.getComparisonAtTick) throw new Error("Scenario comparison values are unavailable."); return current.getComparisonAtTick(ids); },
        async setKpiGeometry(geometry, visible) {
          const state = network?.setGeometry(geometry, visible);
          return state ?? { showLanes: false, showSections: false };
        },
        getKpiGeometryState() { return { showLanes: network?.showLanes ?? false, showSections: network?.showSections ?? false }; },
        async setMapControl(controlId, visible) {
          if (["legend", "network-legend"].includes(controlId)) { networkLegendVisible = visible; return network?.setLegend(visible) ?? false; }
          if (["network-lanes", "lanes"].includes(controlId)) { network?.setGeometry("lanes", visible); return Boolean(network?.available && network.hasLanes); }
          if (["network-sections", "sections"].includes(controlId)) { network?.setGeometry("sections", visible); return Boolean(network?.available && network.hasSections); }
          return selectedSession().setMapControl?.(controlId, visible) ?? false;
        },
        getMapControlState() { return { ...(selectedSession().getMapControlState?.() ?? { esriWorldImageryVisible: false, renderer: "maplibre" as const }), legendVisible: networkLegendVisible }; },
        playback: {
          getPlaybackState(tviewId, generation) {
            if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback state belongs to a stale Testudo package.");
            return decorate(clockPlayback.getPlaybackState(tviewId, generation));
          },
          async play(tviewId, generation) { await clockPlayback.play(tviewId, generation); await follow(clockPlayback.getPlaybackState(tviewId, generation)); return decorate(lastState); },
          async pause(tviewId, generation) { await clockPlayback.pause(tviewId, generation); await follow(clockPlayback.getPlaybackState(tviewId, generation)); return decorate(lastState); },
          async restart(tviewId, generation) { await clockPlayback.restart(tviewId, generation); await follow(clockPlayback.getPlaybackState(tviewId, generation)); return decorate(lastState); },
          async seek(tviewId, generation, tick) { await clockPlayback.seek(tviewId, generation, tick); await follow(clockPlayback.getPlaybackState(tviewId, generation)); return decorate(lastState); },
          async setSpeed(tviewId, generation, speed) { await clockPlayback.setSpeed(tviewId, generation, speed); await follow(clockPlayback.getPlaybackState(tviewId, generation)); return decorate(lastState); },
          subscribe(listener) { return clockPlayback.subscribe?.((tviewId, generation, state) => { if (tviewId === context.tviewId && generation === context.generation) void follow(state).then(() => listener(tviewId, generation, decorate(state))); }) ?? (() => {}); },
        },
        async onPlaybackTick(tviewId, generation, state) {
          if (tviewId !== context.tviewId || generation !== context.generation) throw new Error("Playback follower belongs to a stale Testudo package.");
          await follow(state);
        },
        get timeSeriesAvailable() { return selectedSession().timeSeriesAvailable ?? false; },
        async dispose() { network?.dispose(); network = null; if (fallbackTimer) clearInterval(fallbackTimer); fallbackListeners.clear(); await Promise.all([...sessions.values()].map((session) => session.dispose?.())); },
      };
      return aggregate;
    },
  };
}

export function clearTestudoPackageProvidersForOwner(owner: string): void {
  for (const [capability, entry] of providers) {
    if (entry.owner === owner) providers.delete(capability);
  }
}
