import assert from "node:assert/strict";
import { test } from "node:test";
import { TestudoFeatureSessions, validTestudoProgress, type TestudoFeatureSession } from "../packages/plugins/src/shared/testudo-feature-session";

function session(tviewId: string, generation: number, disposed: () => void = () => {}): TestudoFeatureSession {
  return { context: { tviewId, packageId: "pkg", versionId: "v1", pluginId: "vehicle-playback", generation }, dispose: disposed };
}

test("Testudo feature sessions isolate TViews and notify per-view subscribers", () => {
  const sessions = new TestudoFeatureSessions();
  const first = session("left", 1);
  let leftChanges = 0;
  let rightChanges = 0;
  sessions.subscribe("left", () => leftChanges++);
  sessions.subscribe("right", () => rightChanges++);

  sessions.install(first);
  const right = session("right", 1);
  sessions.install(right);

  assert.equal(sessions.get("left"), first);
  assert.equal(sessions.get("right"), right);
  assert.equal(leftChanges, 1);
  assert.equal(rightChanges, 1);
  assert.equal(sessions.isCurrent({ tviewId: "left", generation: 1 }), true);
  assert.equal(sessions.isCurrent({ tviewId: "left", generation: 2 }), false);
});

test("replacement fences stale cleanup and disposes only the matching current session", () => {
  const sessions = new TestudoFeatureSessions();
  let disposedOld = 0;
  let disposedNew = 0;
  const old = session("main", 3, () => disposedOld++);
  const disposeOld = sessions.install(old);
  const current = session("main", 4, () => disposedNew++);
  const disposeCurrent = sessions.install(current);

  disposeOld();
  assert.equal(sessions.get("main"), current);
  assert.equal(disposedOld, 1);
  assert.equal(disposedNew, 0);
  disposeCurrent();
  assert.equal(sessions.get("main"), undefined);
  assert.equal(disposedNew, 1);
});

test("feature generations must strictly increase within a TView", () => {
  const sessions = new TestudoFeatureSessions();
  sessions.install(session("main", 2));
  assert.throws(() => sessions.install(session("main", 2)), /generations must increase/);
  assert.throws(() => sessions.install(session("main", 1)), /generations must increase/);
  assert.throws(() => sessions.install(session("", 3)), /requires a TView id/);
});

test("measured package progress rejects impossible counters and bounds labels", () => {
  assert.deepEqual(validTestudoProgress({ loaded: 25, total: 100, label: "Downloading data" }), {
    value: 25,
    loaded: 25,
    total: 100,
    label: "Downloading data",
  });
  const normalized = validTestudoProgress({ loaded: 1, total: 1, label: "x".repeat(200) });
  assert.equal(normalized.label?.length, 120);
  assert.equal(normalized.value, 100);
  assert.throws(() => validTestudoProgress({ loaded: 2, total: 1 }), /finite, ordered byte counts/);
  assert.throws(() => validTestudoProgress({ loaded: Number.NaN, total: 5 }), /finite, ordered byte counts/);
});
