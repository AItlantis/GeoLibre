import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function packageSource(name) {
  return new RegExp(`(?:^|/)node_modules/(?:\\.pnpm/[^/]+/node_modules/)?${name}(?:/|$)`);
}

/** Verify the Rollup module graph emitted from the current checkout. */
export async function verifyArtifactModuleManifest(distPath, advisories, checkoutCommit) {
  const root = distPath instanceof URL ? fileURLToPath(distPath) : distPath;
  const manifestPath = path.join(root, "geolibre-audit-module-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`missing or unreadable emitted module manifest: ${error.message}`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.commit !== "string" ||
    !Array.isArray(manifest.modules) ||
    manifest.modules.length === 0 ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0
  ) {
    throw new Error("emitted module manifest is incomplete");
  }

  const repoRoot = path.resolve(root, "..", "..", "..");
  let expected = checkoutCommit;
  if (expected === undefined) {
    try {
      expected = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (error) {
      throw new Error(`could not identify the checked-out commit: ${error.message}`);
    }
  }
  if (manifest.commit !== expected) {
    throw new Error(
      `emitted artifact belongs to ${manifest.commit}, but checkout is ${expected}`,
    );
  }

  const normalizedModules = manifest.modules.map((source) =>
    source.replaceAll("\\", "/"),
  );
  for (const advisory of advisories) {
    const pattern = packageSource(advisory.packageName);
    const matches = normalizedModules.filter((source) => pattern.test(source));
    if (matches.length > 0) {
      throw new Error(
        `${advisory.id} is allowlisted, but ${advisory.packageName} appears in the exact-head emitted artifact: ${matches.join(", ")}`,
      );
    }
  }

  const sha256 = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  return {
    message: `Exact-head emitted-artifact proof: commit ${manifest.commit}; ${manifest.chunks.length} chunks; ${manifest.modules.length} module references; manifest sha256 ${sha256}; no allowlisted package source found.`,
    commit: manifest.commit,
    chunks: manifest.chunks.length,
    modules: manifest.modules.length,
    sha256,
  };
}
