// Build the GeoLibre web app for embedding (Jupyter widget / standalone HTML)
// and stage it into the Python package.
//
// The embed build differs from the normal web build in two load-bearing ways:
//  1. `GEOLIBRE_APP_BASE=./` makes every asset, favicon, and bundled-plugin URL
//     in the emitted index.html relative, so the app can load from inside a
//     Python wheel (served from an arbitrary, content-hashed location) instead
//     of the site root.
//  2. `GEOLIBRE_EMBED=1` disables the service worker (a SW is meaningless inside
//     a notebook iframe). PGlite is CDN-loaded here via `GEOLIBRE_PGLITE_CDN=1`,
//     keeping its ~25 MB PostGIS bundle out of the wheel — the web and desktop
//     builds CDN-load it too by default; override with `GEOLIBRE_PGLITE_CDN=0`
//     on any target to force-bundle it for a fully offline build.
//
// Output: apps/geolibre-desktop/dist-embed/ -> copied to
// python/src/geolibre/static/app/.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REMEDIATION, scanForCredentials } from "./scan-credentials.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "apps/geolibre-desktop/dist-embed");
const staticDir = resolve(repoRoot, "python/src/geolibre/static/app");

const embedClientResult = spawnSync("npm", ["run", "build", "-w", "@geolibre/embed"], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (embedClientResult.status !== 0) process.exit(embedClientResult.status ?? 1);

const result = spawnSync(
  "npm",
  ["run", "build", "-w", "geolibre-desktop", "--", "--outDir", "dist-embed"],
  {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    env: {
      ...process.env,
      GEOLIBRE_APP_BASE: "./",
      // CDN-load PGlite (the web build now does this by default too) and mark
      // this as the embed build so the service worker is disabled — a SW is
      // meaningless inside a notebook iframe and could hijack the host scope.
      GEOLIBRE_PGLITE_CDN: "1",
      GEOLIBRE_EMBED: "1",
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Guard the wheel size: GEOLIBRE_PGLITE_CDN should keep the PGlite/PostGIS bundle
// out of the embed build. If the dead-code elimination ever stops working, the
// 19.6 MB postgis.tar (and PGlite wasm/data) would silently re-inflate the wheel.
const assetsDir = resolve(distDir, "assets");
// Matches the content-hashed PGlite assets, e.g. postgis.tar-<hash>.gz,
// pglite-<hash>.wasm, pglite-<hash>.data, initdb-<hash>.wasm. The second arm
// also catches a leaked pglite-<hash>.js chunk: manualChunks() names any
// @electric-sql/pglite import exactly "pglite", so if the loader module-swap
// stops excluding the package, Rollup emits `pglite-<hash>.js` and the wheel
// would regrow even without the WASM/data assets. The JS arm is anchored to
// `pglite-<alnum-hash>.js` so it does not spuriously match a `pglite-loader-*`
// chunk (the `-` in `loader` breaks the `\w+` run) should Rollup ever split the
// statically-imported loader module into its own chunk.
const pgliteAssetRe = /^(?:postgis\.tar|pglite|initdb).*\.(?:gz|wasm|data)$|^pglite-\w+\.js$/;
const leaked = readdirSync(assetsDir).filter((name) => pgliteAssetRe.test(name));
if (leaked.length > 0) {
  console.error(
    "[build-embed] PGlite assets leaked into the embed build despite " +
      `GEOLIBRE_PGLITE_CDN=1: ${leaked.join(", ")}. These should load from a ` +
      "CDN at runtime; check `pgliteCdnLoaderPlugin` in vite.config.ts and the " +
      "pglite-loader.cdn.ts / pglite-loader.ts module pair.",
  );
  process.exit(1);
}

// Guard the one thing that silently breaks the wheel: if the base path was not
// applied, index.html references /assets/... and the iframe loads a blank page.
const indexHtml = readFileSync(resolve(distDir, "index.html"), "utf8");
if (/\b(?:src|href)="\/(?!\/)/.test(indexHtml)) {
  console.error(
    "[build-embed] dist-embed/index.html has absolute asset paths. " +
      "GEOLIBRE_APP_BASE=./ was not applied; the embedded app would 404.",
  );
  process.exit(1);
}

// The wheel is redistributed, so it must carry no credential of ours. Verify the
// output rather than trusting the config, which a hand-run build can satisfy and
// still be wrong. See scripts/scan-credentials.mjs.
const credentialFindings = scanForCredentials(distDir);
if (credentialFindings.length > 0) {
  console.error(
    `[build-embed] Refusing to stage: ${credentialFindings.length} credential(s) in the embed build.\n` +
      credentialFindings.map((f) => `  - ${f}`).join("\n") +
      `\n\n${REMEDIATION}`,
  );
  process.exit(1);
}
console.log("[build-embed] Credential scan clean.");

rmSync(staticDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
cpSync(distDir, staticDir, { recursive: true });

// The Testudo native host consumes a self-contained static tree. Pin and verify
// the two official DuckDB-Wasm Parquet extensions instead of relying on a
// mutable CDN at viewer runtime.
const duckdbExtensions = [
  {
    variant: "wasm_eh",
    sha256: "4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95",
  },
  {
    variant: "wasm_mvp",
    sha256: "b64c255a7f7d06cc234535b2f0ecab345fda91bffff5509d3179004bc13aa19a",
  },
];
const extensionRoot = resolve(staticDir, "duckdb-extensions");
mkdirSync(extensionRoot, { recursive: true });
writeFileSync(resolve(staticDir, "embed-client.js"), readFileSync(resolve(repoRoot, "packages/embed/dist/index.js")));
writeFileSync(resolve(staticDir, "GEOLIBRE-LICENSE.txt"), readFileSync(resolve(repoRoot, "LICENSE")));
writeFileSync(
  resolve(extensionRoot, "LICENSE"),
  "DuckDB and DuckDB-Wasm are distributed under the MIT License. Copyright 2018-2025 Stichting DuckDB Foundation.\n\n" +
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n' +
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n" +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n',
);
for (const extension of duckdbExtensions) {
  const relativePath = `duckdb-extensions/v1.5.4/${extension.variant}/parquet.duckdb_extension.wasm`;
  const destination = resolve(staticDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  const url = `https://extensions.duckdb.org/v1.5.4/${extension.variant}/parquet.duckdb_extension.wasm`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[build-embed] Could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== extension.sha256) {
    throw new Error(`[build-embed] DuckDB extension checksum mismatch for ${url}: ${actualHash}`);
  }
  writeFileSync(destination, bytes);
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`[build-embed] Symlink not allowed in artifact: ${relativePath}`);
      if (entry.isDirectory()) return listFiles(absolutePath, relativePath);
      if (!entry.isFile()) throw new Error(`[build-embed] Unsupported artifact entry: ${relativePath}`);
      const sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
      return [[relativePath, sha256]];
    });
}
const files = Object.fromEntries(listFiles(staticDir));
const requiredFiles = [
  "index.html",
  "embed-client.js",
  "geolibre-runtime-config.js",
  "GEOLIBRE-LICENSE.txt",
  "duckdb-extensions/LICENSE",
  "duckdb-extensions/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm",
  "duckdb-extensions/v1.5.4/wasm_mvp/parquet.duckdb_extension.wasm",
];
for (const requiredFile of requiredFiles) {
  if (!files[requiredFile]) throw new Error(`[build-embed] Required artifact file is missing: ${requiredFile}`);
}
writeFileSync(
  resolve(staticDir, "testudo-build-manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, base: "/geolibre-native/", files }, null, 2)}\n`,
);

console.log(`[build-embed] Staged embed build into ${staticDir}`);
