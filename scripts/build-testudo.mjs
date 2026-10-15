// Reproducible native Testudo artifact; never stages into a developer-specific repository.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/geolibre-desktop");
const outputArg = process.argv.findIndex(value => value === "--out-dir");
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error("--out-dir requires a path");
const output = outputArg >= 0 ? resolve(process.argv[outputArg + 1]) : join(app, "dist-testudo");
const auditArg = process.argv.findIndex(value => value === "--audit-manifest");
if (auditArg >= 0 && !process.argv[auditArg + 1]) throw new Error("--audit-manifest requires a path");
const auditManifestPath = auditArg >= 0 ? resolve(process.argv[auditArg + 1]) : null;
const outputPrefix = output.endsWith(sep) ? output : output + sep;
if (auditManifestPath && (auditManifestPath === output || auditManifestPath.startsWith(outputPrefix))) {
  throw new Error("--audit-manifest must be outside the native artifact directory");
}
const require = createRequire(join(app, "package.json"));
const origins = process.env.VITE_GEOLIBRE_EMBED_ORIGINS;
const bytes = process.env.VITE_TESTUDO_BYTE_ORIGINS;
if (!origins || !bytes || origins.includes("*") || bytes.includes("*")) throw new Error("Set explicit VITE_GEOLIBRE_EMBED_ORIGINS and VITE_TESTUDO_BYTE_ORIGINS.");
for (const value of (origins + "," + bytes).split(/[\s,]+/)) {
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Origins must be exact HTTPS origins (localhost allowed).");
}
const pinnedParquet = {
  wasm_eh: "4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95",
  wasm_mvp: "b64c255a7f7d06cc234535b2f0ecab345fda91bffff5509d3179004bc13aa19a",
};
for (const [target, expected] of Object.entries(pinnedParquet)) {
  const binary = readFileSync(join(app, "public/duckdb-extensions/v1.5.4", target, "parquet.duckdb_extension.wasm"));
  if (createHash("sha256").update(binary).digest("hex") !== expected) throw new Error(`Pinned ${target} Parquet extension checksum mismatch`);
  const engine = readFileSync(require.resolve(`@duckdb/duckdb-wasm/dist/${target === "wasm_eh" ? "duckdb-eh.wasm" : "duckdb-mvp.wasm"}`));
  if (!engine.includes(Buffer.from("v1.5.4"))) throw new Error(`DuckDB ${target} engine does not match pinned Parquet extension`);
}
const env = { ...process.env, GEOLIBRE_APP_BASE: "/geolibre-native/", GEOLIBRE_EMBED: "1", VITE_WELCOME_DISABLED: "1" };
if (auditManifestPath) env.GEOLIBRE_AUDIT_MODULE_MANIFEST = "1";
const run = (file, args, cwd = root) => {
  const result = spawnSync(process.execPath, [file, ...args], { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Build command failed: ${file} (${result.status})`);
};
const git = args => {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot record native source provenance");
  return result.stdout;
};
// Aimsun Analyse drop-ins (Testudo "Analyse" bridge). Vite discovers public/plugins/<id>/plugin.json at build
// time, so the three bundles must exist before `vite build`. They are committed; a missing one is rebuilt from
// extensions/aimsun-validation, and --rebuild-plugins forces all three (the output can differ byte-wise from the
// committed bundle when the local esbuild differs from the one that produced it).
const analysisPluginIds = ["modelling-count-manager", "modelling-od-trips", "modelling-journey-time"];
const pluginsPublic = join(app, "public/plugins");
const rebuildPlugins = process.argv.includes("--rebuild-plugins");
const analysisPlugins = {};
for (const id of analysisPluginIds) {
  const manifestFile = join(pluginsPublic, id, "plugin.json");
  const entryFile = join(pluginsPublic, id, "dist/index.js");
  if (rebuildPlugins || !existsSync(manifestFile) || !existsSync(entryFile)) {
    const pluginDir = join(root, "extensions/aimsun-validation", id);
    run(join(pluginDir, "build.mjs"), [], pluginDir);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.id !== id || !existsSync(join(pluginsPublic, id, manifest.entry))) throw new Error(`Bundled Analyse plugin ${id} is missing or inconsistent in ${pluginsPublic}`);
  analysisPlugins[id] = { version: manifest.version, entrySha256: createHash("sha256").update(readFileSync(join(pluginsPublic, id, manifest.entry))).digest("hex") };
}
// The plugins fetch the DuckDB engine from <app>/plugins/_shared/duckdb/duckdb-eh.wasm and only fall back to
// jsDelivr. The wasm is generated (git-ignored, ~36 MB): provision it from the installed, already-pinned
// @duckdb/duckdb-wasm so an offline Testudo build never needs the CDN, and verify the copy byte for byte.
const { copyDuckDbWasm } = await import(pathToFileURL(join(root, "extensions/aimsun-validation/_shared/scripts/build-lib.mjs")).href);
const provisionedWasm = await copyDuckDbWasm(pluginsPublic);
const sha256File = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const duckdbEhWasmSha256 = sha256File(provisionedWasm);
if (duckdbEhWasmSha256 !== sha256File(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"))) throw new Error("Provisioned plugins/_shared/duckdb/duckdb-eh.wasm does not match the installed DuckDB engine");
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
run(tsc, ["-p", "packages/embed/tsconfig.build.json"]);
run(tsc, ["-b", "apps/geolibre-desktop"]);
run(join(dirname(require.resolve("vite/package.json")), "bin/vite.js"), ["build", "--outDir", output, "--emptyOutDir"], app);
let viewerAuditManifest;
if (auditManifestPath) {
  const viewerManifestPath = join(output, "geolibre-audit-module-manifest.json");
  viewerAuditManifest = JSON.parse(readFileSync(viewerManifestPath, "utf8"));
  rmSync(viewerManifestPath);
  if (viewerAuditManifest.commit !== git(["rev-parse", "HEAD"]).trim()) {
    throw new Error("Native viewer audit manifest does not match the checked-out commit");
  }
}
const embedBuild = require("esbuild").buildSync({ entryPoints: [join(root, "packages/embed/src/index.ts")], outfile: join(output, "embed-client.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", metafile: !!auditManifestPath });
if (auditManifestPath) {
  const embedOutput = Object.entries(embedBuild.metafile.outputs).find(([file]) => file.endsWith("embed-client.js"))?.[1];
  if (!embedOutput || !embedOutput.inputs) throw new Error("Cannot verify the esbuild embed-client module graph");
  const embedModules = Object.entries(embedOutput.inputs)
    .filter(([, details]) => details.bytesInOutput > 0)
    .map(([input]) => resolve(root, input))
    .sort();
  if (embedModules.length === 0) throw new Error("The esbuild embed-client module graph is empty");
  mkdirSync(dirname(auditManifestPath), { recursive: true });
  writeFileSync(auditManifestPath, JSON.stringify({
    schemaVersion: 2,
    commit: viewerAuditManifest.commit,
    artifacts: {
      viewer: { chunks: viewerAuditManifest.chunks, modules: viewerAuditManifest.modules },
      embedClient: { chunks: ["embed-client.js"], modules: embedModules },
    },
  }, null, 2) + "\n");
}
copyFileSync(join(root, "LICENSE"), join(output, "GEOLIBRE-LICENSE.txt"));
const hash = value => createHash("sha256").update(value).digest("hex");
const files = {};
const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); if (entry.isDirectory()) walk(full); else files[relative(output, full).replaceAll("\\", "/")] = hash(readFileSync(full)); } };
walk(output);
const sourceFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "apps/geolibre-desktop/src", "apps/geolibre-desktop/public/duckdb-extensions", "packages/embed/src", "packages/plugins/src", "apps/geolibre-desktop/public/plugins", "extensions/aimsun-validation", "scripts/build-testudo.mjs", "apps/geolibre-desktop/vite.config.ts"]).trim().split(/\r?\n/).sort();
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(join(root, path)))]));
const dependencyLocks = Object.fromEntries(["package-lock.json", "pnpm-lock.yaml"].map(file => [file, hash(readFileSync(join(root, file)))]));
const tooling = Object.fromEntries(["typescript", "vite", "esbuild"].map(name => [name, JSON.parse(readFileSync(require.resolve(name + "/package.json"), "utf8")).version]));
writeFileSync(join(output, "testudo-build-manifest.json"), JSON.stringify({ schemaVersion: 1, revision: git(["rev-parse", "HEAD"]).trim(), trackedPatchSha256: hash(git(["diff", "--", "apps", "packages", "scripts"])), sourceHashes, dependencyLocks, tooling, analysis: { plugins: analysisPlugins, duckdbEhWasmSha256 }, node: process.version, base: env.GEOLIBRE_APP_BASE, origins, byteOrigins: bytes, command: "node scripts/build-testudo.mjs", files }, null, 2) + "\n");
process.stdout.write(`Testudo native artifact: ${output}\n`);
