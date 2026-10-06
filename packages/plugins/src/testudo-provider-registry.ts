import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "./testudo-feature-bridge";
import type { TestudoCapabilityKey, TestudoFeatureSession, TestudoPlaybackState } from "./shared/testudo-feature-session";

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
  // Vehicle playback also owns the package's base network layers. Open it as
  // the session's infrastructure provider whenever another capability is
  // selected, even when the host's capability declaration marks animation off.
  const vehicleFactory = providers.get("vehicle-playback")?.factory;
  if (vehicleFactory && !entries.some(([id]) => id === "vehicle-playback")) entries.unshift(["vehicle-playback", vehicleFactory] as const);
  const primary = entries.find(([id]) => id === "vehicle-playback") ?? entries.find(([id]) => id === selected)!;
  return {
    async open(packageBootstrap, context, onProgress, fetchArtifact, map): Promise<TestudoFeatureSession> {
      const cache = new Map<string, Promise<ArrayBuffer>>();
      const sharedFetch = (ref: string) => {
        let pending = cache.get(ref);
        if (!pending) { pending = fetchArtifact(ref); cache.set(ref, pending); }
        return pending;
      };
      const sessions = new Map<TestudoCapabilityKey, TestudoFeatureSession>();
      try {
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
          return { capability, following: capability === primary[0] || Boolean(follower.onPlaybackTick), timeSeriesAvailable: follower.timeSeriesAvailable ?? capability === primary[0] };
        }),
      });
      const follow = async (state: TestudoPlaybackState) => {
        lastState = decorate(state);
        await Promise.all([...sessions.values()].map((session) => session === clockSession && session.playback
          ? undefined : session.onPlaybackTick?.(context.tviewId, context.generation, lastState)));
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
          active = id as TestudoCapabilityKey;
          aggregate.context.pluginId = active;
          await selectedSession().onActivate?.();
          return id;
        },
        get scenarios() { return selectedSession().scenarios; },
        get selectedScenarioId() { return selectedSession().selectedScenarioId; },
        selectScenario(id) { const current = selectedSession(); if (!current.selectScenario) throw new Error("Scenario selection is unavailable for this capability."); return current.selectScenario(id); },
        getPlaybackValues() { return selectedSession().getPlaybackValues?.() ?? { tick: lastState.tick, values: undefined }; },
        getComparisonAtTick(ids) { const current = sessions.get("scenario-comparison"); if (!current?.getComparisonAtTick) throw new Error("Scenario comparison values are unavailable."); return current.getComparisonAtTick(ids); },
        async setKpiGeometry(geometry, visible) {
          const selected = await selectedSession().setKpiGeometry?.(geometry, visible);
          const network = sessions.get("vehicle-playback");
          const networkState = await network?.setKpiGeometry?.(geometry, visible);
          return networkState ?? selected ?? { showLanes: false, showSections: false };
        },
        getKpiGeometryState() { return sessions.get("vehicle-playback")?.getKpiGeometryState?.() ?? selectedSession().getKpiGeometryState?.() ?? { showLanes: false, showSections: false }; },
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
        async dispose() { if (fallbackTimer) clearInterval(fallbackTimer); fallbackListeners.clear(); await Promise.all([...sessions.values()].map((session) => session.dispose?.())); },
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
