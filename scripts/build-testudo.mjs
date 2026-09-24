// Reproducible native Testudo artifact; never stages into a developer-specific repository.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/geolibre-desktop");
const output = join(app, "dist-testudo");
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
  const engine = readFileSync(join(app, "node_modules/@duckdb/duckdb-wasm/dist", target === "wasm_eh" ? "duckdb-eh.wasm" : "duckdb-mvp.wasm"));
  if (!engine.includes(Buffer.from("v1.5.4"))) throw new Error(`DuckDB ${target} engine does not match pinned Parquet extension`);
}
const env = { ...process.env, GEOLIBRE_APP_BASE: "/geolibre-native/", GEOLIBRE_EMBED: "1", VITE_WELCOME_DISABLED: "1" };
const run = (file, args, cwd = root) => {
  const result = spawnSync(process.execPath, [file, ...args], { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Build command failed: ${file} (${result.status})`);
};
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
run(tsc, ["-p", "packages/embed/tsconfig.build.json"]);
run(tsc, ["-b", "apps/geolibre-desktop"]);
run(join(dirname(require.resolve("vite/package.json")), "bin/vite.js"), ["build", "--outDir", "dist-testudo"], app);
require("esbuild").buildSync({ entryPoints: [join(root, "packages/embed/src/index.ts")], outfile: join(output, "embed-client.js"), bundle: true, format: "esm", platform: "browser", target: "es2022" });
copyFileSync(join(root, "LICENSE"), join(output, "GEOLIBRE-LICENSE.txt"));
const hash = value => createHash("sha256").update(value).digest("hex");
const git = args => {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot record native source provenance");
  return result.stdout;
};
const files = {};
const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); if (entry.isDirectory()) walk(full); else files[relative(output, full).replaceAll("\\", "/")] = hash(readFileSync(full)); } };
walk(output);
const sourceFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "apps/geolibre-desktop/src", "apps/geolibre-desktop/public/duckdb-extensions", "packages/embed/src", "packages/plugins/src", "scripts/build-testudo.mjs", "apps/geolibre-desktop/vite.config.ts"]).trim().split(/\r?\n/).sort();
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(join(root, path)))]));
const dependencyLocks = Object.fromEntries(["package-lock.json", "pnpm-lock.yaml"].map(file => [file, hash(readFileSync(join(root, file)))]));
const tooling = Object.fromEntries(["typescript", "vite", "esbuild"].map(name => [name, JSON.parse(readFileSync(require.resolve(name + "/package.json"), "utf8")).version]));
writeFileSync(join(output, "testudo-build-manifest.json"), JSON.stringify({ schemaVersion: 1, revision: git(["rev-parse", "HEAD"]).trim(), trackedPatchSha256: hash(git(["diff", "--", "apps", "packages", "scripts"])), sourceHashes, dependencyLocks, tooling, node: process.version, base: env.GEOLIBRE_APP_BASE, origins, byteOrigins: bytes, command: "node scripts/build-testudo.mjs", files }, null, 2) + "\n");
process.stdout.write(`Testudo native artifact: ${output}\n`);
