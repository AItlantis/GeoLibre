import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestudoEmbedRequest } from "../apps/geolibre-desktop/src/lib/embed-api";

const challenge = "0123456789abcdef0123456789abcdef";
const envelope = {
  v: 2,
  source: "testudo",
  type: "testudoGetTViews",
  requestId: "req-1",
  payload: { challenge },
};

test("Testudo host handler parser accepts only a known command with the child challenge", () => {
  assert.deepEqual(parseTestudoEmbedRequest(envelope, challenge), {
    type: "testudoGetTViews",
    requestId: "req-1",
    payload: {},
  });
  assert.equal(parseTestudoEmbedRequest({ ...envelope, source: "geolibre" }, challenge), null);
  assert.equal(parseTestudoEmbedRequest({ ...envelope, v: 1 }, challenge), null);
  assert.equal(parseTestudoEmbedRequest({ ...envelope, requestId: "" }, challenge), null);
  const guestCapability = parseTestudoEmbedRequest({ ...envelope, type: "testudoSetGuestCapability", payload: { protocol: 1, guestEmbedToken: "guest-secret", expiresAt: Date.now() + 10_000, challenge } }, challenge);
  assert.equal(guestCapability?.type, "testudoSetGuestCapability");
  assert.equal(guestCapability?.payload.guestEmbedToken, "guest-secret");
  assert.equal(parseTestudoEmbedRequest({ ...envelope, payload: { challenge: "wrong" } }, challenge), null);
  assert.equal(parseTestudoEmbedRequest({ ...envelope, payload: null }, challenge), null);
});
