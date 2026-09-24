import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignedPackageSource, packagePath, sourceDirectory } from "../apps/geolibre-desktop/src/lib/testudo-source";

const origin = "https://app.testudo.live";
const bytes = "https://bytes.testudo.live";
const options = { origin, artifactEndpoint: "/api/v1/view/version/artifact/", bearerToken: "private-token", byteOrigins: [bytes], signal: new AbortController().signal };
test("package paths reject encoded traversal, absolute URLs and separators", () => {
  for (const path of ["../a", "%252e%252e/a", "/etc/passwd", "https://x/a", "a\\b", "a?x", "a//b", "bad%zz"]) assert.throws(() => packagePath(path));
  assert.equal(packagePath("geometry/lanes.geojson"), "geometry/lanes.geojson");
});
test("VDS descriptor gets bearer, byte origin never does; no worker URL bypass", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const source = createSignedPackageSource({ ...options, fetch: (async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? Response.json({ signed_url: bytes + "/artifact?token=signed", expires_at: Date.now() / 1000 + 60 }) : new Response("geometry");
  }) as typeof fetch });
  assert.equal(source.baseUrl, null);
  assert.equal(new TextDecoder().decode(await source.read("geometry/a.geojson")), "geometry");
  assert.equal(calls[0].url, origin + options.artifactEndpoint + "geometry/a.geojson");
  assert.deepEqual(calls[0].init?.headers, { Authorization: "Bearer private-token" });
  assert.equal(calls[1].init?.headers, undefined);
  assert.equal(calls[1].init?.credentials, "omit");
  assert.equal(calls[1].init?.redirect, "error");
});
test("immutable package manifests reuse one signed read across validation and plugin loading", async () => {
  let descriptors = 0;
  let byteReads = 0;
  const source = createSignedPackageSource({ ...options, fetch: (async url => {
    if (String(url).startsWith(origin)) {
      descriptors++;
      return Response.json({ signed_url: bytes + "/artifact", expires_at: Date.now() / 1000 + 60 });
    }
    byteReads++;
    return new Response("package metadata");
  }) as typeof fetch });
  const [first, concurrent] = await Promise.all([source.read("manifest.json"), source.read("manifest.json")]);
  const repeated = await source.read("manifest.json");
  assert.equal(first, concurrent);
  assert.equal(first, repeated);
  await source.read("geolibre/package.json");
  await source.read("geolibre/package.json");
  assert.equal(descriptors, 2);
  assert.equal(byteReads, 2);
  await source.read("geometry/sections.geojson");
  await source.read("geometry/sections.geojson");
  assert.equal(descriptors, 4);
  assert.equal(byteReads, 4);
});
test("failed manifest reads can be retried after the underlying error clears", async () => {
  let descriptors = 0;
  let byteReads = 0;
  const source = createSignedPackageSource({ ...options, fetch: (async url => {
    if (String(url).startsWith(origin)) {
      descriptors++;
      return Response.json({ signed_url: bytes + "/artifact", expires_at: Date.now() / 1000 + 60 });
    }
    byteReads++;
    return byteReads === 1 ? new Response(null, { status: 500 }) : new Response("recovered");
  }) as typeof fetch });
  await assert.rejects(source.read("manifest.json"), /500/);
  assert.equal(new TextDecoder().decode(await source.read("manifest.json")), "recovered");
  assert.equal(descriptors, 2);
  assert.equal(byteReads, 2);
});
test("expired byte request is re-resolved once and then fails visibly", async () => {
  let descriptors = 0;
  const source = createSignedPackageSource({ ...options, fetch: (async url => {
    if (String(url).startsWith(origin)) { descriptors++; return Response.json({ signed_url: bytes + "/a", expires_at: Date.now() / 1000 + 60 }); }
    return new Response(null, { status: 403 });
  }) as typeof fetch });
  await assert.rejects(source.read("manifest.json"), /403/);
  assert.equal(descriptors, 2);
});
test("attacker-controlled signed host is never contacted", async () => {
  let requests = 0;
  const source = createSignedPackageSource({ ...options, fetch: (async () => {
    requests++; return Response.json({ signed_url: "https://attacker.invalid/a", expires_at: Date.now() / 1000 + 60 });
  }) as typeof fetch });
  await assert.rejects(source.read("manifest.json"), /Untrusted/);
  assert.equal(requests, 1);
  assert.throws(() => createSignedPackageSource({ ...options, artifactEndpoint: "https://attacker.invalid/api/v1/view/a/artifact/" }));
});
test("shared directory adapter is lazy and uses one scoped source for nested files", async () => {
  const reads: string[] = [];
  const directory = sourceDirectory({ baseUrl: null, async read(path) { reads.push(path); return new TextEncoder().encode(path).buffer; } }, "Test package");
  const nested = await directory.getDirectoryHandle("geometry");
  const file = await nested.getFileHandle("sections.geojson");
  assert.equal(reads.length, 0);
  assert.equal(await (await file.getFile()).text(), "geometry/sections.geojson");
  assert.deepEqual(reads, ["geometry/sections.geojson"]);
  await assert.rejects(directory.getDirectoryHandle(".."));
});
test("abort signal is propagated to both request hops", async () => {
  const controller = new AbortController();
  const source = createSignedPackageSource({ ...options, signal: controller.signal, fetch: (async (_url, init) => {
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  }) as typeof fetch });
  await assert.rejects(source.read("manifest.json"), /Aborted/);
});
