// P2: the OD manifest reader uses the shared resolveInsidePackage (encoded dot segments, backslashes, UNC, run names).
import test from "node:test";
import assert from "node:assert/strict";
import { isSafeRelativePath, itemsFromManifest, resolveUrl } from "../../_od/source.ts";

const M = "https://host.example/data/manifest.json";
const never = async () => false;

const UNSAFE = ["../x/od_before.parquet", "%2e%2e/A/od_before.parquet", "%2E%2E%2FA/od_before.parquet", "A/%2e%2e/%2e%2e/od_before.parquet", "%252e%252e/A/od_before.parquet", "..\\A\\od_before.parquet", "\\\\srv\\share\\od_before.parquet", "//evil.example/A/od_before.parquet", "/etc/od_before.parquet", "https://evil.example/A/od_before.parquet", "C:/A/od_before.parquet"];

test("itemsFromManifest rejects encoded / backslash / UNC / absolute paths in files, outputs and outputs_sha256", async () => {
  for (const p of UNSAFE) {
    await assert.rejects(itemsFromManifest(M, { schema_version: 1, files: [{ path: p }] }, never), /path|unsafe/, `files: ${p}`);
    await assert.rejects(itemsFromManifest(M, { schema_version: 1, outputs: { [p]: { sha256: "a" } } }, never), /unsafe/, `outputs: ${p}`);
    await assert.rejects(itemsFromManifest(M, { schema_version: 1, outputs_sha256: { [p]: "a" } }, never), /unsafe/, `outputs_sha256: ${p}`);
  }
});

test("run names from the manifest cannot steer the convention probe out of the package", async () => {
  for (const run of ["..", "%2e%2e", "a/../..", "x\\y", "//evil.example"]) {
    await assert.rejects(itemsFromManifest(M, { schema_version: 1, run }, never), /unsafe run name/, run);
    await assert.rejects(itemsFromManifest(M, { schema_version: 1, runs: [{ run, available: true }] }, never), /unsafe run name/, run);
  }
  const probed: string[] = [];
  const { items } = await itemsFromManifest(M, { schema_version: 1, runs: [{ run: "AMPK_3" }] }, async (u) => (probed.push(u), u.endsWith("AMPK_3/od_before.parquet")));
  assert.ok(probed.every((u) => u.startsWith("https://host.example/data/")));
  assert.ok(items.some((i) => i.src.url === "https://host.example/data/AMPK_3/od_before.parquet"));
});

test("resolveUrl / isSafeRelativePath keep inside the manifest directory", () => {
  assert.equal(resolveUrl(M, "AMPK_3/od_before.parquet"), "https://host.example/data/AMPK_3/od_before.parquet");
  for (const p of UNSAFE) {
    assert.equal(isSafeRelativePath(p), false, p);
    assert.throws(() => resolveUrl(M, p));
  }
});
