import assert from "node:assert/strict";
import { test } from "node:test";
import { pickBroadcastTargets, resolveEmbedParentOrigin } from "../apps/geolibre-desktop/src/hooks/embedHost";

test("embed host targets only the known allowlisted parent before handshake", () => {
  const allowed = ["https://portal.example", "https://other.example"];
  assert.deepEqual(pickBroadcastTargets(null, allowed, "https://portal.example"), ["https://portal.example"]);
  assert.deepEqual(pickBroadcastTargets("https://other.example", allowed, "https://portal.example"), ["https://other.example"]);
  assert.deepEqual(pickBroadcastTargets(null, allowed, "https://attacker.example"), allowed);
  assert.equal(resolveEmbedParentOrigin(["null", "https://portal.example/path"], allowed), "https://portal.example");
  assert.equal(resolveEmbedParentOrigin(["https://attacker.example"], allowed), null);
});
