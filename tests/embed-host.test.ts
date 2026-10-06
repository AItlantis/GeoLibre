import assert from "node:assert/strict";
import { test } from "node:test";
import { pickBroadcastTargets } from "../apps/geolibre-desktop/src/hooks/embedHost";

const both = ["https://app.testudo.live", "https://www.testudo.live"];

test("a known host origin is the only broadcast target", () => {
  assert.deepEqual(pickBroadcastTargets("https://app.testudo.live", both, null), ["https://app.testudo.live"]);
});

test("before the handshake only the allowlisted framing parent receives the ready ping", () => {
  assert.deepEqual(pickBroadcastTargets(null, both, "https://app.testudo.live"), ["https://app.testudo.live"]);
  assert.deepEqual(pickBroadcastTargets(null, both, "https://www.testudo.live"), ["https://www.testudo.live"]);
});

test("a parent that is not allowlisted, or unknown, falls back to the allowlist; no allowlist stays wildcard", () => {
  assert.deepEqual(pickBroadcastTargets(null, both, "https://evil.example"), both);
  assert.deepEqual(pickBroadcastTargets(null, both, null), both);
  assert.deepEqual(pickBroadcastTargets(null, [], "https://app.testudo.live"), ["*"]);
  assert.deepEqual(pickBroadcastTargets(null, ["*"], "https://app.testudo.live"), ["*"]);
});
