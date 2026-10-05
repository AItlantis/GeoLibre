import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchesTestudoArtifactCorrelation,
  parseTestudoArtifactResponse,
  parseTestudoEmbedRequest,
} from "../apps/geolibre-desktop/src/lib/embed-api";

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
  assert.equal(parseTestudoEmbedRequest({ ...envelope, type: "testudoSetArtifactCredential", payload: { authorization: "Bearer secret", challenge } }, challenge), null);
  assert.equal(parseTestudoEmbedRequest({ ...envelope, payload: { challenge: "wrong" } }, challenge), null);
  assert.equal(parseTestudoEmbedRequest({ ...envelope, payload: null }, challenge), null);
});

test("host artifact response parser and tuple matcher reject stale or mismatched correlation", () => {
  const expected = { requestId: "artifact-1", tviewId: "compare:left", generation: 4, artifactRef: "manifest.json" };
  const valid = {
    v: 2,
    source: "testudo",
    type: "testudoArtifactResponse",
    payload: { ...expected, challenge, bytes: new ArrayBuffer(3) },
  };
  const parsed = parseTestudoArtifactResponse(valid, challenge);
  assert.ok(parsed);
  assert.equal(matchesTestudoArtifactCorrelation(expected, parsed), true);
  assert.equal(parseTestudoArtifactResponse({ ...valid, payload: { ...valid.payload, challenge: "wrong" } }, challenge), null);
  assert.equal(parseTestudoArtifactResponse({ ...valid, payload: { ...valid.payload, accessToken: "must-not-cross" } }, challenge), null);
  for (const mismatch of [
    { requestId: "artifact-other" },
    { tviewId: "compare:right" },
    { generation: 3 },
    { artifactRef: "other.bin" },
  ]) {
    const response = { ...expected, ...mismatch };
    assert.equal(matchesTestudoArtifactCorrelation(expected, response), false);
  }
});
