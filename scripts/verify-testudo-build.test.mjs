import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTestudoBuildManifest } from "./verify-testudo-build.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const expectedOrigins = "https://app.testudo.live,https://www.testudo.live";
const expectedByteOrigins = "https://bytes.testudo.live";
const revision = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), "geolibre-testudo-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  mkdirSync(join(root, "packages", "embed", "src"), { recursive: true });
  const sourcePath = "packages/embed/src/index.ts";
  const source = "export const embed = true;\n";
  writeFileSync(join(root, sourcePath), source);
  const lockValues = {
    "package-lock.json": "npm-lock\n",
    "pnpm-lock.yaml": "pnpm-lock\n",
  };
  for (const [path, value] of Object.entries(lockValues)) writeFileSync(join(root, path), value);
  const files = { "index.html": "<!doctype html>\n", "embed-client.js": "export {};\n" };
  for (const [path, value] of Object.entries(files)) writeFileSync(join(artifactDir, path), value);
  const manifest = {
    schemaVersion: 1,
    revision,
    trackedPatchSha256: hash(""),
    sourceHashes: { [sourcePath]: hash(source) },
    dependencyLocks: Object.fromEntries(Object.entries(lockValues).map(([path, value]) => [path, hash(value)])),
    tooling: { typescript: "7.0.2", vite: "7.0.0", esbuild: "0.25.0" },
    node: "v24.18.0",
    base: "/geolibre-native/",
    origins: expectedOrigins,
    byteOrigins: expectedByteOrigins,
    command: "node scripts/build-testudo.mjs",
    files: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, hash(value)])),
  };
  writeFileSync(join(artifactDir, "testudo-build-manifest.json"), JSON.stringify(manifest));
  const options = {
    artifactDir,
    repoRoot: root,
    expectedRevision: revision,
    expectedOrigins,
    expectedByteOrigins,
    sourceFiles: [sourcePath],
    trackedPatch: "",
  };
  return { artifactDir, options };
}

test("accepts a complete native artifact with matching source, lock, and output hashes", t => {
  const { options } = fixture(t);
  assert.deepEqual(verifyTestudoBuildManifest(options), {
    revision,
    sourceCount: 1,
    artifactFileCount: 2,
  });
});

test("rejects a changed emitted artifact file", t => {
  const { artifactDir, options } = fixture(t);
  writeFileSync(join(artifactDir, "index.html"), "modified\n");
  assert.throws(() => verifyTestudoBuildManifest(options), /Artifact hash mismatch/);
});

test("rejects an incomplete source list and a changed dependency lock", t => {
  const { options } = fixture(t);
  assert.throws(() => verifyTestudoBuildManifest({ ...options, sourceFiles: [] }), /source file list/);
  writeFileSync(join(options.repoRoot, "pnpm-lock.yaml"), "changed\n");
  assert.throws(() => verifyTestudoBuildManifest(options), /Dependency lock hash mismatch/);
});

test("rejects a manifest built for a different origin allowlist", t => {
  const { options } = fixture(t);
  assert.throws(() => verifyTestudoBuildManifest({ ...options, expectedOrigins: "https://unapproved.example" }), /Embed origins/);
});
