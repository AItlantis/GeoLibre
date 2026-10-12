import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedFingerprint,
  createTestudoLiveDiagnosticsGetter,
  liveIdentityState,
  testudoLiveDiagnosticsEnabled,
} from "../packages/plugins/src/shared/testudo-live-diagnostics";

test("live diagnostics are disabled unless both dev build and explicit iframe query flag are present", () => {
  assert.equal(testudoLiveDiagnosticsEnabled(false, "?testudoDiagnostics=1"), false);
  assert.equal(testudoLiveDiagnosticsEnabled(true, ""), false);
  assert.equal(testudoLiveDiagnosticsEnabled(true, "?testudoDiagnostics=0"), false);
  assert.equal(testudoLiveDiagnosticsEnabled(true, "?testudoDiagnostics=1"), true);
  assert.equal(createTestudoLiveDiagnosticsGetter(false, () => ({ secret: "not exposed" })), undefined);
});

test("diagnostic reads are pure and fingerprints are bounded", () => {
  const state = { requestedScid: 49414, loadedScid: 49320, rows: [1, 2, 3] };
  const before = structuredClone(state);
  let reads = 0;
  const getter = createTestudoLiveDiagnosticsGetter(true, () => { reads += 1; return { ...state, fingerprint: boundedFingerprint(state.rows) }; });
  assert.ok(getter);
  assert.deepEqual(getter(), { ...state, fingerprint: boundedFingerprint(state.rows) });
  assert.deepEqual(state, before);
  assert.equal(reads, 1);
  assert.match(boundedFingerprint(Array.from({ length: 1000 }, (_, index) => index)), /^fnv1a32:[a-f0-9]{8}:32$/);
});

test("identity provenance separates requested, loaded, replacement, and failed loads", () => {
  const loadedA = { scid: 49320, did: 49342, interval: 0, sampleCount: 4, sampleFingerprint: "fnv1a32:a:4" };
  const requestedB = { scid: 49414, did: null, interval: 0, sampleCount: 0, sampleFingerprint: null };
  const switching = liveIdentityState({ loading: true, error: null, requested: requestedB, loaded: loadedA });
  assert.equal(switching.loading, true);
  assert.equal(switching.requested?.scid, 49414);
  assert.equal(switching.loaded?.scid, 49320, "old data remains labeled with its loaded identity while B is pending");

  const replacement = liveIdentityState({ loading: true, error: null, requested: requestedB, loaded: null });
  assert.equal(replacement.loaded, null, "package replacement clears the prior loaded identity");
  const failed = liveIdentityState({ loading: false, error: "opaque error", requested: requestedB, loaded: null });
  assert.equal(failed.error, true);
  assert.equal(failed.loaded, null, "failed selection cannot relabel stale data as B");
  assert.equal(JSON.stringify(failed).includes("opaque error"), false, "raw error text is not exposed");
});
