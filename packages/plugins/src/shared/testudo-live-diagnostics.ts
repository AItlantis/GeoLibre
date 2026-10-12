/** Test-only identity fingerprints. Never pass source rows or coordinates to the browser. */
export function boundedFingerprint(values: readonly unknown[], limit = 32): string {
  let hash = 2166136261;
  const take = values.slice(0, Math.max(0, Math.min(64, limit)));
  for (const value of take) {
    const text = `${value ?? "∅"}\u001f`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${take.length}`;
}

export interface LiveDataIdentity {
  scid: string | number | null;
  did: number | null;
  interval: number | null;
  sampleCount: number;
  sampleFingerprint: string | null;
}

export function liveIdentityState(input: {
  loading: boolean;
  error: string | null;
  requested: LiveDataIdentity | null;
  loaded: LiveDataIdentity | null;
}) {
  return {
    loading: input.loading,
    error: Boolean(input.error),
    requested: input.requested,
    loaded: input.loaded,
  };
}

export function testudoLiveDiagnosticsEnabled(devBuild: boolean, search: string): boolean {
  return devBuild && new URLSearchParams(search).get("testudoDiagnostics") === "1";
}

export function createTestudoLiveDiagnosticsGetter<T>(enabled: boolean, readSnapshot: () => T): (() => T) | undefined {
  return enabled ? () => readSnapshot() : undefined;
}
