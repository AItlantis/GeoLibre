import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsTestudoMessage } from "../apps/geolibre-desktop/src/lib/testudo-protocol";

const parent = {} as Window;
const origin = "https://app.testudo.live";
const challenge = "0123456789abcdef0123456789abcdef";
const event = {
  source: parent,
  origin,
  data: { v: 2, source: "testudo", requestId: "1", type: "testudoGetState", payload: { challenge } },
};

test("Testudo protocol pins parent, origin, allowlist, protocol, source and verbs", () => {
  assert.equal(acceptsTestudoMessage(event, parent, [origin], challenge), true);
  for (const invalid of [
    { ...event, source: {} as Window },
    { ...event, origin: "https://attacker.invalid" },
    { ...event, data: { ...event.data, v: 1 } },
    { ...event, data: { ...event.data, source: "geolibre" } },
    { ...event, data: { ...event.data, type: "openTool" } },
    { ...event, data: { ...event.data, requestId: "" } },
  ]) assert.equal(acceptsTestudoMessage(invalid, parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(event, parent, ["*"], challenge), false);
});

test("Testudo protocol rejects a command whose payload challenge does not match", () => {
  const wrongChallenge = { ...event, data: { ...event.data, payload: { challenge: "not-the-challenge" } } };
  assert.equal(acceptsTestudoMessage(wrongChallenge, parent, [origin], challenge), false);
  const missingChallenge = { ...event, data: { ...event.data, payload: {} } };
  assert.equal(acceptsTestudoMessage(missingChallenge, parent, [origin], challenge), false);
});

test("testudoSetMode additionally requires a recognized demo mode", () => {
  const setMode = (mode: unknown) => ({
    ...event,
    data: { ...event.data, type: "testudoSetMode", payload: { challenge, mode } },
  });
  assert.equal(acceptsTestudoMessage(setMode("animation"), parent, [origin], challenge), true);
  assert.equal(acceptsTestudoMessage(setMode("flow"), parent, [origin], challenge), true);
  assert.equal(acceptsTestudoMessage(setMode("not-a-mode"), parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(setMode(undefined), parent, [origin], challenge), false);
});

test("testudoSetGuestCapability additionally requires protocol, token shape and a bounded, non-expired expiry", () => {
  const now = Date.now();
  const validToken = "a".repeat(32);
  const setGuest = (overrides: Record<string, unknown> = {}) => ({
    ...event,
    data: {
      ...event.data,
      type: "testudoSetGuestCapability",
      payload: { protocol: 1, challenge, guestEmbedToken: validToken, expiresAt: now + 60_000, ...overrides },
    },
  });
  assert.equal(acceptsTestudoMessage(setGuest(), parent, [origin], challenge), true);
  assert.equal(acceptsTestudoMessage(setGuest({ protocol: 2 }), parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(setGuest({ guestEmbedToken: "too-short" }), parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(setGuest({ expiresAt: now - 1000 }), parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(setGuest({ expiresAt: now + 11 * 60_000 }), parent, [origin], challenge), false);
  assert.equal(acceptsTestudoMessage(setGuest({ expiresAt: "soon" }), parent, [origin], challenge), false);
});
