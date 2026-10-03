// Validate the provenance manifest emitted by build-testudo.mjs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfiles = ["package-lock.json", "pnpm-lock.yaml"];
const sourceScopes = [
  "apps/geolibre-desktop/src",
  "apps/geolibre-desktop/public/duckdb-extensions",
  "packages/embed/src",
  "packages/plugins/src",
  "scripts/build-testudo.mjs",
  "apps/geolibre-desktop/vite.config.ts",
];

const sha256 = value => createHash("sha256").update(value).digest("hex");
const isSha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function git(args) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout;
}

function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) {
    throw new Error(`Invalid manifest path: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid manifest path: ${value}`);
  }
  return value;
}

function walkFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in artifact: ${path}`);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
  return files.sort();
}

export function verifyTestudoBuildManifest({
  artifactDir,
  repoRoot,
  expectedRevision,
  expectedOrigins,
  expectedByteOrigins,
  sourceFiles,
  trackedPatch,
}) {
  const artifactRoot = resolve(artifactDir);
  const repositoryRoot = resolve(repoRoot);
  const manifestPath = join(artifactRoot, "testudo-build-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  if (manifest.revision !== expectedRevision) throw new Error(`Manifest revision ${manifest.revision} does not match ${expectedRevision}`);
  if (manifest.base !== "/geolibre-native/") throw new Error(`Unexpected native base: ${manifest.base}`);
  if (manifest.command !== "node scripts/build-testudo.mjs") throw new Error(`Unexpected build command: ${manifest.command}`);
  if (manifest.origins !== expectedOrigins) throw new Error("Embed origins do not match the CI allowlist");
  if (manifest.byteOrigins !== expectedByteOrigins) throw new Error("Byte origins do not match the CI allowlist");
  if (!isSha256(manifest.trackedPatchSha256) || manifest.trackedPatchSha256 !== sha256(trackedPatch)) {
    throw new Error("Tracked source patch hash does not match the checked-out source");
  }
  const nodeVersion = typeof manifest.node === "string" && /^v(\d+)\.\d+\.\d+$/.exec(manifest.node);
  if (!nodeVersion || Number(nodeVersion[1]) < 22) throw new Error(`Unsupported Node version: ${manifest.node}`);
  for (const tool of ["typescript", "vite", "esbuild"]) {
    if (typeof manifest.tooling?.[tool] !== "string" || !manifest.tooling[tool]) throw new Error(`Missing ${tool} version in manifest`);
  }

  const currentSources = [...sourceFiles].map(safePath).sort();
  const recordedSources = Object.keys(manifest.sourceHashes ?? {}).map(safePath).sort();
  if (JSON.stringify(recordedSources) !== JSON.stringify(currentSources)) {
    throw new Error("Manifest source file list does not match the checked-out Testudo build sources");
  }
  for (const path of currentSources) {
    const digest = manifest.sourceHashes[path];
    if (!isSha256(digest)) throw new Error(`Invalid source hash for ${path}`);
    if (sha256(readFileSync(join(repositoryRoot, ...path.split("/")))) !== digest) {
      throw new Error(`Source hash mismatch: ${path}`);
    }
  }

  const recordedLocks = manifest.dependencyLocks ?? {};
  if (JSON.stringify(Object.keys(recordedLocks).sort()) !== JSON.stringify(lockfiles)) {
    throw new Error("Manifest must record both npm and pnpm lockfiles");
  }
  for (const path of lockfiles) {
    const digest = recordedLocks[path];
    if (!isSha256(digest) || sha256(readFileSync(join(repositoryRoot, path))) !== digest) {
      throw new Error(`Dependency lock hash mismatch: ${path}`);
    }
  }

  const recordedFiles = manifest.files ?? {};
  const recordedFileNames = Object.keys(recordedFiles).map(safePath).sort();
  const actualFileNames = walkFiles(artifactRoot).filter(path => path !== "testudo-build-manifest.json");
  if (JSON.stringify(recordedFileNames) !== JSON.stringify(actualFileNames)) {
    throw new Error("Manifest artifact file list does not match the emitted artifact");
  }
  for (const path of actualFileNames) {
    const digest = recordedFiles[path];
    if (!isSha256(digest) || sha256(readFileSync(join(artifactRoot, ...path.split("/")))) !== digest) {
      throw new Error(`Artifact hash mismatch: ${path}`);
    }
  }

  return { revision: manifest.revision, sourceCount: currentSources.length, artifactFileCount: actualFileNames.length };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Usage: node scripts/verify-testudo-build.mjs --artifact <dir> --revision <sha> --embed-origins <origins> --byte-origins <origins>`);
  return process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sourceOutput = git(["ls-files", "--cached", "--others", "--exclude-standard", ...sourceScopes]);
    const sourceFiles = sourceOutput.trim().split(/\r?\n/).filter(Boolean);
    const result = verifyTestudoBuildManifest({
      artifactDir: argument("--artifact"),
      repoRoot: root,
      expectedRevision: argument("--revision"),
      expectedOrigins: argument("--embed-origins"),
      expectedByteOrigins: argument("--byte-origins"),
      sourceFiles,
      trackedPatch: git(["diff", "--", "apps", "packages", "scripts"]),
    });
    process.stdout.write(`Verified Testudo native artifact for ${result.revision}: ${result.sourceCount} sources, ${result.artifactFileCount} files\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
