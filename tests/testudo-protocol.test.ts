import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsTestudoMessage } from "../apps/geolibre-desktop/src/lib/testudo-protocol";
const parent = {} as Window;
const origin = "https://app.testudo.live";
const event = { source: parent, origin, data: { v: 2, requestId: "1", type: "testudoGetState", payload: {} } };
test("Testudo protocol pins parent, origin, allowlist, protocol and verbs", () => {
  assert.equal(acceptsTestudoMessage(event, parent, origin, [origin]), true);
  for (const invalid of [
    { ...event, source: {} as Window }, { ...event, origin: "https://attacker.invalid" },
    { ...event, data: { ...event.data, v: 1 } }, { ...event, data: { ...event.data, source: "geolibre" } },
    { ...event, data: { ...event.data, type: "openTool" } }, { ...event, data: { ...event.data, requestId: "" } },
  ]) assert.equal(acceptsTestudoMessage(invalid, parent, origin, [origin]), false);
  assert.equal(acceptsTestudoMessage(event, parent, origin, ["*"]), false);
});
