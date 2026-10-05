import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const artifactDir = process.env.TESTUDO_LONDON_ARTIFACT_DIR;
if (!artifactDir) throw new Error("Set TESTUDO_LONDON_ARTIFACT_DIR to the retained London artifact directory.");
const root = resolve(artifactDir);
const sums = JSON.parse((await readFile(join(root, "SHA256SUMS.json"), "utf8")).replace(/^\uFEFF/, ""));
assert.ok(Array.isArray(sums), "SHA256SUMS.json must be an array.");
const expected = new Map(sums.map((item) => [item.path, item]));
const verified = [];
const verify = async (path) => {
  const record = expected.get(path);
  assert.ok(record, `SHA256SUMS.json has no entry for ${path}.`);
  const bytes = await readFile(join(root, path));
  assert.equal(bytes.byteLength, record.bytes, `${path} size differs from SHA256SUMS.json.`);
  const digest = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  assert.equal(digest, record.sha256.toUpperCase(), `${path} hash differs from SHA256SUMS.json.`);
  verified.push({ path, bytes: bytes.byteLength, sha256: digest });
  return bytes;
};

const manifest = JSON.parse(await verify("manifest.json"));
const native = JSON.parse(await verify("geolibre-package.json"));
assert.equal(native.schemaVersion, "geolibre.package.v1");
assert.equal(native.capabilities?.animation?.state, "available");
assert.ok(Array.isArray(native.scenarios) && native.scenarios.length > 0);
assert.ok(Array.isArray(manifest.chunks) && manifest.chunks.length > 0);
for (const chunk of manifest.chunks) {
  assert.equal(typeof chunk.path, "string");
  await verify(chunk.path);
}

console.log(JSON.stringify({ ok: true, artifact: root, scenarios: native.scenarios.length, chunks: manifest.chunks.length, verified }, null, 2));
