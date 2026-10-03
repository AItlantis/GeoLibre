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
  const manifestPath = root.endsWith(".json")
    ? root
    : path.join(root, "geolibre-audit-module-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`missing or unreadable emitted module manifest: ${error.message}`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    ![1, 2].includes(manifest.schemaVersion) ||
    typeof manifest.commit !== "string" ||
    (manifest.schemaVersion === 1 &&
      (!Array.isArray(manifest.modules) || manifest.modules.length === 0 ||
        !Array.isArray(manifest.chunks) || manifest.chunks.length === 0)) ||
    (manifest.schemaVersion === 2 &&
      (manifest.artifacts === null || typeof manifest.artifacts !== "object" ||
        Object.keys(manifest.artifacts).length === 0))
  ) {
    throw new Error("emitted module manifest is incomplete");
  }

  const artifacts = manifest.schemaVersion === 1
    ? { viewer: { modules: manifest.modules, chunks: manifest.chunks } }
    : manifest.artifacts;
  if (
    manifest.schemaVersion === 2 &&
    (Object.keys(artifacts).length !== 2 ||
      !Object.hasOwn(artifacts, "viewer") ||
      !Object.hasOwn(artifacts, "embedClient"))
  ) {
    throw new Error("emitted module manifest must prove both viewer and embedClient artifacts");
  }
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (
      artifact === null || typeof artifact !== "object" ||
      !Array.isArray(artifact.modules) || artifact.modules.length === 0 ||
      !Array.isArray(artifact.chunks) || artifact.chunks.length === 0
    ) {
      throw new Error(`emitted module manifest has an incomplete ${name} artifact`);
    }
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

  for (const [artifactName, artifact] of Object.entries(artifacts)) {
    const normalizedModules = artifact.modules.map((source) => source.replaceAll("\\", "/"));
    for (const advisory of advisories) {
      const pattern = packageSource(advisory.packageName);
      const matches = normalizedModules.filter((source) => pattern.test(source));
      if (matches.length > 0) {
        throw new Error(
          `${advisory.id} is allowlisted, but ${advisory.packageName} appears in the exact-head ${artifactName} artifact: ${matches.join(", ")}`,
        );
      }
    }
  }

  const sha256 = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  const chunkCount = Object.values(artifacts).reduce((total, artifact) => total + artifact.chunks.length, 0);
  const moduleCount = Object.values(artifacts).reduce((total, artifact) => total + artifact.modules.length, 0);
  return {
    message: `Exact-head emitted-artifact proof: commit ${manifest.commit}; artifacts ${Object.keys(artifacts).join(", ")}; ${chunkCount} chunks; ${moduleCount} module references; manifest sha256 ${sha256}; no allowlisted package source found.`,
    commit: manifest.commit,
    artifacts: Object.keys(artifacts),
    chunks: chunkCount,
    modules: moduleCount,
    sha256,
  };
}
